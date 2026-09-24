import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { DatabaseQueryable } from '../../database/database-adapter';
import { stableStringify } from '../audit/audit-integrity';
import { EventOutboxService, OutboxEventInput } from '../events/event-outbox.service';
import { EventConsumerRegistry } from '../events/consumer-registry.service';
import { DomainEventEnvelope } from '../events/event-bus';
import { CorrelationService } from '../integrations/correlation.service';
import { StateMappingService } from '../integrations/state-mapping.service';
import { SyncGuardService } from '../integrations/sync-guard.service';
import { SyncIdentity } from '../integrations/sync-guard.types';
import {
  BackfillPage,
  BackfillWindow,
  ConnectorAdapter,
  ConnectorContext,
  ConnectorFetchPage,
  EnqueuedRecordOutcome,
} from './connector.interface';
import {
  ConnectorConfigurationError,
  ConnectorLoadShedError,
  ConnectorCredentialError,
  ConnectorRemoteError,
} from './connector-http';
import { stringList } from './connector-config';
import { JiraConnectorAdapter } from './jira-connector.adapter';
import { ServiceNowConnectorAdapter } from './servicenow-connector.adapter';
import {
  CanonicalTwin,
  ConnectorCapabilityReport,
  ConnectorCommentSyncPolicy,
  ConnectorConfigDto,
  ConnectorDiscoveryResult,
  ConnectorHealth,
  ConnectorLimitation,
  ConnectorProviderDescriptor,
  ConnectorProviderType,
  ConnectorRateGovernanceMetrics,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorWorkOrder,
  ConnectorWorkOrderStatus,
  ConnectorQueueAttempt,
  ConnectorWriteBackPolicy,
  ExternalPublicComment,
  ExternalRecordPayload,
  IngestionPollResult,
  TwinCounterpart,
  TwinDetail,
  TwinEditResult,
  TwinFieldPolicy,
  TwinWorkspaceRow,
  TwinQueueDeadLetter,
  TwinQueueReinjectionResult,
  TwinPublicComment,
  WatermarkCursor,
  WorkspaceOverview,
} from './connector.types';
import { SecretManagerResolver } from './secret-manager-ref';
import { getProviderSandbox } from './sandbox/provider-sandbox';
import { FieldMappingService } from './mapping/field-mapping.service';
import { TwinProjectionConfig, TwinProjectionService } from './twin-projection.service';
import { loadRuntimeConfig } from '../../config/runtime-config';
import { getConnectorRateGovernor, validateRateGovernance } from './rate-governor';
import { validateQueryIndexes } from './native-query/query-index-catalog';

const MAX_WORK_ORDER_ATTEMPTS = 5;
const WORK_ORDER_BASE_BACKOFF_MS = 30_000;
const WORK_ORDER_MAX_BACKOFF_MS = 60 * 60_000;
const SYNC_LEASE_MS = 5 * 60_000;
const WORK_ORDER_CLAIM_MS = 2 * 60_000;
const CONNECTOR_PROPAGATION_CONSUMER = 'connector-state-propagation';
const SECRET_LIKE_OPTION = /(token|password|secret|apikey|api_key|credential)/i;

type RecordOutcome = 'created' | 'updated' | 'unchanged';

interface PollCounters {
  twinsCreated: number;
  twinsUpdated: number;
  twinsUnchanged: number;
  echoesSuppressed: number;
  workOrdersPrepared: number;
  workOrdersHeld: number;
  workOrdersExecuted: number;
  workOrdersFailed: number;
  commentsFetched: number;
  commentsStored: number;
  commentsFiltered: number;
  commentsTransferred: number;
  commentsFailed: number;
}

/**
 * Connector-led ingestion (US17.1).
 *
 * Externally owned records are materialized as canonical twins keyed by their immutable
 * provider id and linked to a US13.2 correlation node. When a twin's native state changes, the
 * change is screened by US13.3 echo suppression and translated through the published US13.1
 * mapping for every managed counterpart; ready translations become idempotent connector work
 * orders that the counterpart's adapter executes, with bounded retry.
 *
 * Synchronization uses an expiring database lease, while state changes are accepted through the
 * transactional outbox and materialized as durable, twin-partitioned work orders.
 */
@Injectable()
export class ConnectorService implements OnApplicationBootstrap {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private correlationService = new CorrelationService();
  private stateMappingService = new StateMappingService();
  private fieldMappingService = new FieldMappingService();
  private syncGuardService = new SyncGuardService();
  private secrets = new SecretManagerResolver();
  private projection = new TwinProjectionService();
  private rateGovernor = getConnectorRateGovernor();
  private adapters = new Map<ConnectorProviderType, ConnectorAdapter>();
  private readonly workerId = randomUUID();

  constructor() {
    // The sandbox is a local-only demonstration transport; runtime config refuses it elsewhere.
    const transport = loadRuntimeConfig().connectorSandbox ? getProviderSandbox().fetch : undefined;
    this.registerAdapter(new JiraConnectorAdapter(transport));
    this.registerAdapter(new ServiceNowConnectorAdapter(transport));
    new EventConsumerRegistry().register({
      name: CONNECTOR_PROPAGATION_CONSUMER,
      eventTypes: ['CanonicalTwinMaterialized', 'CanonicalTwinUpdated', 'ConnectorOperatorStateWritten'],
      maxAttempts: 3,
      retryDelayMs: 5,
      handle: (event) => this.acceptPropagationEvent(event),
    });
  }

  public async onApplicationBootstrap(): Promise<void> {
    await this.dbService.initialize();
    const configured = await this.dbService.db.query<any>(`SELECT * FROM integration_connectors`);
    for (const row of configured.rows) {
      // Legacy/validate-only connector rows may not have a runnable HTTP target; they do not
      // participate in native-provider rate governance and must not block application startup.
      try {
        await this.rateGovernor.registerPolicy(this.mapConnector(row));
      } catch (error) {
        if (!(error instanceof ConnectorConfigurationError)) throw error;
      }
    }
    await this.dbService.db.query(
      `UPDATE integration_connector_work_orders
       SET status = 'failed', claimed_by = NULL, claim_expires_at = NULL,
           next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE status = 'processing'
         AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)`,
    );
    await this.dbService.db.query(
      `UPDATE integration_connector_ingestion_queue
       SET status = 'retry', claimed_by = NULL, claim_expires_at = NULL,
           next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE status = 'processing'
         AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)`,
    );
    await this.outbox.recoverPending();
  }

  public registerAdapter(adapter: ConnectorAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  public setSecretResolver(resolver: SecretManagerResolver): void {
    this.secrets = resolver;
  }

  public listProviders(): ConnectorProviderDescriptor[] {
    return Array.from(this.adapters.values()).map((adapter) => adapter.descriptor);
  }

  public getAdapter(provider: ConnectorProviderType): ConnectorAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      const available = Array.from(this.adapters.keys()).join(', ');
      throw new BadRequestException(`Connector provider '${provider}' is not available. Available providers: ${available}`);
    }
    return adapter;
  }

  // ─── Registration and lifecycle ────────────────────────────────────────────

  public async createConnector(orgId: string, dto: ConnectorConfigDto, actorId = 'system'): Promise<ConnectorRecord> {
    await this.dbService.initialize();
    const name = typeof dto?.name === 'string' ? dto.name.trim() : '';
    if (!name) throw new BadRequestException('Connector name is required');
    if (name.length > 160) throw new BadRequestException('Connector name must be 160 characters or fewer');
    if (!dto.provider) throw new BadRequestException('Connector provider is required');
    const adapter = this.getAdapter(dto.provider);

    const config = this.guard(() => ({
      baseUrl: typeof dto.baseUrl === 'string' ? dto.baseUrl.trim() : undefined,
      authType: dto.authType || 'basic',
      credentials: SecretManagerResolver.validateReferences(dto.credentials),
      options: this.validateOptions(dto.options),
      projectKeys: dto.projectKeys === undefined ? undefined : stringList(dto.projectKeys).map((key) => key.toUpperCase()),
      tableNames: dto.tableNames === undefined ? undefined : stringList(dto.tableNames).map((table) => table.toLowerCase()),
      requiredFields: this.validateRequiredFields(dto.requiredFields),
      writeBack: this.validateWriteBack(dto.writeBack),
      commentSync: this.validateCommentSync(dto.commentSync),
      rateGovernance: validateRateGovernance(dto.rateGovernance),
      queryIndexes: validateQueryIndexes(dto.queryIndexes),
      projection: TwinProjectionService.validateConfig(dto.projection),
    }));
    this.guard(() => adapter.validateConfig(config));
    this.guard(() => this.assertQueryIndexEntities(adapter.entityTypes(config), config.queryIndexes));

    const duplicate = await this.dbService.db.query<any>(
      `SELECT id FROM integration_connectors WHERE org_id = $1 AND provider = $2 AND name = $3`,
      [orgId, dto.provider, name],
    );
    if (duplicate.rows.length) throw new ConflictException(`A ${dto.provider} connector named '${name}' already exists`);

    const connectorId = randomUUID();
    let connector!: ConnectorRecord;
    await this.withEvent(async (tx) => {
      const inserted = await tx.query<any>(
        `INSERT INTO integration_connectors
         (id, org_id, provider, name, status, config, discovery_metadata, sync_lag_seconds, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'unconfigured', $5, '{}', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING *`,
        [connectorId, orgId, dto.provider, name, JSON.stringify(config)],
      );
      connector = this.mapConnector(inserted.rows[0]);
      return this.event(orgId, connectorId, actorId, 'ConnectorRegistered', {
        connector_id: connectorId,
        provider: dto.provider,
        name,
      });
    });
    await this.rateGovernor.registerPolicy(connector);
    return connector;
  }

  public async getConnector(orgId: string, connectorId: string): Promise<ConnectorRecord> {
    await this.dbService.initialize();
    if (!isUuid(connectorId)) throw new NotFoundException(`Connector ${connectorId} not found`);
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_connectors WHERE id = $1 AND org_id = $2`,
      [connectorId, orgId],
    );
    if (result.rows.length === 0) throw new NotFoundException(`Connector ${connectorId} not found`);
    return this.mapConnector(result.rows[0]);
  }

  public async listConnectors(orgId: string): Promise<ConnectorRecord[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_connectors WHERE org_id = $1 ORDER BY name ASC`,
      [orgId],
    );
    return result.rows.map((row) => this.mapConnector(row));
  }

  public async testConnection(
    orgId: string,
    connectorId: string,
  ): Promise<{ success: boolean; status: ConnectorStatus; account?: string; message: string }> {
    const connector = await this.getConnector(orgId, connectorId);
    const adapter = this.getAdapter(connector.provider);
    try {
      const { account } = await adapter.testConnection(this.context(connector));
      const status: ConnectorStatus = connector.status === 'paused'
        ? 'paused'
        : connector.activatedAt
          ? 'active'
          : connector.discoveryMetadata?.capabilityReport ? 'discovered' : 'connected';
      await this.setStatus(orgId, connectorId, status, null);
      return { success: true, status, account, message: `Authenticated as ${account}` };
    } catch (error) {
      const message = this.describe(error, 'Connection test failed');
      await this.setStatus(orgId, connectorId, 'error', message);
      return { success: false, status: 'error', message };
    }
  }

  public async discoverSchema(orgId: string, connectorId: string, actorId = 'system'): Promise<ConnectorDiscoveryResult> {
    const connector = await this.getConnector(orgId, connectorId);
    if (connector.status === 'paused') throw new ConflictException('Resume the connector before rediscovering its schema');
    const adapter = this.getAdapter(connector.provider);
    await this.setStatus(orgId, connectorId, 'discovering', connector.errorMessage || null);

    let discovery: ConnectorDiscoveryResult;
    try {
      discovery = await adapter.discoverSchema(this.context(connector));
    } catch (error) {
      const message = this.describe(error, 'Schema discovery failed');
      await this.setStatus(orgId, connectorId, 'error', message);
      throw this.toHttp(error, `Discovery failed: ${message}`);
    }

    const capabilityReport = this.capabilityReport(adapter, connector.config, discovery);
    discovery.capabilityReport = capabilityReport;
    const status: ConnectorStatus = !connector.activatedAt
      ? 'discovered'
      : capabilityReport.ready ? 'active' : 'degraded';
    const blocking = capabilityReport.limitations.filter((item) => item.severity === 'blocking');
    const message = blocking.length ? `Capability check found ${blocking.length} blocking limitation(s)` : null;

    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors
         SET status = $1, discovery_metadata = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND org_id = $5`,
        [status, JSON.stringify(discovery), message, connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorDiscovered', {
        connector_id: connectorId,
        provider: connector.provider,
        entity_count: discovery.entities.length,
        scopes: discovery.scopes,
        ready: capabilityReport.ready,
        limitations: capabilityReport.limitations,
        discovered_at: discovery.discoveredAt,
      });
    });
    return discovery;
  }

  /** Publishes a discovered connector for synchronization. Refused while blocking limitations exist. */
  public async activate(orgId: string, connectorId: string, actorId = 'system'): Promise<ConnectorRecord> {
    const connector = await this.getConnector(orgId, connectorId);
    const adapter = this.getAdapter(connector.provider);
    const discovery = connector.discoveryMetadata;
    if (!discovery?.capabilityReport) {
      throw new ConflictException('Run discovery before activating the connector');
    }
    const report = this.capabilityReport(adapter, connector.config, discovery);
    if (!report.ready) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: 'Connector cannot be activated until blocking limitations are resolved',
        limitations: report.limitations,
      });
    }
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors
         SET status = 'active', activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
             error_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND org_id = $2`,
        [connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorActivated', {
        connector_id: connectorId,
        provider: connector.provider,
        warnings: report.limitations,
      });
    });
    const updated = await this.getConnector(orgId, connectorId);
    await this.rateGovernor.registerPolicy(updated);
    return updated;
  }

  public async pause(orgId: string, connectorId: string, actorId = 'system'): Promise<ConnectorRecord> {
    const connector = await this.getConnector(orgId, connectorId);
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors SET status = 'paused', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND org_id = $2`,
        [connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorPaused', {
        connector_id: connectorId,
        provider: connector.provider,
      });
    });
    return this.getConnector(orgId, connectorId);
  }

  /** Changes which operator edits may be written back to this source. */
  public async configureWriteBack(
    orgId: string,
    connectorId: string,
    policy: ConnectorWriteBackPolicy,
    actorId = 'system',
  ): Promise<ConnectorRecord> {
    const connector = await this.getConnector(orgId, connectorId);
    const writeBack = this.guard(() => this.validateWriteBack(policy));
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND org_id = $3`,
        [JSON.stringify({ ...connector.config, writeBack }), connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorWriteBackConfigured', {
        connector_id: connectorId,
        provider: connector.provider,
        before: connector.config.writeBack || {},
        after: writeBack,
      });
    });
    return this.getConnector(orgId, connectorId);
  }

  /** Public-comment synchronization is a separate, explicitly opt-in connector policy. */
  public async configureCommentSync(
    orgId: string,
    connectorId: string,
    input: unknown,
    actorId = 'system',
  ): Promise<ConnectorRecord> {
    const connector = await this.getConnector(orgId, connectorId);
    const policy = this.guard(() => this.validateCommentSync(input));
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND org_id = $3`,
        [JSON.stringify({ ...connector.config, commentSync: policy }), connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorCommentSyncConfigured', {
        connector_id: connectorId,
        provider: connector.provider,
        before: connector.config.commentSync || this.validateCommentSync(undefined),
        after: policy,
      });
    });
    return this.getConnector(orgId, connectorId);
  }

  /** Changes the shared request budget applied before any call to this connector's target. */
  public async configureRateGovernance(
    orgId: string,
    connectorId: string,
    input: unknown,
    actorId = 'system',
  ): Promise<ConnectorRecord> {
    const connector = await this.getConnector(orgId, connectorId);
    const policy = this.guard(() => validateRateGovernance(input));
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND org_id = $3`,
        [JSON.stringify({ ...connector.config, rateGovernance: policy }), connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorRateGovernanceConfigured', {
        connector_id: connectorId,
        provider: connector.provider,
        target_origin: this.rateGovernor.describe(connector).targetOrigin,
        before: connector.config.rateGovernance || validateRateGovernance(undefined),
        after: policy,
      });
    });
    const updated = await this.getConnector(orgId, connectorId);
    await this.rateGovernor.registerPolicy(updated);
    return updated;
  }

  /**
   * Records the instance-specific indexes an administrator has confirmed (US16.2). The whole
   * declaration is replaced, so removing a field withdraws Cadena's permission to filter on it;
   * published queries re-check it on their next run.
   */
  public async configureQueryIndexes(
    orgId: string,
    connectorId: string,
    input: unknown,
    actorId = 'system',
  ): Promise<ConnectorRecord> {
    const connector = await this.getConnector(orgId, connectorId);
    const declared = this.guard(() => validateQueryIndexes(input));
    this.guard(() => this.assertQueryIndexEntities(this.getAdapter(connector.provider).entityTypes(connector.config), declared));
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND org_id = $3`,
        [JSON.stringify({ ...connector.config, queryIndexes: declared }), connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorQueryIndexesConfigured', {
        connector_id: connectorId,
        provider: connector.provider,
        before: connector.config.queryIndexes || {},
        after: declared,
      });
    });
    return this.getConnector(orgId, connectorId);
  }

  private assertQueryIndexEntities(entityTypes: string[], declared: Record<string, string[]>): void {
    const unknown = Object.keys(declared).filter((entityType) => !entityTypes.includes(entityType));
    if (unknown.length) {
      throw new ConnectorConfigurationError(
        `queryIndexes names entity types this connector does not synchronize: ${unknown.join(', ')} (available: ${entityTypes.join(', ')})`,
      );
    }
  }

  /**
   * Sets how this connector's twins are projected as WorkItems (owning team, type and owner
   * mapping) and re-projects its existing twins. Source fields stay owned by the provider.
   */
  public async configureProjection(
    orgId: string,
    connectorId: string,
    input: unknown,
    actorId = 'system',
  ): Promise<{ connector: ConnectorRecord; projection: TwinProjectionConfig; twins: Record<string, number> }> {
    const connector = await this.getConnector(orgId, connectorId);
    // A partial update (e.g. only { enabled: false } to pause projection) must not silently drop
    // a previously configured teamId/typeMap/ownerMap; merge onto the connector's current
    // (already-validated) projection config before re-validating the result.
    const merged = { ...(connector.config.projection as Record<string, unknown> | undefined || {}), ...(input && typeof input === 'object' ? input as Record<string, unknown> : {}) };
    const projection = TwinProjectionService.validateConfig(merged);
    if (projection.teamId) {
      const team = await this.dbService.db.query<any>(`SELECT id FROM teams WHERE id = $1 AND org_id = $2`, [projection.teamId, orgId]);
      if (!team.rows.length) throw new BadRequestException('projection.teamId is not a team in this tenant');
    }
    for (const personId of Object.values(projection.ownerMap || {})) {
      const person = await this.dbService.db.query<any>(`SELECT id FROM people WHERE id = $1 AND org_id = $2`, [personId, orgId]);
      if (!person.rows.length) throw new BadRequestException(`projection.ownerMap references unknown person ${personId}`);
    }
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND org_id = $3`,
        [JSON.stringify({ ...connector.config, projection }), connectorId, orgId],
      );
      return this.event(orgId, connectorId, actorId, 'ConnectorProjectionConfigured', {
        connector_id: connectorId,
        before: connector.config.projection || { enabled: true },
        after: projection,
      });
    });
    const twins = await this.projection.projectConnector(orgId, connectorId);
    return { connector: await this.getConnector(orgId, connectorId), projection, twins };
  }

  // ─── Ingestion ─────────────────────────────────────────────────────────────

  public async syncConnector(orgId: string, connectorId: string, actorId = 'system'): Promise<IngestionPollResult> {
    const startTime = Date.now();
    const connector = await this.getConnector(orgId, connectorId);
    if (!connector.activatedAt) throw new ConflictException('Connector must be discovered and activated before it can synchronize');
    if (connector.status === 'paused') throw new ConflictException('Connector is paused');
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    if (!await this.acquireSyncLease(orgId, connectorId, leaseOwner)) {
      throw new ConflictException('A synchronization for this connector is already running');
    }
    const leaseHeartbeat = setInterval(() => {
      void this.renewSyncLease(connectorId, leaseOwner);
    }, Math.floor(SYNC_LEASE_MS / 3));
    leaseHeartbeat.unref?.();

    try {
      const adapter = this.getAdapter(connector.provider);
      let ctx: ConnectorContext;
      try {
        ctx = this.context(connector);
      } catch (error) {
        await this.recordPollFailure(orgId, connectorId, this.describe(error, 'Credential resolution failed'));
        throw this.toHttp(error, 'Credential resolution failed');
      }

      const counters: PollCounters = {
        twinsCreated: 0,
        twinsUpdated: 0,
        twinsUnchanged: 0,
        echoesSuppressed: 0,
        workOrdersPrepared: 0,
        workOrdersHeld: 0,
        workOrdersExecuted: 0,
        workOrdersFailed: 0,
        commentsFetched: 0,
        commentsStored: 0,
        commentsFiltered: 0,
        commentsTransferred: 0,
        commentsFailed: 0,
      };
      // A target shedding load (US16.2) is not sent any work: queued items keep their place and
      // their attempts, and the next sync after the window resumes them.
      let shed: IngestionPollResult['loadShedding'] = await this.sheddingNotice(connector);
      const recordErrors: IngestionPollResult['recordErrors'] = [];
      if (!shed) {
        await this.processDueWorkOrders(orgId, connector, counters);
        await this.processDueCommentDeliveries(orgId, counters);
        await this.processDueIngestionRecords(orgId, connector, counters, recordErrors);
        await this.ensureConnectorCommentDeliveries(orgId, connector.id);
        await this.processDueCommentDeliveries(orgId, counters);
      }
      const nextCursors: WatermarkCursor[] = [];
      let fetchedCount = 0;
      let hasMore = false;
      let oldestPending: number | null = null;

      for (const entityType of shed ? [] : adapter.entityTypes(connector.config)) {
        const stored = await this.dbService.db.query<any>(
          `SELECT cursor_value FROM integration_connector_cursors WHERE connector_id = $1 AND entity_type = $2`,
          [connectorId, entityType],
        );
        const cursor: WatermarkCursor | undefined = stored.rows[0]
          ? { entityType, cursorValue: stored.rows[0].cursor_value }
          : undefined;

        let page;
        try {
          page = await adapter.fetchChanges(ctx, entityType, cursor);
        } catch (error) {
          if (error instanceof ConnectorLoadShedError) {
            shed = { until: error.until.toISOString(), reason: error.message };
            break;
          }
          const message = this.describe(error, 'Change query failed');
          await this.recordPollFailure(orgId, connectorId, `${entityType}: ${message}`);
          throw this.toHttp(error, `Synchronization failed for ${entityType}: ${message}`);
        }
        fetchedCount += page.records.length;

        // Acceptance and cursor advancement are atomic. Processing happens from durable storage,
        // so one malformed record cannot pin the source watermark or make a crash lose the page.
        counters.twinsUnchanged += await this.acceptIngestionPage(
          orgId, connector, entityType, page.records, page.nextCursor.cursorValue,
        );
        nextCursors.push({ entityType, cursorValue: page.nextCursor.cursorValue });
        if (page.hasMore) {
          hasMore = true;
          const pending = Date.parse(page.nextCursor.cursorValue);
          oldestPending = oldestPending === null ? pending : Math.min(oldestPending, pending);
        }
      }

      if (!shed) {
        await this.processDueIngestionRecords(orgId, connector, counters, recordErrors);
        await this.processDueCommentDeliveries(orgId, counters);
      }
      const queued = await this.dbService.db.query<any>(
        `SELECT MIN((payload::jsonb ->> 'updatedAt')::timestamptz) AS oldest,
                COUNT(*) FILTER (WHERE status IN ('retry', 'dead'))::int AS failures,
                MAX(last_error) FILTER (WHERE status IN ('retry', 'dead')) AS last_error
         FROM integration_connector_ingestion_queue
         WHERE org_id = $1 AND connector_id = $2 AND status IN ('pending', 'retry', 'processing', 'dead')`,
        [orgId, connectorId],
      );
      if (queued.rows[0]?.oldest) {
        const pending = Date.parse(String(queued.rows[0].oldest));
        oldestPending = oldestPending === null ? pending : Math.min(oldestPending, pending);
      }

      const now = Date.now();
      const lagSeconds = oldestPending === null ? 0 : Math.max(0, Math.round((now - oldestPending) / 1000));
      const queuedFailures = Number(queued.rows[0]?.failures || 0);
      const status: ConnectorStatus = shed || recordErrors.length || queuedFailures ? 'degraded' : 'active';
      const errorMessage = shed
        ? `Load shedding: ${shed.reason}`.slice(0, 500)
        : recordErrors.length
        ? `${recordErrors.length} record(s) failed; first: ${recordErrors[0].message}`.slice(0, 500)
        : queuedFailures
          ? `${queuedFailures} twin queue record(s) require retry or operator review; latest: ${queued.rows[0]?.last_error || 'processing failed'}`.slice(0, 500)
          : null;
      const result: IngestionPollResult = {
        connectorId,
        provider: connector.provider,
        fetchedCount,
        ...counters,
        recordErrors,
        hasMore,
        nextCursors,
        durationMs: now - startTime,
        ...(shed ? { loadShedding: shed } : {}),
      };

      await this.withEvent(async (tx) => {
        // A shed sync is neither a success nor a failure of the target: it was not contacted.
        await tx.query(
          `UPDATE integration_connectors
           SET status = $1, last_synced_at = $2, last_success_at = CASE WHEN $7 THEN last_success_at ELSE $2 END,
               sync_lag_seconds = $3, consecutive_failures = CASE WHEN $7 THEN consecutive_failures ELSE 0 END,
               error_message = $4, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 AND org_id = $6`,
          [status, new Date(now).toISOString(), lagSeconds, errorMessage, connectorId, orgId, Boolean(shed)],
        );
        return this.event(orgId, connectorId, actorId, 'ConnectorSyncCompleted', {
          connector_id: connectorId,
          provider: connector.provider,
          fetched: fetchedCount,
          ...counters,
          record_errors: recordErrors.length,
          has_more: hasMore,
          lag_seconds: lagSeconds,
          ...(shed ? { load_shedding_until: shed.until } : {}),
        });
      });
      return result;
    } finally {
      clearInterval(leaseHeartbeat);
      await this.releaseSyncLease(connectorId, leaseOwner);
    }
  }

  /** Runs one page of a scheduled native query through the provider adapter (US17.3). */
  public async fetchNativeQueryPage(
    connector: ConnectorRecord,
    entityType: string,
    query: string,
    cursor: WatermarkCursor,
  ): Promise<ConnectorFetchPage> {
    const adapter = this.getAdapter(connector.provider);
    if (!adapter.fetchNativeQuery) {
      throw new ConflictException(`The ${connector.provider} adapter does not support native queries`);
    }
    return adapter.fetchNativeQuery(this.context(connector), entityType, query, cursor);
  }

  /**
   * Processes whatever is due in a connector's ingestion queue without polling the provider, under
   * the same lease as `syncConnector`. Returns false when a sync already holds the lease: that
   * sync drains the queue itself, and the records stay durably enqueued either way.
   */
  public async drainIngestionQueue(orgId: string, connectorId: string): Promise<boolean> {
    const connector = await this.getConnector(orgId, connectorId);
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    if (!await this.acquireSyncLease(orgId, connectorId, leaseOwner)) return false;
    try {
      const counters: PollCounters = {
        twinsCreated: 0, twinsUpdated: 0, twinsUnchanged: 0, echoesSuppressed: 0,
        workOrdersPrepared: 0, workOrdersHeld: 0, workOrdersExecuted: 0, workOrdersFailed: 0,
        commentsFetched: 0, commentsStored: 0, commentsFiltered: 0, commentsTransferred: 0, commentsFailed: 0,
      };
      await this.processDueIngestionRecords(orgId, connector, counters, []);
      await this.ensureConnectorCommentDeliveries(orgId, connector.id);
      await this.processDueCommentDeliveries(orgId, counters);
      return true;
    } finally {
      await this.releaseSyncLease(connectorId, leaseOwner);
    }
  }

  private async acceptIngestionPage(
    orgId: string,
    connector: ConnectorRecord,
    entityType: string,
    records: ExternalRecordPayload[],
    cursorValue: string,
  ): Promise<number> {
    const { duplicateDeliveries } = await this.acceptRecords(orgId, connector, entityType, records, async (tx) => {
      await tx.query(
        `INSERT INTO integration_connector_cursors (id, connector_id, entity_type, cursor_value, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (connector_id, entity_type)
         DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = CURRENT_TIMESTAMP`,
        [randomUUID(), connector.id, entityType, cursorValue],
      );
    });
    return duplicateDeliveries;
  }

  /**
   * Durably enqueues the records of a scheduled native query (US17.3) through the same queue and
   * dedupe key as ordinary polling. `advance` runs in the same transaction as the inserts, so the
   * query's watermark moves if and only if its records were accepted.
   */
  public async enqueueNativeQueryRecords(
    orgId: string,
    connector: ConnectorRecord,
    entityType: string,
    records: ExternalRecordPayload[],
    advance: (tx: DatabaseQueryable, inserted: number, outcomes: EnqueuedRecordOutcome[]) => Promise<void>,
  ): Promise<{ inserted: number; duplicateDeliveries: number }> {
    const { inserted, duplicateDeliveries } = await this.acceptRecords(orgId, connector, entityType, records, advance);
    return { inserted, duplicateDeliveries };
  }

  /**
   * Durably enqueues one backfill page (US17.4). Each queued row is tagged with its job, so the
   * job's processed/queued/failed counts are read from the real queue rather than tracked twice.
   * `advance` runs in the same transaction, receiving one outcome per record, so chunk progress,
   * the audit rows and the queue entries commit or roll back together.
   */
  public async enqueueBackfillRecords(
    orgId: string,
    connector: ConnectorRecord,
    entityType: string,
    records: ExternalRecordPayload[],
    backfillJobId: string,
    advance: (tx: DatabaseQueryable, inserted: number, outcomes: EnqueuedRecordOutcome[]) => Promise<void>,
  ): Promise<{ inserted: number; outcomes: EnqueuedRecordOutcome[] }> {
    const { inserted, outcomes } = await this.acceptRecords(orgId, connector, entityType, records, advance, backfillJobId);
    return { inserted, outcomes };
  }

  /** Reads one backfill page through the provider adapter (US17.4). */
  public async fetchBackfillPage(
    connector: ConnectorRecord,
    entityType: string,
    window: BackfillWindow,
    query: string | undefined,
    pageToken?: string,
  ): Promise<BackfillPage> {
    const adapter = this.getAdapter(connector.provider);
    if (!adapter.fetchBackfillPage) {
      throw new ConflictException(`The ${connector.provider} adapter does not support historical backfill`);
    }
    return adapter.fetchBackfillPage(this.context(connector), entityType, window, query, pageToken);
  }

  /** Whether this connector's adapter can run a backfill at all. */
  public supportsBackfill(connector: ConnectorRecord): boolean {
    return typeof this.getAdapter(connector.provider).fetchBackfillPage === 'function';
  }

  private async acceptRecords(
    orgId: string,
    connector: ConnectorRecord,
    entityType: string,
    records: ExternalRecordPayload[],
    advance: (tx: DatabaseQueryable, inserted: number, outcomes: EnqueuedRecordOutcome[]) => Promise<void>,
    backfillJobId: string | null = null,
  ): Promise<{ inserted: number; duplicateDeliveries: number; outcomes: EnqueuedRecordOutcome[] }> {
    let duplicateDeliveries = 0;
    let insertedCount = 0;
    let outcomes: EnqueuedRecordOutcome[] = [];
    await this.dbService.db.transaction(async (tx) => {
      duplicateDeliveries = 0;
      insertedCount = 0;
      outcomes = [];
      for (const record of records) {
        const dedupeKey = createHash('sha256').update(stableStringify({
          provider: connector.provider,
          entityType,
          externalId: record.externalId,
          updatedAt: record.updatedAt,
          record,
        }), 'utf8').digest('hex');
        const inserted = await tx.query<any>(
          `INSERT INTO integration_connector_ingestion_queue
           (id, org_id, connector_id, partition_key, entity_type, external_id, dedupe_key,
            payload, status, backfill_job_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (connector_id, dedupe_key) DO NOTHING
           RETURNING id`,
          [
            randomUUID(), orgId, connector.id,
            this.twinPartitionKey(connector.provider, record.artifactType || entityType, record.externalId),
            entityType, record.externalId, dedupeKey, JSON.stringify(record), backfillJobId,
          ],
        );
        if (inserted.rows.length) {
          insertedCount += 1;
          outcomes.push({ externalId: record.externalId, updatedAt: record.updatedAt, queueEntryId: inserted.rows[0].id, outcome: 'enqueued' });
        } else {
          const existing = await tx.query<any>(
            `SELECT id, status FROM integration_connector_ingestion_queue
             WHERE connector_id = $1 AND dedupe_key = $2`,
            [connector.id, dedupeKey],
          );
          if (existing.rows[0]?.status === 'completed') duplicateDeliveries += 1;
          outcomes.push({ externalId: record.externalId, updatedAt: record.updatedAt, queueEntryId: existing.rows[0]?.id ?? null, outcome: 'duplicate' });
        }
      }
      await advance(tx, insertedCount, outcomes);
    });
    return { inserted: insertedCount, duplicateDeliveries, outcomes };
  }

  private async sheddingNotice(connector: ConnectorRecord): Promise<IngestionPollResult['loadShedding']> {
    try {
      const status = await this.rateGovernor.sheddingStatus(connector);
      if (status.state !== 'shedding' || !status.until) return undefined;
      return {
        until: status.until,
        reason: `${this.rateGovernor.describe(connector).targetOrigin} is under database semaphore pressure; Cadena is shedding load until ${status.until}`
          + (status.reason ? ` (last response: ${status.reason.slice(0, 160)})` : ''),
      };
    } catch (error) {
      if (error instanceof ConnectorConfigurationError) return undefined;
      throw error;
    }
  }

  /** True while the connector's target refuses calls (US16.2); a drain stops rather than refusing item by item. */
  private async isShedding(connector: ConnectorRecord): Promise<boolean> {
    try {
      return (await this.rateGovernor.sheddingStatus(connector)).state === 'shedding';
    } catch (error) {
      if (error instanceof ConnectorConfigurationError) return false;
      throw error;
    }
  }

  /**
   * Returns a claimed queue item to its queue until the target stops shedding load. The target
   * never saw the request, so the attempt the claim counted is given back: shedding can delay work
   * but can never dead-letter it.
   */
  private async deferShedWork(
    table: 'integration_connector_work_orders' | 'integration_comment_deliveries' | 'integration_connector_ingestion_queue',
    status: 'pending' | 'retry',
    orgId: string,
    id: string,
    claimId: string,
    error: ConnectorLoadShedError,
  ): Promise<void> {
    await this.dbService.db.query(
      `UPDATE ${table}
       SET status = $1, attempts = GREATEST(attempts - 1, 0), last_error = $2, next_attempt_at = $3,
           claimed_by = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5 AND claimed_by = $6`,
      [status, `Deferred: ${error.message}`.slice(0, 500), error.until.toISOString(), id, orgId, claimId],
    );
  }

  private async processDueIngestionRecords(
    orgId: string,
    connector: ConnectorRecord,
    counters: PollCounters,
    recordErrors: IngestionPollResult['recordErrors'],
  ): Promise<void> {
    let processed = 0;
    while (processed < 1000) {
      if (await this.isShedding(connector)) return;
      const due = await this.dbService.db.query<any>(
        `SELECT q.*
         FROM integration_connector_ingestion_queue q
         WHERE q.org_id = $1 AND q.connector_id = $2
            AND (q.status IN ('pending', 'retry')
              OR (q.status = 'processing'
                AND (q.claim_expires_at IS NULL OR q.claim_expires_at <= CURRENT_TIMESTAMP)))
           AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= CURRENT_TIMESTAMP)
           AND NOT EXISTS (
             SELECT 1 FROM integration_connector_ingestion_queue older
             WHERE older.org_id = q.org_id AND older.connector_id = q.connector_id
               AND older.partition_key = q.partition_key
               AND older.queue_position < q.queue_position
               AND older.status IN ('pending', 'retry', 'processing', 'dead')
           )
         ORDER BY q.queue_position ASC
         LIMIT 50`,
        [orgId, connector.id],
      );
      if (!due.rows.length) return;
      for (const row of due.rows) {
        await this.processIngestionRecord(orgId, connector, row, counters, recordErrors);
        processed += 1;
      }
    }
  }

  private async processIngestionRecord(
    orgId: string,
    connector: ConnectorRecord,
    row: any,
    counters: PollCounters,
    recordErrors: IngestionPollResult['recordErrors'],
  ): Promise<void> {
    const claimId = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.dbService.db.query<any>(
      `UPDATE integration_connector_ingestion_queue
       SET status = 'processing', attempts = attempts + 1, claimed_by = $3,
           claim_expires_at = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2
         AND (status IN ('pending', 'retry')
           OR (status = 'processing'
             AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)))
       RETURNING *`,
      [row.id, orgId, claimId, new Date(Date.now() + WORK_ORDER_CLAIM_MS).toISOString()],
    );
    if (!claimed.rows.length) return;
    const job = claimed.rows[0];
    const attempt = Number(job.attempts);
    const startedAt = new Date().toISOString();
    const record = parseJson<ExternalRecordPayload>(job.payload, {} as ExternalRecordPayload);
    try {
      await this.processRecord(orgId, connector, record, counters);
      const twin = await this.dbService.db.query<any>(
        `SELECT id FROM integration_canonical_twins
         WHERE org_id = $1 AND provider = $2 AND artifact_type = $3 AND external_id = $4`,
        [orgId, connector.provider, record.artifactType, record.externalId],
      );
      if (twin.rows[0]?.id) {
        await this.syncRecordComments(orgId, connector, record, twin.rows[0].id, counters);
      }
      const history = this.appendAttempt(job.attempt_history, {
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        outcome: 'completed',
      });
      await this.dbService.db.query(
        `UPDATE integration_connector_ingestion_queue
         SET status = 'completed', twin_id = $1, attempt_history = $2, last_error = NULL,
              next_attempt_at = NULL, claimed_by = NULL, claim_expires_at = NULL,
              completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND org_id = $4`,
        [twin.rows[0]?.id || null, JSON.stringify(history), job.id, orgId],
      );
    } catch (error) {
      if (error instanceof ConnectorLoadShedError) {
        await this.deferShedWork('integration_connector_ingestion_queue', 'retry', orgId, job.id, claimId, error);
        return;
      }
      const message = this.describe(error, 'Record processing failed');
      const status = attempt < MAX_WORK_ORDER_ATTEMPTS ? 'retry' : 'dead';
      const retryAfterMs = Math.min(WORK_ORDER_BASE_BACKOFF_MS * 2 ** (attempt - 1), WORK_ORDER_MAX_BACKOFF_MS);
      const history = this.appendAttempt(job.attempt_history, {
        attempt,
        startedAt,
        completedAt: new Date().toISOString(),
        outcome: status === 'dead' ? 'dead_lettered' : 'retry_scheduled',
        error: message,
      });
      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_connector_ingestion_queue
           SET status = $1, attempt_history = $2, last_error = $3, next_attempt_at = $4,
                claimed_by = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 AND org_id = $6`,
          [
            status, JSON.stringify(history), message.slice(0, 500),
            status === 'retry' ? new Date(Date.now() + retryAfterMs).toISOString() : null,
            job.id, orgId,
          ],
        );
        if (status === 'dead') {
          await tx.query(
            `UPDATE integration_canonical_twins SET sync_state = 'paused', updated_at = CURRENT_TIMESTAMP
             WHERE org_id = $1 AND provider = $2 AND artifact_type = $3 AND external_id = $4`,
            [orgId, connector.provider, record.artifactType, record.externalId],
          );
        }
        return this.event(orgId, job.id, `connector:${connector.id}`, 'TwinQueueAttemptFailed', {
          queue_entry_id: job.id,
          connector_id: connector.id,
          partition_key: job.partition_key,
          kind: 'ingestion',
          attempts: attempt,
          final: status === 'dead',
          error: message,
        });
      });
      recordErrors.push({
        externalId: record.externalId || job.external_id,
        entityType: record.artifactType || job.entity_type,
        message,
      });
    }
  }

  private async processRecord(
    orgId: string,
    connector: ConnectorRecord,
    record: ExternalRecordPayload,
    counters: PollCounters,
  ): Promise<RecordOutcome> {
    if (!record.externalId) throw new Error('Provider record has no immutable id');
    const existing = await this.dbService.db.query<any>(
      `SELECT t.id, t.connector_id, t.content_hash, t.native_status, t.payload, t.source_updated_at, c.name AS connector_name
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
       WHERE t.org_id = $1 AND t.provider = $2 AND t.artifact_type = $3 AND t.external_id = $4`,
      [orgId, connector.provider, record.artifactType, record.externalId],
    );
    const prior = existing.rows[0];
    if (prior && prior.connector_id !== connector.id) {
      throw new Error(`${connector.provider}/${record.artifactType}/${record.externalId} is already managed by connector "${prior.connector_name}"`);
    }

    // A record read earlier can reach the queue after a newer one already updated the twin (a
    // backfill page racing a live sync, or a slow retry). Applying it would roll the twin back to a
    // state the source has already left, so an older source timestamp is dropped as stale.
    if (prior?.source_updated_at && Date.parse(record.updatedAt) < new Date(prior.source_updated_at).getTime()) {
      counters.twinsUnchanged++;
      return 'unchanged';
    }

    const contentHash = createHash('sha256').update(stableStringify({
      title: record.title,
      status: record.status,
      nativeKey: record.nativeKey || null,
      nativeUrl: record.nativeUrl || null,
      fields: record.fields,
      fieldAuthority: record.fieldAuthority || {},
    }), 'utf8').digest('hex');
    if (prior && prior.content_hash === contentHash) {
      counters.twinsUnchanged++;
      return 'unchanged';
    }

    const identity: SyncIdentity = {
      system: connector.provider,
      entity_type: record.artifactType,
      immutable_id: record.externalId,
    };
    const node = await this.correlationService.upsertNode(orgId, {
      ...identity,
      display_key: record.nativeKey || record.externalId,
      url: record.nativeUrl,
    }, `connector:${connector.id}`);

    const twinId: string = prior?.id || randomUUID();
    const stateChanged = !prior || !sameState(prior.native_status, record.status);
    // A field-mapping-relevant change (e.g. priority) can arrive with no state change at all;
    // gating propagation on state alone would silently drop it. `unchanged` was already ruled out
    // above by the content-hash check, so once we reach here, comparing per-key against the prior
    // payload is what tells state-only churn (title/metadata) apart from an actual field change.
    const priorFields = prior ? parseJson<Record<string, unknown>>(prior.payload, {}) : {};
    const fieldsChanged = !prior || Object.keys({ ...priorFields, ...record.fields }).some(
      (key) => stableStringify(priorFields[key] ?? null) !== stableStringify(record.fields[key] ?? null),
    );
    const twinEvent = await this.withEvent(async (tx) => {
      if (prior) {
        await tx.query(
          `UPDATE integration_canonical_twins
           SET native_key = $1, native_url = $2, title = $3, native_status = $4, field_authority = $5,
               payload = $6, content_hash = $7, source_updated_at = $8, correlation_node_id = $9,
               sync_state = 'synced', updated_at = CURRENT_TIMESTAMP
           WHERE id = $10 AND org_id = $11`,
          [
            record.nativeKey || null, record.nativeUrl || null, record.title, record.status,
            JSON.stringify(record.fieldAuthority || {}), JSON.stringify(record.fields), contentHash,
            record.updatedAt, node.id, twinId, orgId,
          ],
        );
      } else {
        await tx.query(
          `INSERT INTO integration_canonical_twins
           (id, org_id, connector_id, provider, artifact_type, external_id, native_key, native_url, title,
            native_status, sync_state, field_authority, payload, content_hash, source_updated_at,
            correlation_node_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'synced', $11, $12, $13, $14, $15,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            twinId, orgId, connector.id, connector.provider, record.artifactType, record.externalId,
            record.nativeKey || null, record.nativeUrl || null, record.title, record.status,
            JSON.stringify(record.fieldAuthority || {}), JSON.stringify(record.fields), contentHash,
            record.updatedAt, node.id,
          ],
        );
      }
      return this.event(orgId, twinId, `connector:${connector.id}`, prior ? 'CanonicalTwinUpdated' : 'CanonicalTwinMaterialized', {
        twin_id: twinId,
        connector_id: connector.id,
        identity,
        native_key: record.nativeKey || null,
        native_status: record.status,
        correlation_node_id: node.id,
        source_updated_at: record.updatedAt,
        state_changed: stateChanged,
        fields_changed: fieldsChanged,
        title: record.title,
        fields: record.fields,
        updated_by: record.updatedBy || `${connector.provider}:unattributed`,
      });
    });
    if (prior) counters.twinsUpdated++;
    else counters.twinsCreated++;

    if ((stateChanged && record.status) || fieldsChanged) {
      await this.addPropagationCounters(twinEvent.event_id, counters);
    }
    return prior ? 'updated' : 'created';
  }

  // â”€â”€â”€ Public comments (US13.4) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Reads comments only when this connector explicitly opts in. The adapter has already removed
   * ServiceNow work notes and Jira/JSM restricted comments, so private text never enters a queue,
   * table or event. Stable provider author ids are then screened by the connector policy.
   */
  private async syncRecordComments(
    orgId: string,
    connector: ConnectorRecord,
    record: ExternalRecordPayload,
    twinId: string,
    counters: PollCounters,
  ): Promise<void> {
    const policy = this.commentPolicy(connector);
    if (!this.commentCanRead(policy)) return;
    const adapter = this.getAdapter(connector.provider);
    if (!adapter.fetchPublicComments) {
      throw new ConnectorConfigurationError(`${connector.provider} does not support public-comment reads`);
    }
    const comments = await adapter.fetchPublicComments(this.context(connector), {
      entityType: record.artifactType,
      externalId: record.externalId,
    });
    counters.commentsFetched += comments.length;

    for (const comment of comments) {
      if (!this.validPublicComment(comment) || !this.commentAuthorPermitted(policy, comment.authorId)) {
        counters.commentsFiltered += 1;
        continue;
      }
      if (comment.originMarker) {
        const echo = await this.dbService.db.query<any>(
          `SELECT id FROM integration_comment_deliveries
           WHERE org_id = $1 AND target_connector_id = $2 AND target_twin_id = $3 AND marker = $4`,
          [orgId, connector.id, twinId, comment.originMarker.toLowerCase()],
        );
        if (echo.rows.length) {
          counters.commentsFiltered += 1;
          continue;
        }
      }

      const commentId = randomUUID();
      const inserted = await this.dbService.db.query<any>(
        `INSERT INTO integration_public_comments
         (id, org_id, source_twin_id, source_connector_id, provider_comment_id, body,
          original_author_id, original_author_name, source_system, source_created_at, native_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
         ON CONFLICT (source_connector_id, provider_comment_id) DO NOTHING RETURNING id`,
        [
          commentId, orgId, twinId, connector.id, comment.externalId, comment.body.trim(),
          comment.authorId, comment.authorName, connector.provider, comment.createdAt,
          comment.nativeUrl || null,
        ],
      );
      let storedId = inserted.rows[0]?.id as string | undefined;
      if (storedId) counters.commentsStored += 1;
      else {
        const existing = await this.dbService.db.query<any>(
          `SELECT id FROM integration_public_comments
           WHERE org_id = $1 AND source_connector_id = $2 AND provider_comment_id = $3`,
          [orgId, connector.id, comment.externalId],
        );
        storedId = existing.rows[0]?.id;
      }
      if (storedId) await this.ensureCommentDeliveries(orgId, storedId, twinId);
    }
  }

  private validPublicComment(comment: ExternalPublicComment): boolean {
    return Boolean(comment?.externalId?.trim() && comment?.body?.trim() && comment?.authorId?.trim()
      && comment?.authorName?.trim() && Number.isFinite(Date.parse(comment?.createdAt)));
  }

  /** Creates at most one durable delivery for every currently managed counterpart. */
  private async ensureCommentDeliveries(orgId: string, commentId: string, sourceTwinId: string): Promise<void> {
    const source = await this.dbService.db.query<any>(
      `SELECT correlation_node_id FROM integration_canonical_twins WHERE id = $1 AND org_id = $2`,
      [sourceTwinId, orgId],
    );
    const nodeId = source.rows[0]?.correlation_node_id;
    if (!nodeId) return;
    const targets = await this.dbService.db.query<any>(
      `SELECT t.id AS twin_id, t.connector_id, c.config
       FROM integration_correlation_links l
       JOIN integration_canonical_twins t
         ON t.org_id = l.org_id
        AND t.correlation_node_id = CASE WHEN l.source_node_id = $2 THEN l.target_node_id ELSE l.source_node_id END
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
       WHERE l.org_id = $1 AND l.relationship = 'counterpart'
         AND (l.source_node_id = $2 OR l.target_node_id = $2)`,
      [orgId, nodeId],
    );
    for (const target of targets.rows) {
      const config = parseJson<Record<string, unknown>>(target.config, {});
      const policy = this.validateCommentSync(config.commentSync);
      if (!this.commentCanWrite(policy)) continue;
      const deliveryId = randomUUID();
      await this.dbService.db.query(
        `INSERT INTO integration_comment_deliveries
         (id, org_id, comment_id, target_connector_id, target_twin_id, marker, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (comment_id, target_twin_id) DO NOTHING`,
        [deliveryId, orgId, commentId, target.connector_id, target.twin_id, deliveryId],
      );
    }
  }

  /** A counterpart can be linked after a comment was first ingested; a later source sync catches it up. */
  private async ensureConnectorCommentDeliveries(orgId: string, connectorId: string): Promise<void> {
    const comments = await this.dbService.db.query<any>(
      `SELECT id, source_twin_id FROM integration_public_comments
       WHERE org_id = $1 AND source_connector_id = $2 ORDER BY source_created_at ASC LIMIT 10000`,
      [orgId, connectorId],
    );
    for (const comment of comments.rows) {
      await this.ensureCommentDeliveries(orgId, comment.id, comment.source_twin_id);
    }
  }

  /** Executes due comment writes independently of state work-order FIFO queues. */
  private async processDueCommentDeliveries(orgId: string, counters: PollCounters): Promise<void> {
    let processed = 0;
    while (processed < 500) {
      const due = await this.dbService.db.query<any>(
        `SELECT d.*, pc.body, pc.original_author_id, pc.original_author_name, pc.source_system,
                target.artifact_type AS target_entity_type, target.external_id AS target_external_id,
                c.provider AS target_provider, c.config AS target_config, c.status AS target_status,
                c.activated_at AS target_activated_at, source.config AS source_config
         FROM integration_comment_deliveries d
         JOIN integration_public_comments pc ON pc.id = d.comment_id AND pc.org_id = d.org_id
         JOIN integration_canonical_twins target ON target.id = d.target_twin_id AND target.org_id = d.org_id
         JOIN integration_connectors c ON c.id = d.target_connector_id AND c.org_id = d.org_id
         JOIN integration_connectors source ON source.id = pc.source_connector_id AND source.org_id = d.org_id
         WHERE d.org_id = $1
           AND (d.status IN ('pending', 'failed') OR
             (d.status = 'processing' AND (d.claim_expires_at IS NULL OR d.claim_expires_at <= CURRENT_TIMESTAMP)))
           AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= CURRENT_TIMESTAMP)
         ORDER BY d.created_at ASC, d.id ASC LIMIT 50`,
        [orgId],
      );
      if (!due.rows.length) return;
      let progressed = false;
      for (const row of due.rows) {
        const sourcePolicy = this.validateCommentSync(parseJson<Record<string, unknown>>(row.source_config, {}).commentSync);
        const policy = this.validateCommentSync(parseJson<Record<string, unknown>>(row.target_config, {}).commentSync);
        if (!row.target_activated_at || row.target_status === 'paused' || !this.commentCanWrite(policy)) continue;
        if (!this.commentCanRead(sourcePolicy)
          || !this.commentAuthorPermitted(sourcePolicy, row.original_author_id)
          || !this.commentAuthorPermitted(policy, row.original_author_id)) {
          await this.dbService.db.query(
            `UPDATE integration_comment_deliveries
             SET status = 'skipped', last_error = 'Current source or target comment policy does not permit this transfer',
                 updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND org_id = $2`,
            [row.id, orgId],
          );
          progressed = true;
          processed += 1;
          continue;
        }
        await this.executeCommentDelivery(orgId, row, counters);
        progressed = true;
        processed += 1;
      }
      // All due rows can legitimately be waiting for a disabled or paused target.
      if (!progressed) return;
    }
  }

  private async executeCommentDelivery(orgId: string, row: any, counters: PollCounters): Promise<void> {
    const claimId = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.dbService.db.query<any>(
      `UPDATE integration_comment_deliveries
       SET status = 'processing', attempts = attempts + 1, claimed_by = $1, claim_expires_at = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4
         AND (status IN ('pending', 'failed') OR
           (status = 'processing' AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)))
       RETURNING attempts`,
      [claimId, new Date(Date.now() + WORK_ORDER_CLAIM_MS).toISOString(), row.id, orgId],
    );
    if (!claimed.rows.length) return;
    const attempts = Number(claimed.rows[0].attempts);
    const target = await this.getConnector(orgId, row.target_connector_id);
    const adapter = this.getAdapter(target.provider);
    const marker = String(row.marker).toLowerCase();
    try {
      if (!adapter.pushPublicComment) {
        throw new ConnectorConfigurationError(`${target.provider} does not support public-comment writes`);
      }
      // A provider write may have succeeded immediately before a crash. Searching for the stable
      // marker first makes the retry a completion, not a duplicate comment.
      let existing: ExternalPublicComment | undefined;
      if (adapter.fetchPublicComments) {
        const targetComments = await adapter.fetchPublicComments(this.context(target), {
          entityType: row.target_entity_type, externalId: row.target_external_id,
        });
        existing = targetComments.find((comment) => comment.originMarker?.toLowerCase() === marker);
      }
      const result = existing
        ? { externalId: existing.externalId, message: 'Recovered an already-written public comment by its Cadena marker' }
        : await adapter.pushPublicComment(
          this.context(target),
          { entityType: row.target_entity_type, externalId: row.target_external_id },
          this.transferredCommentBody(row, marker),
        );
      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_comment_deliveries
           SET status = 'executed', target_comment_id = $1, last_error = NULL, next_attempt_at = NULL,
               claimed_by = NULL, claim_expires_at = NULL, executed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND org_id = $3 AND claimed_by = $4`,
          [result.externalId, row.id, orgId, claimId],
        );
        return this.event(orgId, row.target_twin_id, `connector:${target.id}`, 'PublicCommentTransferred', {
          comment_id: row.comment_id,
          delivery_id: row.id,
          target_connector_id: target.id,
          target_twin_id: row.target_twin_id,
          target_comment_id: result.externalId,
          original_author_id: row.original_author_id,
          source_system: row.source_system,
        });
      });
      counters.commentsTransferred += 1;
    } catch (error) {
      if (error instanceof ConnectorLoadShedError) {
        await this.deferShedWork('integration_comment_deliveries', 'pending', orgId, row.id, claimId, error);
        return;
      }
      const message = this.describe(error, 'Public comment write failed');
      const retryable = (error instanceof ConnectorRemoteError && error.retryable) || error instanceof ConnectorCredentialError;
      const status = retryable && attempts < MAX_WORK_ORDER_ATTEMPTS ? 'failed' : 'dead';
      const retryAfterMs = error instanceof ConnectorRemoteError && error.retryAfterSeconds
        ? error.retryAfterSeconds * 1000
        : Math.min(WORK_ORDER_BASE_BACKOFF_MS * 2 ** (attempts - 1), WORK_ORDER_MAX_BACKOFF_MS);
      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_comment_deliveries
           SET status = $1, last_error = $2, next_attempt_at = $3, claimed_by = NULL,
               claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND org_id = $5 AND claimed_by = $6`,
          [status, message.slice(0, 500), status === 'failed' ? new Date(Date.now() + retryAfterMs).toISOString() : null, row.id, orgId, claimId],
        );
        return this.event(orgId, row.target_twin_id, `connector:${target.id}`, 'PublicCommentTransferFailed', {
          comment_id: row.comment_id, delivery_id: row.id, target_connector_id: target.id,
          target_twin_id: row.target_twin_id, attempts, retryable, final: status === 'dead', error: message,
        });
      });
      counters.commentsFailed += 1;
    }
  }

  private transferredCommentBody(row: any, marker: string): string {
    const author = String(row.original_author_name || row.original_author_id);
    return `${String(row.body).trim()}\n\nâ€” Originally posted by ${author} (${row.original_author_id}) in ${providerName(row.source_system)}\n[cadena-comment:${marker}]`;
  }

  private commentPolicy(connector: ConnectorRecord): ConnectorCommentSyncPolicy {
    return this.validateCommentSync(connector.config.commentSync);
  }

  private commentCanRead(policy: ConnectorCommentSyncPolicy): boolean {
    return policy.enabled && (policy.direction === 'from_source' || policy.direction === 'bidirectional');
  }

  private commentCanWrite(policy: ConnectorCommentSyncPolicy): boolean {
    return policy.enabled && (policy.direction === 'to_source' || policy.direction === 'bidirectional');
  }

  private commentAuthorPermitted(policy: ConnectorCommentSyncPolicy, authorId: string): boolean {
    const id = String(authorId || '').trim().toLowerCase();
    const allow = new Set(policy.authorAllowList.map((value) => value.toLowerCase()));
    const block = new Set(policy.authorBlockList.map((value) => value.toLowerCase()));
    return Boolean(id) && !block.has(id) && (allow.size === 0 || allow.has(id));
  }

  /**
   * Accepts a committed twin event from the transactional outbox. Each counterpart gets one
   * durable work order keyed by (source event, target twin), making replay idempotent. Translation
   * and provider I/O then happen from the target twin's FIFO partition.
   */
  private async acceptPropagationEvent(event: DomainEventEnvelope): Promise<void> {
    const payload = event.payload || {};
    const orgId = String(payload.org_id || '');
    const twinId = String(payload.twin_id || event.work_item_id || '');
    // A field-mapping-relevant change (e.g. priority) can arrive with no state change at all, so
    // this only bails when *neither* changed — `fields_changed` defaults true for events (like an
    // operator field edit) that predate this flag and always mean something worth propagating.
    if (!orgId || !twinId || (payload.state_changed === false && payload.fields_changed === false)) return;

    const existingReceipt = await this.dbService.db.query<any>(
      `SELECT status FROM integration_connector_propagations WHERE source_event_id = $1 AND org_id = $2`,
      [event.event_id, orgId],
    );
    if (existingReceipt.rows[0]?.status === 'completed' || existingReceipt.rows[0]?.status === 'echo_suppressed') {
      return;
    }

    const sourceTwin = await this.dbService.db.query<any>(
      `SELECT t.*, c.provider AS connector_provider
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
       WHERE t.id = $1 AND t.org_id = $2`,
      [twinId, orgId],
    );
    const source = sourceTwin.rows[0];
    if (!source) throw new Error(`Source twin ${twinId} no longer exists`);
    const identity: SyncIdentity = payload.identity || {
      system: source.provider,
      entity_type: source.artifact_type,
      immutable_id: source.external_id,
    };
    const state = String(payload.native_status || payload.state || source.native_status || '');
    // `state` always reflects the twin's *current* value, whether or not it just changed, since
    // it also has to be available to build the echo-suppression payload below. Whether a state
    // translation should even be attempted downstream depends on the distinct question of whether
    // it *changed* on this event — carried through separately so a fields-only change is never
    // mistaken for one with an (unmapped, and therefore held) state transition.
    const stateChanged = payload.state_changed === true;
    const sourceFields = (payload.fields && typeof payload.fields === 'object' ? payload.fields : parseJson(source.payload, {})) as Record<string, unknown>;

    await this.dbService.db.query(
      `INSERT INTO integration_connector_propagations
       (source_event_id, org_id, source_twin_id, status, echoes_suppressed, created_at, updated_at)
       VALUES ($1, $2, $3, 'processing', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (source_event_id) DO NOTHING`,
      [event.event_id, orgId, twinId],
    );

    const skipEchoCheck = event.event_type === 'ConnectorOperatorStateWritten';
    if (!skipEchoCheck) {
      // A write we made ourselves only ever touches fields a published mapping actually writes to
      // this endpoint, so the check is restricted to that set — comparing the twin's *entire*
      // field set would treat an unrelated concurrent change on some other field as if it broke
      // the echo match.
      const writtenFieldNames = await this.fieldMappingService.writtenFieldNames(orgId, {
        system: source.provider, entity_type: source.artifact_type,
      });
      const watchedFields = pickPaths(sourceFields, writtenFieldNames);
      // Mirrors exactly what a governed write would have recorded: `state` only when this event's
      // state actually changed, since a fields-only write never touches state and would otherwise
      // never content-hash-match against this always-present "current state" value.
      const decision = await this.syncGuardService.evaluateWebhook(orgId, {
        identity,
        actor_id: String(payload.updated_by || `${source.provider}:unattributed`),
        payload: { ...(stateChanged && state ? { state } : {}), ...(Object.keys(watchedFields).length ? { fields: watchedFields } : {}) },
      });
      if (decision.suppressed) {
        await this.dbService.db.query(
          `UPDATE integration_connector_propagations
           SET status = 'echo_suppressed', echoes_suppressed = 1, updated_at = CURRENT_TIMESTAMP
           WHERE source_event_id = $1`,
          [event.event_id],
        );
        return;
      }
    }

    const counterparts = await this.dbService.db.query<any>(
      `SELECT t.id, t.connector_id, t.provider, t.artifact_type, t.external_id, t.native_status
       FROM integration_correlation_links l
       JOIN integration_canonical_twins t
         ON t.org_id = l.org_id
        AND t.correlation_node_id = CASE WHEN l.source_node_id = $2 THEN l.target_node_id ELSE l.source_node_id END
       WHERE l.org_id = $1 AND l.relationship = 'counterpart'
         AND (l.source_node_id = $2 OR l.target_node_id = $2)
       ORDER BY t.id`,
      [orgId, source.correlation_node_id],
    );

    for (const target of counterparts.rows) {
      const workOrderId = randomUUID();
      await this.dbService.db.query(
        `INSERT INTO integration_connector_work_orders
         (id, org_id, transaction_id, origin, source_event_id, source_payload, source_connector_id,
          target_connector_id, target_twin_id, target_entity_type, target_external_id, target_state,
          fields, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'state_propagation', $3, $4, $5, $6, $7, $8, $9, $10,
                 '{}', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (source_event_id, target_twin_id) WHERE source_event_id IS NOT NULL DO NOTHING`,
        [
          workOrderId, orgId, event.event_id,
          JSON.stringify({ identity, state: state || null, stateChanged, fields: sourceFields, title: payload.title || source.title }),
          source.connector_id, target.connector_id, target.id, target.artifact_type, target.external_id,
          // The real target state, if any, is only known once state-mapping translation runs;
          // storing the (unchanged) current state here would leak through as a stale write for a
          // fields-only propagation, since `targetState` below defaults from this column.
          stateChanged ? state || null : null,
        ],
      );
    }

    const targetConnectorIds = Array.from(new Set(counterparts.rows.map((row) => String(row.connector_id))));
    for (const targetConnectorId of targetConnectorIds) {
      const targetConnector = await this.getConnector(orgId, targetConnectorId);
      const counters: PollCounters = {
        twinsCreated: 0, twinsUpdated: 0, twinsUnchanged: 0, echoesSuppressed: 0,
        workOrdersPrepared: 0, workOrdersHeld: 0, workOrdersExecuted: 0, workOrdersFailed: 0,
        commentsFetched: 0, commentsStored: 0, commentsFiltered: 0, commentsTransferred: 0, commentsFailed: 0,
      };
      await this.processDueWorkOrders(orgId, targetConnector, counters);
    }
    await this.dbService.db.query(
      `UPDATE integration_connector_propagations
       SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE source_event_id = $1`,
      [event.event_id],
    );
  }

  private async addPropagationCounters(sourceEventId: string, counters: PollCounters): Promise<void> {
    const [receipt, orders] = await Promise.all([
      this.dbService.db.query<any>(
        `SELECT echoes_suppressed FROM integration_connector_propagations WHERE source_event_id = $1`,
        [sourceEventId],
      ),
      this.dbService.db.query<any>(
        `SELECT status, COUNT(*)::int AS count FROM integration_connector_work_orders
         WHERE source_event_id = $1 GROUP BY status`,
        [sourceEventId],
      ),
    ]);
    counters.echoesSuppressed += Number(receipt.rows[0]?.echoes_suppressed || 0);
    for (const row of orders.rows) {
      const count = Number(row.count || 0);
      if (row.status === 'held') counters.workOrdersHeld += count;
      else {
        counters.workOrdersPrepared += count;
        if (row.status === 'executed') counters.workOrdersExecuted += count;
        if (row.status === 'failed' || row.status === 'dead') counters.workOrdersFailed += count;
      }
    }
  }

  // ─── Work orders ───────────────────────────────────────────────────────────

  private async processDueWorkOrders(orgId: string, connector: ConnectorRecord, counters: PollCounters): Promise<void> {
    let processed = 0;
    // One drain may process many distinct queue heads, but it never attempts the same order twice.
    // A short adaptive delay must survive until a later scheduler/sync turn, not expire while this
    // turn is still handling other targets and then replay inside the same call.
    const cycleStartedAt = new Date().toISOString();
    while (processed < 500) {
      if (await this.isShedding(connector)) return;
      const due = await this.dbService.db.query<any>(
        `SELECT w.id FROM integration_connector_work_orders w
         WHERE w.org_id = $1 AND w.target_connector_id = $2
            AND (w.status IN ('pending', 'failed')
              OR (w.status = 'processing'
                AND (w.claim_expires_at IS NULL OR w.claim_expires_at <= CURRENT_TIMESTAMP)))
           AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= CURRENT_TIMESTAMP)
           AND w.updated_at <= $3
           AND NOT EXISTS (
             SELECT 1 FROM integration_connector_work_orders older
             WHERE older.org_id = w.org_id AND older.target_twin_id = w.target_twin_id
               AND older.queue_position < w.queue_position
               AND older.status IN ('pending', 'processing', 'failed', 'dead', 'held')
           )
         ORDER BY w.queue_position ASC LIMIT 50`,
        [orgId, connector.id, cycleStartedAt],
      );
      if (!due.rows.length) return;
      const outcomes = await Promise.all(due.rows.map((row) => this.executeWorkOrder(orgId, row.id)));
      for (const outcome of outcomes) {
        if (outcome === 'executed') counters.workOrdersExecuted++;
        else if (outcome === 'held') counters.workOrdersHeld++;
        else if (outcome === 'failed' || outcome === 'dead') counters.workOrdersFailed++;
        processed += 1;
      }
    }
  }

  /** Atomically claims and executes the head of one twin's durable FIFO queue. */
  public async executeWorkOrder(orgId: string, workOrderId: string): Promise<ConnectorWorkOrderStatus> {
    const loaded = await this.dbService.db.query<any>(
      `SELECT w.*, c.status AS connector_status, c.activated_at AS connector_activated_at
       FROM integration_connector_work_orders w
       JOIN integration_connectors c ON c.id = w.target_connector_id AND c.org_id = w.org_id
       WHERE w.id = $1 AND w.org_id = $2`,
      [workOrderId, orgId],
    );
    const row = loaded.rows[0];
    if (!row) throw new NotFoundException(`Work order ${workOrderId} not found`);
    if (!['pending', 'failed', 'processing'].includes(row.status)) return row.status;
    if (row.status === 'processing' && row.claim_expires_at
      && Date.parse(String(row.claim_expires_at)) > Date.now()) {
      return 'processing';
    }
    // A target that is not activated or is paused keeps the order queued rather than failing it.
    if (!row.connector_activated_at || row.connector_status === 'paused') return row.status;

    const blocked = await this.dbService.db.query<any>(
      `SELECT id FROM integration_connector_work_orders
       WHERE org_id = $1 AND target_twin_id = $2 AND queue_position < $3
         AND status IN ('pending', 'processing', 'failed', 'dead', 'held')
       ORDER BY queue_position ASC LIMIT 1`,
      [orgId, row.target_twin_id, row.queue_position],
    );
    if (blocked.rows.length) return row.status;

    const claimId = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.dbService.db.query<any>(
      `UPDATE integration_connector_work_orders
       SET status = 'processing', attempts = attempts + 1, claimed_by = $1,
           claim_expires_at = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4 AND attempts = $5
         AND (status IN ('pending', 'failed')
            OR (status = 'processing'
              AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)))
       RETURNING *`,
      [claimId, new Date(Date.now() + WORK_ORDER_CLAIM_MS).toISOString(), workOrderId, orgId, row.attempts],
    );
    if (!claimed.rows.length) return row.status === 'processing' ? 'processing' : row.status;
    const work = claimed.rows[0];
    const attempts = Number(work.attempts);
    const startedAt = new Date().toISOString();
    const claimHeartbeat = setInterval(() => {
      void this.renewWorkOrderClaim(workOrderId, claimId);
    }, Math.floor(WORK_ORDER_CLAIM_MS / 3));
    claimHeartbeat.unref?.();

    const target = await this.getConnector(orgId, work.target_connector_id);
    const adapter = this.getAdapter(target.provider);
    let transactionId: string | null = work.transaction_id || null;
    let targetState: string | undefined = work.target_state ?? undefined;
    let fields = parseJson<Record<string, unknown>>(work.fields, {});
    let translationInProgress = work.origin === 'state_propagation' && !transactionId;
    try {
      if (translationInProgress) {
        const sourcePayload = parseJson<any>(work.source_payload, {});
        const targetTwin = await this.dbService.db.query<any>(
          `SELECT twin.provider, twin.artifact_type, twin.external_id, twin.native_status,
                  COALESCE((
                    SELECT prior.target_state FROM integration_connector_work_orders prior
                    WHERE prior.org_id = twin.org_id AND prior.target_twin_id = twin.id
                      AND prior.queue_position < $3 AND prior.status IN ('executed', 'noop')
                      AND prior.target_state IS NOT NULL
                    ORDER BY prior.queue_position DESC LIMIT 1
                  ), twin.native_status) AS effective_status
           FROM integration_canonical_twins twin WHERE twin.id = $1 AND twin.org_id = $2`,
          [work.target_twin_id, orgId, work.queue_position],
        );
        const twin = targetTwin.rows[0];
        if (!twin) throw new Error(`Target twin ${work.target_twin_id} no longer exists`);
        const sourceIdentity: SyncIdentity = sourcePayload.identity;
        const targetIdentity: SyncIdentity = { system: twin.provider, entity_type: twin.artifact_type, immutable_id: twin.external_id };
        const sourceFields = (sourcePayload.fields || {}) as Record<string, unknown>;

        // US13.1 state translation and US17.2 field-mapping translation are independent; a
        // composite work order carries whichever of the two actually apply. Neither is attempted
        // unless there is something for it to translate, so a fields-only propagation never
        // touches state-mapping, and a state-only one (no published field mapping) never touches
        // field-mapping.
        let holdReason: string | null = null;
        let holdMessage: string | null = null;

        // Evaluated first (it is read-only) so a state rule's required target fields, such as a ServiceNow
        // resolution code and notes, are satisfied by what a field mapping will actually write, not only by
        // fields the source happens to carry under the same name (US13.5).
        const fieldTranslation = await this.fieldMappingService.translate(orgId, sourceIdentity, targetIdentity, {
          sourceFields,
          sourceState: sourcePayload.state || null,
          targetState: twin.effective_status || null,
        });

        if (sourcePayload.stateChanged && sourcePayload.state) {
          const translation = await this.stateMappingService.translate(orgId, {
            source_identity: sourceIdentity,
            target_identity: targetIdentity,
            source_state: sourcePayload.state,
            current_target_state: twin.effective_status || null,
            target_fields: {
              ...sourceFields,
              ...(fieldTranslation && fieldTranslation.status !== 'held' ? fieldTranslation.fields : {}),
            },
            dry_run: false,
          }, `connector:${work.source_connector_id || target.id}`);
          transactionId = translation.transaction_id;
          if (translation.status !== 'ready' || !transactionId || !translation.mapped_target_state) {
            holdReason = translation.reason;
            holdMessage = translation.message || 'State translation requires operator review';
            if (translation.reason === 'missing_required_fields') {
              // The record is left exactly as it was: closing it incomplete is the failure this guards against.
              holdMessage += `. The ${target.provider} record was not changed. Supply the field(s), either by adding a published field mapping that provides them or by re-injecting this held entry from the twin dead-letter queue with a corrected sourcePayload.`;
            }
          } else {
            const required = await this.dbService.db.query<any>(
              `SELECT required_target_fields FROM integration_state_sync_transactions WHERE id = $1 AND org_id = $2`,
              [translation.transaction_id, orgId],
            );
            const requiredPaths: string[] = parseJson(required.rows[0]?.required_target_fields, []);
            targetState = translation.mapped_target_state;
            fields = { ...fields, ...pickPaths(sourceFields, requiredPaths) };
          }
        }

        if (!holdReason) {
          if (fieldTranslation) {
            if (fieldTranslation.status === 'held') {
              const first = fieldTranslation.outcomes.find((outcome) => outcome.status === 'held');
              holdReason = 'field_mapping_held';
              holdMessage = (first && 'message' in first ? first.message : null) || 'Field mapping requires operator review';
            } else {
              fields = { ...fields, ...fieldTranslation.fields };
            }
          }
        }

        if (holdReason) {
          const history = this.appendAttempt(work.attempt_history, {
            attempt: attempts,
            startedAt,
            completedAt: new Date().toISOString(),
            outcome: 'held',
            error: holdMessage || undefined,
          });
          await this.withEvent(async (tx) => {
            await tx.query(
              `UPDATE integration_connector_work_orders
               SET transaction_id = $1, status = 'held', last_error = $2, attempt_history = $3,
                   claimed_by = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = $4 AND org_id = $5 AND claimed_by = $6`,
              [transactionId, (holdMessage || '').slice(0, 500), JSON.stringify(history), workOrderId, orgId, claimId],
            );
            await tx.query(
              `UPDATE integration_canonical_twins SET sync_state = 'paused', updated_at = CURRENT_TIMESTAMP
               WHERE id = $1 AND org_id = $2`,
              [work.target_twin_id, orgId],
            );
            return this.event(orgId, workOrderId, `connector:${target.id}`, 'ConnectorWorkOrderHeld', {
              work_order_id: workOrderId,
              transaction_id: transactionId,
              target_twin_id: work.target_twin_id,
              reason: holdReason,
              error: holdMessage,
            });
          });
          return 'held';
        }

        const noop = (!targetState || sameState(twin.effective_status, targetState)) && Object.keys(fields).length === 0;
        if (noop) {
          const history = this.appendAttempt(work.attempt_history, {
            attempt: attempts,
            startedAt,
            completedAt: new Date().toISOString(),
            outcome: 'completed',
          });
          await this.dbService.db.query(
            `UPDATE integration_connector_work_orders
             SET transaction_id = $1, target_state = $2, fields = $3, status = 'noop',
                 attempt_history = $4, claimed_by = NULL, claim_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $5 AND org_id = $6 AND claimed_by = $7`,
            [transactionId, targetState ?? null, JSON.stringify(fields), JSON.stringify(history), workOrderId, orgId, claimId],
          );
          return 'noop';
        }
        await this.dbService.db.query(
          `UPDATE integration_connector_work_orders
           SET transaction_id = $1, target_state = $2, fields = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND org_id = $5 AND claimed_by = $6`,
          [transactionId, targetState ?? null, JSON.stringify(fields), workOrderId, orgId, claimId],
        );
        translationInProgress = false;
      }

      const result = await adapter.pushUpdate(this.context(target), {
        entityType: work.target_entity_type,
        externalId: work.target_external_id,
        targetState,
        fields,
      });
      await this.syncGuardService.recordIntegrationWrite(orgId, {
        identity: { system: target.provider, entity_type: work.target_entity_type, immutable_id: work.target_external_id },
        service_account_id: `connector:${target.id}`,
        payload: { ...(targetState ? { state: targetState } : {}), ...(Object.keys(fields).length ? { fields } : {}) },
      });
      const history = this.appendAttempt(work.attempt_history, {
        attempt: attempts,
        startedAt,
        completedAt: new Date().toISOString(),
        outcome: 'executed',
      });
      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_connector_work_orders
           SET status = 'executed', executed_at = CURRENT_TIMESTAMP, last_error = NULL,
               next_attempt_at = NULL, attempt_history = $1, claimed_by = NULL,
               claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND org_id = $3 AND claimed_by = $4`,
          [JSON.stringify(history), workOrderId, orgId, claimId],
        );
        await tx.query(
          `UPDATE integration_canonical_twins twin SET sync_state = 'synced', updated_at = CURRENT_TIMESTAMP
           WHERE twin.id = $1 AND twin.org_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM integration_connector_work_orders blocked
               WHERE blocked.org_id = twin.org_id AND blocked.target_twin_id = twin.id
                 AND blocked.id <> $3 AND blocked.status IN ('dead', 'held')
             )`,
          [work.target_twin_id, orgId, workOrderId],
        );
        const operatorEdit = work.origin === 'operator_edit';
        return this.event(orgId, operatorEdit ? work.target_twin_id : workOrderId, `connector:${target.id}`,
          operatorEdit ? 'ConnectorOperatorStateWritten' : 'ConnectorWorkOrderExecuted', {
          work_order_id: workOrderId,
          transaction_id: transactionId,
          target_connector_id: target.id,
          target_twin_id: work.target_twin_id,
          target_external_id: work.target_external_id,
          target_state: targetState,
          ...(operatorEdit ? {
            twin_id: work.target_twin_id,
            identity: { system: target.provider, entity_type: work.target_entity_type, immutable_id: work.target_external_id },
            native_status: targetState,
            // Only the field the operator actually edited changed: a field-only edit must not
            // make executeWorkOrder attempt a state-mapping translation downstream, and a state
            // edit must not be mistaken for a field-mapping change with no fields to translate.
            state_changed: Boolean(targetState),
            fields_changed: Object.keys(fields).length > 0,
            updated_by: `connector:${target.id}`,
            fields: parseJson<any>(work.source_payload, {}).fields || {},
          } : {}),
          attempts,
          message: result.message,
        });
      });
      return 'executed';
    } catch (error) {
      if (error instanceof ConnectorLoadShedError) {
        await this.deferShedWork('integration_connector_work_orders', 'pending', orgId, workOrderId, claimId, error);
        return 'pending';
      }
      const message = this.describe(error, 'Connector write failed');
      const retryable = translationInProgress
        || (error instanceof ConnectorRemoteError && error.retryable)
        || error instanceof ConnectorCredentialError;
      const status: ConnectorWorkOrderStatus = retryable && attempts < MAX_WORK_ORDER_ATTEMPTS ? 'failed' : 'dead';
      const retryAfterMs = error instanceof ConnectorRemoteError && error.retryAfterSeconds
        ? error.retryAfterSeconds * 1000
        : Math.min(WORK_ORDER_BASE_BACKOFF_MS * 2 ** (attempts - 1), WORK_ORDER_MAX_BACKOFF_MS);
      const history = this.appendAttempt(work.attempt_history, {
        attempt: attempts,
        startedAt,
        completedAt: new Date().toISOString(),
        outcome: status === 'dead' ? 'dead_lettered' : 'retry_scheduled',
        error: message,
      });
      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_connector_work_orders
           SET status = $1, last_error = $2, next_attempt_at = $3, attempt_history = $4,
               claimed_by = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 AND org_id = $6 AND claimed_by = $7`,
          [
            status, message.slice(0, 500),
            status === 'failed' ? new Date(Date.now() + retryAfterMs).toISOString() : null,
            JSON.stringify(history), workOrderId, orgId, claimId,
          ],
        );
        if (status === 'dead') {
          await tx.query(
            `UPDATE integration_canonical_twins SET sync_state = 'paused', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND org_id = $2`,
            [work.target_twin_id, orgId],
          );
        }
        return this.event(orgId, workOrderId, `connector:${target.id}`, 'ConnectorWorkOrderFailed', {
          work_order_id: workOrderId,
          transaction_id: transactionId,
          target_connector_id: target.id,
          target_twin_id: work.target_twin_id,
          target_external_id: work.target_external_id,
          target_state: targetState,
          attempts,
          retryable,
          final: status === 'dead',
          error: message,
        });
      });
      return status;
    } finally {
      clearInterval(claimHeartbeat);
    }
  }

  public async listWorkOrders(orgId: string, connectorId: string): Promise<ConnectorWorkOrder[]> {
    await this.getConnector(orgId, connectorId);
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_connector_work_orders
       WHERE org_id = $1 AND (target_connector_id = $2 OR source_connector_id = $2)
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [orgId, connectorId],
    );
    return result.rows.map((row) => this.mapWorkOrder(row));
  }

  /** Twin-scoped DLQ surface for exhausted ingestion, translation, and provider-write work. */
  public async listTwinDeadLetters(orgId: string, connectorId: string): Promise<TwinQueueDeadLetter[]> {
    const connector = await this.getConnector(orgId, connectorId);
    const [ingestion, writes] = await Promise.all([
      this.dbService.db.query<any>(
        `SELECT * FROM integration_connector_ingestion_queue
         WHERE org_id = $1 AND connector_id = $2 AND status = 'dead'
         ORDER BY queue_position ASC`,
        [orgId, connectorId],
      ),
      this.dbService.db.query<any>(
        `SELECT w.*, t.provider, t.artifact_type
         FROM integration_connector_work_orders w
         JOIN integration_canonical_twins t ON t.id = w.target_twin_id AND t.org_id = w.org_id
         WHERE w.org_id = $1 AND w.target_connector_id = $2 AND w.status IN ('dead', 'held')
         ORDER BY w.queue_position ASC`,
        [orgId, connectorId],
      ),
    ]);
    const entries: TwinQueueDeadLetter[] = ingestion.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      connectorId: row.connector_id,
      twinId: row.twin_id || undefined,
      partitionKey: row.partition_key,
      kind: 'ingestion' as const,
      status: 'dead' as const,
      payload: parseJson(row.payload, {}),
      attempts: Number(row.attempts || 0),
      attemptHistory: parseJson(row.attempt_history, []),
      lastError: row.last_error || 'Ingestion failed',
      queuePosition: Number(row.queue_position || 0),
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    }));
    for (const row of writes.rows) {
      const translation = row.origin === 'state_propagation';
      entries.push({
        id: row.id,
        orgId: row.org_id,
        connectorId: row.target_connector_id,
        twinId: row.target_twin_id,
        partitionKey: this.twinPartitionKey(row.provider, row.artifact_type, row.target_external_id),
        kind: translation ? 'state_translation' : 'state_write',
        status: row.status,
        payload: translation
          ? { sourcePayload: parseJson(row.source_payload, {}), targetState: row.target_state, fields: parseJson(row.fields, {}) }
          : { targetState: row.target_state, fields: parseJson(row.fields, {}) },
        attempts: Number(row.attempts || 0),
        attemptHistory: parseJson(row.attempt_history, []),
        lastError: row.last_error || 'Queue entry requires operator review',
        queuePosition: Number(row.queue_position || 0),
        createdAt: iso(row.created_at)!,
        updatedAt: iso(row.updated_at)!,
      });
    }
    // The connector lookup above is also the tenant boundary; retain the value to make that
    // invariant explicit even when one side of the union is empty.
    void connector;
    return entries.sort((left, right) => left.queuePosition - right.queuePosition);
  }

  public async getTwinDeadLetter(orgId: string, connectorId: string, entryId: string): Promise<TwinQueueDeadLetter> {
    if (!isUuid(entryId)) throw new NotFoundException(`Twin queue entry ${entryId} not found`);
    const entry = (await this.listTwinDeadLetters(orgId, connectorId)).find((candidate) => candidate.id === entryId);
    if (!entry) throw new NotFoundException(`Twin queue entry ${entryId} not found`);
    return entry;
  }

  public async reinjectTwinDeadLetter(
    orgId: string,
    connectorId: string,
    entryId: string,
    correctedPayload: unknown,
    actorId = 'system',
  ): Promise<TwinQueueReinjectionResult> {
    const entry = await this.getTwinDeadLetter(orgId, connectorId, entryId);
    const connector = await this.getConnector(orgId, connectorId);
    if (correctedPayload !== undefined
      && (!correctedPayload || typeof correctedPayload !== 'object' || Array.isArray(correctedPayload))) {
      throw new BadRequestException('payload must be a JSON object when supplied');
    }
    const payload = correctedPayload as Record<string, unknown> | undefined;
    const now = new Date().toISOString();
    const replayAttempt: ConnectorQueueAttempt = {
      attempt: entry.attempts,
      startedAt: now,
      completedAt: now,
      outcome: 'requeued',
    };

    await this.withEvent(async (tx) => {
      if (entry.kind === 'ingestion') {
        const nextPayload = payload || entry.payload;
        const externalId = typeof nextPayload.externalId === 'string' ? nextPayload.externalId.trim() : '';
        const artifactType = typeof nextPayload.artifactType === 'string' ? nextPayload.artifactType.trim() : '';
        if (!externalId || !artifactType) {
          throw new BadRequestException('ingestion payload requires externalId and artifactType');
        }
        if (entry.payload.externalId && entry.payload.externalId !== externalId) {
          throw new BadRequestException('a corrected payload cannot change an existing immutable externalId');
        }
        if (entry.payload.artifactType && entry.payload.artifactType !== artifactType) {
          throw new BadRequestException('a corrected payload cannot change artifactType');
        }
        await tx.query(
          `UPDATE integration_connector_ingestion_queue
           SET payload = $1, external_id = $2, entity_type = $3, partition_key = $4,
               status = 'pending', attempts = 0, attempt_history = $5,
               last_error = NULL, next_attempt_at = NULL,
               completed_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $6 AND org_id = $7 AND connector_id = $8 AND status = 'dead'`,
          [
            JSON.stringify(nextPayload), externalId, artifactType,
            this.twinPartitionKey(connector.provider, artifactType, externalId),
            JSON.stringify([...entry.attemptHistory, replayAttempt]), entryId, orgId, connectorId,
          ],
        );
      } else {
        const targetState = payload?.targetState === undefined
          ? String(entry.payload.targetState || '')
          : String(payload.targetState).trim();
        if (!targetState) throw new BadRequestException('payload.targetState must be a non-empty string');
        const fields = payload?.fields === undefined ? entry.payload.fields || {} : payload.fields;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          throw new BadRequestException('payload.fields must be a JSON object');
        }
        const sourcePayload = entry.kind === 'state_translation'
          ? (payload?.sourcePayload === undefined ? entry.payload.sourcePayload : payload.sourcePayload)
          : {};
        if (entry.kind === 'state_translation'
          && (!sourcePayload || typeof sourcePayload !== 'object' || Array.isArray(sourcePayload))) {
          throw new BadRequestException('payload.sourcePayload must be a JSON object');
        }
        if (entry.kind === 'state_translation') {
          const beforeIdentity = (entry.payload.sourcePayload as any)?.identity;
          const afterIdentity = (sourcePayload as any)?.identity;
          if (beforeIdentity && stableStringify(beforeIdentity) !== stableStringify(afterIdentity)) {
            throw new BadRequestException('a corrected payload cannot change its immutable source identity');
          }
        }
        await tx.query(
          `UPDATE integration_connector_work_orders
           SET source_payload = $1, target_state = $2, fields = $3,
               transaction_id = CASE WHEN origin = 'state_propagation' THEN NULL ELSE transaction_id END,
               status = 'pending', attempts = 0, attempt_history = $4, last_error = NULL,
               next_attempt_at = NULL, claimed_by = NULL, claim_expires_at = NULL,
               executed_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 AND org_id = $6 AND target_connector_id = $7 AND status IN ('dead', 'held')`,
          [
            JSON.stringify(sourcePayload || {}), targetState, JSON.stringify(fields),
            JSON.stringify([...entry.attemptHistory, replayAttempt]), entryId, orgId, connectorId,
          ],
        );
      }
      if (entry.twinId) {
        await tx.query(
          `UPDATE integration_canonical_twins SET sync_state = 'synced', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND org_id = $2`,
          [entry.twinId, orgId],
        );
      }
      return this.event(orgId, entryId, actorId, 'TwinQueueEntryReinjected', {
        queue_entry_id: entryId,
        connector_id: connectorId,
        twin_id: entry.twinId || null,
        partition_key: entry.partitionKey,
        kind: entry.kind,
        corrected: payload !== undefined,
      });
    });
    return {
      entryId,
      kind: entry.kind,
      status: 'pending',
      requeued: true,
      message: `Queue entry ${entryId} was re-injected at its original FIFO position`,
    };
  }

  private mapWorkOrder(row: any): ConnectorWorkOrder {
    return {
      id: row.id,
      orgId: row.org_id,
      transactionId: row.transaction_id || null,
      origin: row.origin || 'state_translation',
      requestedBy: row.requested_by || undefined,
      sourceConnectorId: row.source_connector_id,
      targetConnectorId: row.target_connector_id,
      targetTwinId: row.target_twin_id,
      targetEntityType: row.target_entity_type,
      targetExternalId: row.target_external_id,
      targetState: row.target_state,
      fields: parseJson(row.fields, {}),
      status: row.status,
      attempts: Number(row.attempts || 0),
      sourceEventId: row.source_event_id || undefined,
      queuePosition: Number(row.queue_position || 0),
      attemptHistory: parseJson(row.attempt_history, []),
      lastError: row.last_error || undefined,
      nextAttemptAt: iso(row.next_attempt_at),
      executedAt: iso(row.executed_at),
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  // ─── Operational visibility ────────────────────────────────────────────────

  /** Tenant-scoped quota, retry and durable queue telemetry grouped by provider target. */
  public async getRateGovernanceMetrics(orgId: string): Promise<ConnectorRateGovernanceMetrics[]> {
    const connectors = await this.listConnectors(orgId);
    const stored = await this.rateGovernor.listStoredMetrics(orgId);
    const byTarget = new Map(stored.map((metric) => [metric.targetKey, metric]));
    const groups = new Map<string, ConnectorRecord[]>();
    for (const connector of connectors) {
      let descriptor;
      try {
        descriptor = this.rateGovernor.describe(connector);
      } catch (error) {
        if (error instanceof ConnectorConfigurationError) continue;
        throw error;
      }
      const group = groups.get(descriptor.targetKey) || [];
      group.push(connector);
      groups.set(descriptor.targetKey, group);
      if (!byTarget.has(descriptor.targetKey)) {
        byTarget.set(descriptor.targetKey, this.rateGovernor.emptyMetric(orgId, connector));
      }
    }

    const backlog = await this.dbService.db.query<any>(
      `SELECT connector_id,
              SUM(queued)::int AS queued, SUM(failed)::int AS failed,
              SUM(ingestion)::int AS ingestion, SUM(work_orders)::int AS work_orders,
              SUM(comments)::int AS comments, SUM(backfill_chunks)::int AS backfill_chunks
       FROM (
         SELECT connector_id,
                CASE WHEN status IN ('pending', 'retry', 'processing') THEN 1 ELSE 0 END AS queued,
                CASE WHEN status = 'dead' THEN 1 ELSE 0 END AS failed,
                1 AS ingestion, 0 AS work_orders, 0 AS comments, 0 AS backfill_chunks
         FROM integration_connector_ingestion_queue WHERE org_id = $1 AND status <> 'completed'
         UNION ALL
         SELECT target_connector_id,
                CASE WHEN status IN ('pending', 'processing', 'failed') THEN 1 ELSE 0 END,
                CASE WHEN status IN ('dead', 'held') THEN 1 ELSE 0 END,
                0, 1, 0, 0
         FROM integration_connector_work_orders WHERE org_id = $1 AND status NOT IN ('executed', 'noop')
         UNION ALL
         SELECT target_connector_id,
                CASE WHEN status IN ('pending', 'processing', 'failed') THEN 1 ELSE 0 END,
                CASE WHEN status = 'dead' THEN 1 ELSE 0 END,
                0, 0, 1, 0
         FROM integration_comment_deliveries WHERE org_id = $1 AND status <> 'executed'
         UNION ALL
         SELECT j.connector_id,
                CASE WHEN c.status IN ('pending', 'running') THEN 1 ELSE 0 END,
                CASE WHEN c.status = 'failed' THEN 1 ELSE 0 END,
                0, 0, 0, 1
         FROM integration_backfill_chunks c
         JOIN integration_backfill_jobs j ON j.id = c.job_id
         WHERE j.org_id = $1 AND c.status <> 'done'
       ) q GROUP BY connector_id`,
      [orgId],
    );
    const byConnector = new Map(backlog.rows.map((row) => [row.connector_id, row]));
    const metrics: ConnectorRateGovernanceMetrics[] = [];
    for (const [targetKey, targetConnectors] of groups) {
      const base = byTarget.get(targetKey)!;
      const totals = { queued: 0, failed: 0, ingestion: 0, workOrders: 0, comments: 0, backfillChunks: 0 };
      for (const connector of targetConnectors) {
        const row = byConnector.get(connector.id) as any;
        if (!row) continue;
        totals.queued += Number(row.queued || 0);
        totals.failed += Number(row.failed || 0);
        totals.ingestion += Number(row.ingestion || 0);
        totals.workOrders += Number(row.work_orders || 0);
        totals.comments += Number(row.comments || 0);
        totals.backfillChunks += Number(row.backfill_chunks || 0);
      }
      metrics.push({
        ...base,
        connectors: targetConnectors.map(({ id, name, provider }) => ({ id, name, provider })),
        backlog: totals,
      });
    }
    return metrics.sort((left, right) => left.targetOrigin.localeCompare(right.targetOrigin));
  }

  public async getHealth(orgId: string, connectorId: string): Promise<ConnectorHealth> {
    const connector = await this.getConnector(orgId, connectorId);
    const [twins, cursors, orders] = await Promise.all([
      this.dbService.db.query<any>(
        `SELECT COUNT(*)::int AS count FROM integration_canonical_twins WHERE org_id = $1 AND connector_id = $2`,
        [orgId, connectorId],
      ),
      this.dbService.db.query<any>(
        `SELECT entity_type, cursor_value, updated_at FROM integration_connector_cursors
         WHERE connector_id = $1 ORDER BY entity_type`,
        [connectorId],
      ),
      this.dbService.db.query<any>(
        `SELECT status, COUNT(*)::int AS count FROM integration_connector_work_orders
         WHERE org_id = $1 AND target_connector_id = $2 GROUP BY status`,
        [orgId, connectorId],
      ),
    ]);
    const workOrders: Record<ConnectorWorkOrderStatus, number> = {
      pending: 0, processing: 0, executed: 0, failed: 0, dead: 0, held: 0, noop: 0,
    };
    for (const row of orders.rows) workOrders[row.status as ConnectorWorkOrderStatus] = Number(row.count);
    const paused = await this.dbService.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT 'write:' || target_twin_id::text AS partition
         FROM integration_connector_work_orders
         WHERE org_id = $1 AND target_connector_id = $2 AND status IN ('dead', 'held')
         UNION
         SELECT 'ingest:' || partition_key AS partition
         FROM integration_connector_ingestion_queue
         WHERE org_id = $1 AND connector_id = $2 AND status = 'dead'
       ) paused`,
      [orgId, connectorId],
    );
    return {
      connectorId,
      provider: connector.provider,
      status: connector.status,
      activatedAt: connector.activatedAt,
      lastSyncedAt: connector.lastSyncedAt,
      lastSuccessAt: connector.lastSuccessAt,
      secondsSinceLastSuccess: connector.lastSuccessAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(connector.lastSuccessAt)) / 1000))
        : null,
      syncLagSeconds: connector.syncLagSeconds,
      consecutiveFailures: connector.consecutiveFailures,
      errorMessage: connector.errorMessage,
      twinCount: Number(twins.rows[0]?.count || 0),
      cursors: cursors.rows.map((row) => ({ entityType: row.entity_type, cursorValue: row.cursor_value, updatedAt: iso(row.updated_at) })),
      workOrders,
      pausedTwinQueues: Number(paused.rows[0]?.count || 0),
    };
  }

  public async listTwins(orgId: string, connectorId?: string): Promise<CanonicalTwin[]> {
    await this.dbService.initialize();
    if (connectorId) await this.getConnector(orgId, connectorId);
    const params: unknown[] = [orgId];
    let query = `SELECT * FROM integration_canonical_twins WHERE org_id = $1`;
    if (connectorId) {
      query += ` AND connector_id = $2`;
      params.push(connectorId);
    }
    query += ` ORDER BY updated_at DESC, id ASC LIMIT 500`;
    const result = await this.dbService.db.query<any>(query, params);
    return result.rows.map((row) => this.mapTwin(row));
  }

  private mapTwin(row: any): CanonicalTwin {
    return {
      id: row.id,
      orgId: row.org_id,
      connectorId: row.connector_id,
      provider: row.provider,
      artifactType: row.artifact_type,
      externalId: row.external_id,
      nativeKey: row.native_key || undefined,
      nativeUrl: row.native_url || undefined,
      title: row.title || undefined,
      status: row.native_status || undefined,
      syncState: row.sync_state,
      fieldAuthority: parseJson(row.field_authority, {}),
      payload: parseJson(row.payload, {}),
      correlationNodeId: row.correlation_node_id || undefined,
      sourceUpdatedAt: iso(row.source_updated_at),
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  // ─── Connector-led workspace (US20.2) ─────────────────────────────────────

  public async getWorkspaceOverview(orgId: string): Promise<WorkspaceOverview> {
    const connectors = await this.listConnectors(orgId);
    const sources = await Promise.all(connectors.map(async (connector) => ({
      ...(await this.getHealth(orgId, connector.id)),
      name: connector.name,
    })));
    const attention = sources.filter((source) =>
      ['error', 'degraded'].includes(source.status)
        || source.workOrders.dead > 0 || source.workOrders.held > 0 || source.workOrders.failed > 0);
    return {
      sources,
      totals: {
        sources: sources.length,
        healthy: sources.filter((source) => source.status === 'active' && !attention.includes(source)).length,
        attention: attention.length,
        twins: sources.reduce((sum, source) => sum + source.twinCount, 0),
        maxLagSeconds: sources.reduce((max, source) => Math.max(max, source.syncLagSeconds), 0),
        queuedWrites: sources.reduce((sum, source) =>
          sum + source.workOrders.pending + source.workOrders.processing + source.workOrders.failed, 0),
        failedWrites: sources.reduce((sum, source) => sum + source.workOrders.dead + source.workOrders.held, 0),
      },
    };
  }

  public async listTwinWorkspace(orgId: string): Promise<TwinWorkspaceRow[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT t.*, c.name AS connector_name, c.status AS connector_status, c.last_success_at AS connector_last_success_at,
              wi.id AS wi_id, wi.item_key AS wi_key, wi.type AS wi_type, wi.status AS wi_status, wi.aging_bucket AS wi_aging_bucket,
              wi.aging_score AS wi_aging_score, wi.escalated_at AS wi_escalated_at, wi.entered_state_at AS wi_entered_state_at,
              wi.team_id AS wi_team_id, wi.owner_id AS wi_owner_id,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status IN ('pending', 'processing', 'failed')) AS queued_writes,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status IN ('dead', 'held')) AS failed_writes
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
       LEFT JOIN work_items wi ON wi.org_id = t.org_id AND wi.source_twin_id = t.id
       WHERE t.org_id = $1
       ORDER BY t.updated_at DESC, t.id ASC
       LIMIT 500`,
      [orgId],
    );
    const counterparts = await this.counterpartsFor(orgId, result.rows.map((row) => row.correlation_node_id).filter(Boolean));
    return result.rows.map((row) => this.mapWorkspaceRow(row, counterparts));
  }

  public async getTwinDetail(orgId: string, twinId: string): Promise<TwinDetail> {
    await this.dbService.initialize();
    if (!isUuid(twinId)) throw new NotFoundException(`Twin ${twinId} not found`);
    const rows = await this.listTwinWorkspaceRows(orgId, twinId);
    if (!rows.length) throw new NotFoundException(`Twin ${twinId} not found`);
    const row = rows[0];
    const connector = await this.getConnector(orgId, row.connectorId);
    const orders = await this.dbService.db.query<any>(
      `SELECT * FROM integration_connector_work_orders
       WHERE org_id = $1 AND target_twin_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 25`,
      [orgId, twinId],
    );
    const relatedTwinIds = [twinId, ...row.counterparts.map((counterpart) => counterpart.twinId).filter(Boolean)] as string[];
    const comments = await this.listPublicComments(orgId, relatedTwinIds);
    return {
      ...row,
      fields: this.fieldPolicies(row, connector),
      workOrders: orders.rows.map((order) => this.mapWorkOrder(order)),
      comments,
    };
  }

  private async listPublicComments(orgId: string, twinIds: string[]): Promise<TwinPublicComment[]> {
    if (!twinIds.length) return [];
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_public_comments
       WHERE org_id = $1 AND source_twin_id = ANY($2::uuid[])
       ORDER BY source_created_at ASC, id ASC LIMIT 1000`,
      [orgId, twinIds],
    );
    return result.rows.map((comment) => ({
      id: comment.id,
      sourceTwinId: comment.source_twin_id,
      sourceConnectorId: comment.source_connector_id,
      providerCommentId: comment.provider_comment_id,
      body: comment.body,
      originalAuthorId: comment.original_author_id,
      originalAuthorName: comment.original_author_name,
      sourceSystem: comment.source_system,
      sourceCreatedAt: iso(comment.source_created_at)!,
      nativeUrl: comment.native_url || undefined,
      readOnly: true as const,
    }));
  }

  /**
   * Governed edit of an externally owned field. Nothing is stored locally: a permitted change
   * becomes an audited connector work order against the owning system, and a refused change is
   * audited and explained. There is no path that leaves the twin silently diverged.
   */
  public async routeTwinEdit(
    orgId: string,
    twinId: string,
    input: { field?: unknown; value?: unknown },
    actorId = 'system',
  ): Promise<TwinEditResult> {
    const twin = await this.getTwinDetail(orgId, twinId);
    const requested = typeof input?.field === 'string' ? input.field.trim() : '';
    if (!requested) throw new BadRequestException('field is required');
    if (typeof input?.value !== 'string' || !input.value.trim()) throw new BadRequestException('value must be a non-empty string');
    const field = twin.fields.find((candidate) =>
      candidate.field === requested || candidate.nativeField === requested || (requested === 'status' && candidate.field === 'state'));
    const policy: TwinFieldPolicy = field || {
      field: requested,
      nativeField: requested,
      label: requested,
      value: undefined,
      authority: twin.provider,
      editable: false,
      reason: 'no_outbound_mapping',
      message: `${providerName(twin.provider)} owns '${requested}'. Cadena has no outbound mapping for it; change it in ${providerName(twin.provider)}.`,
    };

    if (!policy.editable) {
      await this.withEvent(async () => this.event(orgId, twinId, actorId, 'TwinEditBlocked', {
        twin_id: twinId,
        connector_id: twin.connectorId,
        field: policy.field,
        authority: policy.authority,
        reason: policy.reason,
      }));
      throw new UnprocessableEntityException({
        statusCode: 422,
        decision: 'blocked',
        field: policy.field,
        authority: policy.authority,
        reason: policy.reason,
        message: policy.message,
      });
    }

    // An enumerated field (state, or a field whose discovered schema has allowed values) must
    // match one of them exactly; a free-text field accepts the trimmed value as given.
    const requestedValue = String(input.value).trim();
    const value = policy.allowedValues
      ? policy.allowedValues.find((candidate) => sameState(candidate, requestedValue)) || null
      : requestedValue;
    if (!value) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        decision: 'blocked',
        field: policy.field,
        reason: 'invalid_value',
        message: `'${requestedValue}' is not a ${providerName(twin.provider)} ${policy.label.toLowerCase()}. Allowed: ${(policy.allowedValues || []).join(', ')}`,
      });
    }
    const isState = policy.field === 'state';
    const currentValue = isState ? twin.status : (twin.payload[policy.nativeField] ?? null);
    const empty = { prepared: 0, executed: 0, held: 0 };
    if (isState ? sameState(currentValue, value) : stableStringify(currentValue ?? null) === stableStringify(value)) {
      return { decision: 'noop', twinId, field: policy.field, value, propagation: empty, message: `${twin.nativeKey || twin.externalId} already has ${policy.label} = ${value}` };
    }

    const workOrderId = randomUUID();
    const editedFields = isState ? twin.payload : { ...twin.payload, [policy.nativeField]: value };
    await this.withEvent(async (tx) => {
      await tx.query(
        `INSERT INTO integration_connector_work_orders
         (id, org_id, transaction_id, origin, requested_by, source_payload, source_connector_id,
          target_connector_id, target_twin_id, target_entity_type, target_external_id, target_state,
          fields, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'operator_edit', $3, $4, NULL, $5, $6, $7, $8, $9,
                 $10, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          workOrderId, orgId, actorId, JSON.stringify({ title: twin.title || '', fields: editedFields }),
          twin.connectorId, twinId, twin.artifactType, twin.externalId, isState ? value : null,
          JSON.stringify(isState ? {} : { [policy.nativeField]: value }),
        ],
      );
      return this.event(orgId, twinId, actorId, 'TwinEditRouted', {
        twin_id: twinId,
        work_order_id: workOrderId,
        connector_id: twin.connectorId,
        field: policy.field,
        before: currentValue,
        after: value,
      });
    });

    const outcome = await this.executeWorkOrder(orgId, workOrderId);
    const propagation = { ...empty };
    if (outcome === 'executed') {
      const counters: PollCounters = {
        twinsCreated: 0, twinsUpdated: 0, twinsUnchanged: 0, echoesSuppressed: 0,
        workOrdersPrepared: 0, workOrdersHeld: 0, workOrdersExecuted: 0, workOrdersFailed: 0,
        commentsFetched: 0, commentsStored: 0, commentsFiltered: 0, commentsTransferred: 0, commentsFailed: 0,
      };
      const emitted = await this.dbService.db.query<any>(
        `SELECT event_id FROM domain_events
         WHERE org_id = $1 AND event_type = 'ConnectorOperatorStateWritten'
           AND payload ->> 'work_order_id' = $2
         ORDER BY occurred_at DESC LIMIT 1`,
        [orgId, workOrderId],
      );
      if (emitted.rows[0]?.event_id) await this.addPropagationCounters(emitted.rows[0].event_id, counters);
      propagation.prepared = counters.workOrdersPrepared;
      propagation.executed = counters.workOrdersExecuted;
      propagation.held = counters.workOrdersHeld;
    }
    const [order] = (await this.dbService.db.query<any>(
      `SELECT * FROM integration_connector_work_orders WHERE id = $1 AND org_id = $2`,
      [workOrderId, orgId],
    )).rows.map((row) => this.mapWorkOrder(row));
    const where = providerName(twin.provider);
    const message = outcome === 'executed'
      ? `${where} accepted ${twin.nativeKey || twin.externalId} → ${value}; the twin refreshes on the next synchronization`
      : outcome === 'failed'
        ? `${where} did not accept the change yet; it will be retried (${order?.lastError || 'provider error'})`
      : outcome === 'dead'
        ? `${where} refused the change: ${order?.lastError || 'provider error'}`
        : outcome === 'held'
          ? `The change is paused for operator review: ${order?.lastError || 'translation requires correction'}`
          : `The change is queued behind earlier work for ${twin.nativeKey || twin.externalId}`;
    return { decision: 'routed', twinId, field: policy.field, value, workOrder: order, propagation, message };
  }

  private async listTwinWorkspaceRows(orgId: string, twinId: string): Promise<TwinWorkspaceRow[]> {
    const result = await this.dbService.db.query<any>(
      `SELECT t.*, c.name AS connector_name, c.status AS connector_status, c.last_success_at AS connector_last_success_at,
              wi.id AS wi_id, wi.item_key AS wi_key, wi.type AS wi_type, wi.status AS wi_status, wi.aging_bucket AS wi_aging_bucket,
              wi.aging_score AS wi_aging_score, wi.escalated_at AS wi_escalated_at, wi.entered_state_at AS wi_entered_state_at,
              wi.team_id AS wi_team_id, wi.owner_id AS wi_owner_id,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status IN ('pending', 'processing', 'failed')) AS queued_writes,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status IN ('dead', 'held')) AS failed_writes
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
       LEFT JOIN work_items wi ON wi.org_id = t.org_id AND wi.source_twin_id = t.id
       WHERE t.org_id = $1 AND t.id = $2`,
      [orgId, twinId],
    );
    const counterparts = await this.counterpartsFor(orgId, result.rows.map((row) => row.correlation_node_id).filter(Boolean));
    return result.rows.map((row) => this.mapWorkspaceRow(row, counterparts));
  }

  private mapWorkspaceRow(row: any, counterparts: Map<string, TwinCounterpart[]>): TwinWorkspaceRow {
    return {
      ...this.mapTwin(row),
      connectorName: row.connector_name,
      connectorStatus: row.connector_status,
      lastSuccessAt: iso(row.connector_last_success_at),
      counterparts: counterparts.get(row.correlation_node_id) || [],
      queuedWrites: Number(row.queued_writes || 0),
      failedWrites: Number(row.failed_writes || 0),
      projection: {
        status: row.projection_status || 'pending',
        reason: row.projection_reason || undefined,
        workItemId: row.wi_id || undefined,
        workItemKey: row.wi_key || undefined,
        workItemType: row.wi_type || undefined,
        agingBucket: row.wi_id ? (row.wi_aging_bucket || 'green') : undefined,
        agingScore: row.wi_id ? Number(row.wi_aging_score || 0) : undefined,
        escalatedAt: iso(row.wi_escalated_at),
        enteredStateAt: iso(row.wi_entered_state_at),
        teamId: row.wi_team_id || undefined,
        ownerId: row.wi_owner_id || undefined,
      },
    };
  }

  private async counterpartsFor(orgId: string, nodeIds: string[]): Promise<Map<string, TwinCounterpart[]>> {
    const byNode = new Map<string, TwinCounterpart[]>();
    if (!nodeIds.length) return byNode;
    const result = await this.dbService.db.query<any>(
      `SELECT pair.own_id, n.id AS node_id, n.system, n.entity_type, n.immutable_id, n.display_key, n.url,
              t.id AS twin_id, t.native_status
       FROM (
         SELECT source_node_id AS own_id, target_node_id AS other_id FROM integration_correlation_links
          WHERE org_id = $1 AND relationship = 'counterpart' AND source_node_id = ANY($2::uuid[])
         UNION
         SELECT target_node_id AS own_id, source_node_id AS other_id FROM integration_correlation_links
          WHERE org_id = $1 AND relationship = 'counterpart' AND target_node_id = ANY($2::uuid[])
       ) pair
       JOIN integration_correlation_nodes n ON n.org_id = $1 AND n.id = pair.other_id
       LEFT JOIN integration_canonical_twins t ON t.org_id = n.org_id AND t.correlation_node_id = n.id
       ORDER BY n.system, n.display_key`,
      [orgId, nodeIds],
    );
    for (const row of result.rows) {
      const list = byNode.get(row.own_id) || [];
      if (!list.some((item) => item.nodeId === row.node_id)) {
        list.push({
          nodeId: row.node_id,
          system: row.system,
          entityType: row.entity_type,
          immutableId: row.immutable_id,
          displayKey: row.display_key || null,
          url: row.url || null,
          twinId: row.twin_id || undefined,
          status: row.native_status || undefined,
        });
      }
      byNode.set(row.own_id, list);
    }
    return byNode;
  }

  private fieldPolicies(twin: TwinWorkspaceRow, connector: ConnectorRecord): TwinFieldPolicy[] {
    const provider = providerName(twin.provider);
    const entity = connector.discoveryMetadata?.entities?.find((candidate) => candidate.entityType === twin.artifactType);
    const nativeState = twin.provider === 'servicenow' ? 'state' : 'status';
    const stateSchema = entity?.fields.find((field) => field.id === nativeState);
    const writeBack = (connector.config.writeBack || {}) as ConnectorWriteBackPolicy;
    const available = Boolean(connector.activatedAt) && ['active', 'degraded'].includes(connector.status);
    const canWrite = connector.discoveryMetadata?.supportedCapabilities?.includes('state_write') ?? false;

    let reason: TwinFieldPolicy['reason'] = 'write_back_enabled';
    let message = `Changes are written to ${provider} through an audited connector work order.`;
    if (!writeBack.state) {
      reason = 'write_back_disabled';
      message = `${provider} owns this state. State write-back is disabled for ${connector.name}; change it in ${provider} or ask an administrator to enable write-back.`;
    } else if (!canWrite) {
      reason = 'capability_missing';
      message = `${connector.name} cannot write states back to ${provider}.`;
    } else if (!stateSchema?.allowedValues?.length) {
      reason = 'state_values_unknown';
      message = `No ${provider} state values were discovered for ${twin.artifactType}; run discovery before editing.`;
    } else if (!available) {
      reason = 'connector_unavailable';
      message = `${connector.name} is ${connector.status}; state changes are refused until it is active.`;
    }
    const policies: TwinFieldPolicy[] = [{
      field: 'state',
      nativeField: nativeState,
      label: 'State',
      value: twin.status,
      authority: twin.fieldAuthority[nativeState] || twin.provider,
      editable: reason === 'write_back_enabled',
      reason,
      message,
      ...(stateSchema?.allowedValues?.length ? { allowedValues: stateSchema.allowedValues } : {}),
    }];
    const writableFields = new Set(writeBack.fields || []);
    for (const [fieldId, authority] of Object.entries(twin.fieldAuthority)) {
      if (fieldId === nativeState) continue;
      const schema = entity?.fields.find((field) => field.id === fieldId);
      if (writableFields.has(fieldId)) {
        // Same self-write gates as state (capability, availability), plus this specific field
        // must be in the connector's own writeBack.fields allow-list — never on by default.
        let fieldReason: TwinFieldPolicy['reason'] = 'write_back_enabled';
        let fieldMessage = `Changes are written to ${provider} through an audited connector work order.`;
        if (!canWrite) {
          fieldReason = 'capability_missing';
          fieldMessage = `${connector.name} cannot write fields back to ${provider}.`;
        } else if (!available) {
          fieldReason = 'connector_unavailable';
          fieldMessage = `${connector.name} is ${connector.status}; field changes are refused until it is active.`;
        }
        policies.push({
          field: fieldId,
          nativeField: fieldId,
          label: schema?.name || fieldId,
          value: twin.payload[fieldId] ?? null,
          authority,
          editable: fieldReason === 'write_back_enabled',
          reason: fieldReason,
          message: fieldMessage,
          ...(schema?.allowedValues?.length ? { allowedValues: schema.allowedValues } : {}),
        });
        continue;
      }
      policies.push({
        field: fieldId,
        nativeField: fieldId,
        label: schema?.name || fieldId,
        value: twin.payload[fieldId] ?? null,
        authority,
        editable: false,
        reason: 'no_outbound_mapping',
        message: `${providerName(authority)} owns ${schema?.name || fieldId}. Cadena has no outbound mapping for it; change it in ${providerName(authority)}.`,
      });
    }
    return policies;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async acquireSyncLease(orgId: string, connectorId: string, leaseOwner: string): Promise<boolean> {
    const result = await this.dbService.db.query<any>(
      `INSERT INTO integration_connector_sync_leases
       (connector_id, org_id, lease_owner, acquired_at, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
       ON CONFLICT (connector_id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         lease_owner = EXCLUDED.lease_owner,
         acquired_at = CURRENT_TIMESTAMP,
         expires_at = EXCLUDED.expires_at
       WHERE integration_connector_sync_leases.org_id = EXCLUDED.org_id
         AND integration_connector_sync_leases.expires_at <= CURRENT_TIMESTAMP
       RETURNING connector_id`,
      [connectorId, orgId, leaseOwner, new Date(Date.now() + SYNC_LEASE_MS).toISOString()],
    );
    return result.rows.length > 0;
  }

  private async releaseSyncLease(connectorId: string, leaseOwner: string): Promise<void> {
    await this.dbService.db.query(
      `DELETE FROM integration_connector_sync_leases WHERE connector_id = $1 AND lease_owner = $2`,
      [connectorId, leaseOwner],
    );
  }

  private async renewSyncLease(connectorId: string, leaseOwner: string): Promise<void> {
    await this.dbService.db.query(
      `UPDATE integration_connector_sync_leases SET expires_at = $1
       WHERE connector_id = $2 AND lease_owner = $3`,
      [new Date(Date.now() + SYNC_LEASE_MS).toISOString(), connectorId, leaseOwner],
    );
  }

  private async renewWorkOrderClaim(workOrderId: string, claimId: string): Promise<void> {
    await this.dbService.db.query(
      `UPDATE integration_connector_work_orders SET claim_expires_at = $1
       WHERE id = $2 AND claimed_by = $3 AND status = 'processing'`,
      [new Date(Date.now() + WORK_ORDER_CLAIM_MS).toISOString(), workOrderId, claimId],
    );
  }

  private twinPartitionKey(provider: string, entityType: string, externalId: string): string {
    return `${provider.toLowerCase()}:${entityType.toLowerCase()}:${externalId}`;
  }

  private appendAttempt(value: unknown, attempt: ConnectorQueueAttempt): ConnectorQueueAttempt[] {
    const history = parseJson<ConnectorQueueAttempt[]>(value, []);
    return [...history, attempt];
  }

  private capabilityReport(
    adapter: ConnectorAdapter,
    config: Record<string, unknown>,
    discovery: ConnectorDiscoveryResult,
  ): ConnectorCapabilityReport {
    const limitations: ConnectorLimitation[] = [];
    for (const scope of discovery.scopes || []) {
      if (!scope.found) {
        limitations.push({
          code: 'scope_not_found',
          severity: 'blocking',
          entityType: scope.entityType,
          message: `${adapter.descriptor.scopeLabel.replace(/s$/, '')} '${scope.id}' was not found or is not visible to the integration account`,
        });
      }
    }
    const missingScopes = new Set((discovery.scopes || []).filter((scope) => !scope.found).map((scope) => scope.entityType));
    for (const capability of ['incremental_query', 'state_write'] as const) {
      if (!discovery.supportedCapabilities.includes(capability)) {
        limitations.push({
          code: 'capability_missing',
          severity: capability === 'incremental_query' ? 'blocking' : 'warning',
          message: `${adapter.descriptor.displayName} does not support ${capability.replace('_', ' ')}`,
        });
      }
    }
    for (const entityType of adapter.entityTypes(config)) {
      const entity = discovery.entities.find((candidate) => candidate.entityType === entityType);
      if (!entity) {
        if (!missingScopes.has(entityType)) {
          limitations.push({ code: 'scope_not_found', severity: 'blocking', entityType, message: `Entity type '${entityType}' was not discovered` });
        }
        continue;
      }
      const state = entity.fields.find((field) => field.id === 'status' || field.id === 'state');
      if (!state?.allowedValues?.length) {
        limitations.push({
          code: 'state_values_unknown',
          severity: 'warning',
          entityType,
          field: state?.id,
          message: `No state values were discovered for ${entityType}; state translation writes may be refused`,
        });
      }
    }
    const requiredFields = (config.requiredFields || {}) as Record<string, string[]>;
    for (const [entityType, fieldIds] of Object.entries(requiredFields)) {
      const entity = discovery.entities.find((candidate) => candidate.entityType === entityType);
      if (!entity) {
        limitations.push({
          code: 'scope_not_found',
          severity: 'blocking',
          entityType,
          message: `Required fields reference entity type '${entityType}', which this connector does not expose`,
        });
        continue;
      }
      for (const fieldId of fieldIds) {
        if (!entity.fields.some((field) => field.id === fieldId)) {
          limitations.push({
            code: 'field_not_found',
            severity: 'blocking',
            entityType,
            field: fieldId,
            message: `Required field '${fieldId}' does not exist on ${entityType}`,
          });
        }
      }
    }
    for (const warning of discovery.warnings || []) {
      limitations.push({ code: 'provider_warning', severity: 'warning', message: warning });
    }
    return {
      ready: !limitations.some((item) => item.severity === 'blocking'),
      limitations,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private context(connector: ConnectorRecord): ConnectorContext {
    return {
      connector,
      baseUrl: String(connector.config.baseUrl || ''),
      credentials: this.secrets.resolveAll(connector.config.credentials as Record<string, string>),
    };
  }

  private validateOptions(options: unknown): Record<string, unknown> {
    if (options === undefined || options === null) return {};
    if (typeof options !== 'object' || Array.isArray(options)) throw new ConnectorConfigurationError('options must be an object');
    for (const key of Object.keys(options)) {
      if (SECRET_LIKE_OPTION.test(key)) {
        throw new ConnectorCredentialError(`options.${key} looks like a secret; supply it as a secret reference in credentials`);
      }
    }
    return JSON.parse(JSON.stringify(options));
  }

  private validateWriteBack(input: unknown): ConnectorWriteBackPolicy {
    if (input === undefined || input === null) return { state: false, fields: [] };
    if (typeof input !== 'object' || Array.isArray(input)) throw new ConnectorConfigurationError('writeBack must be an object');
    const unknown = Object.keys(input).filter((key) => !['state', 'fields'].includes(key));
    if (unknown.length) {
      throw new ConnectorConfigurationError(`writeBack supports only 'state' and 'fields'; no outbound mapping exists for ${unknown.join(', ')}`);
    }
    const state = (input as Record<string, unknown>).state;
    if (state !== undefined && typeof state !== 'boolean') throw new ConnectorConfigurationError('writeBack.state must be true or false');
    return { state: state === true, fields: stringList((input as Record<string, unknown>).fields) };
  }

  private validateCommentSync(input: unknown): ConnectorCommentSyncPolicy {
    if (input === undefined || input === null) {
      return { enabled: false, direction: 'bidirectional', authorAllowList: [], authorBlockList: [] };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new ConnectorConfigurationError('commentSync must be an object');
    }
    const value = input as Record<string, unknown>;
    const unknown = Object.keys(value).filter(
      (key) => !['enabled', 'direction', 'authorAllowList', 'authorBlockList'].includes(key),
    );
    if (unknown.length) throw new ConnectorConfigurationError(`commentSync does not support ${unknown.join(', ')}`);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
      throw new ConnectorConfigurationError('commentSync.enabled must be true or false');
    }
    const direction = value.direction === undefined ? 'bidirectional' : String(value.direction);
    if (!['from_source', 'to_source', 'bidirectional'].includes(direction)) {
      throw new ConnectorConfigurationError('commentSync.direction must be from_source, to_source or bidirectional');
    }
    for (const key of ['authorAllowList', 'authorBlockList']) {
      if (value[key] !== undefined && !Array.isArray(value[key])) {
        throw new ConnectorConfigurationError(`commentSync.${key} must be an array of stable provider account ids`);
      }
    }
    return {
      enabled: value.enabled === true,
      direction: direction as ConnectorCommentSyncPolicy['direction'],
      authorAllowList: stringList(value.authorAllowList),
      authorBlockList: stringList(value.authorBlockList),
    };
  }

  private validateRequiredFields(input: unknown): Record<string, string[]> | undefined {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new ConnectorConfigurationError('requiredFields must map entity types to field id arrays');
    }
    const result: Record<string, string[]> = {};
    for (const [entityType, fields] of Object.entries(input as Record<string, unknown>)) {
      const list = stringList(fields);
      if (!Array.isArray(fields) || list.length === 0) {
        throw new ConnectorConfigurationError(`requiredFields.${entityType} must be a non-empty array of field ids`);
      }
      result[entityType] = list;
    }
    return result;
  }

  private async setStatus(orgId: string, connectorId: string, status: ConnectorStatus, errorMessage: string | null): Promise<void> {
    await this.dbService.db.query(
      `UPDATE integration_connectors SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4`,
      [status, errorMessage, connectorId, orgId],
    );
  }

  private async recordPollFailure(orgId: string, connectorId: string, message: string): Promise<void> {
    await this.withEvent(async (tx) => {
      await tx.query(
        `UPDATE integration_connectors
         SET status = 'error', error_message = $1, last_synced_at = CURRENT_TIMESTAMP,
             consecutive_failures = consecutive_failures + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND org_id = $3`,
        [message.slice(0, 500), connectorId, orgId],
      );
      return this.event(orgId, connectorId, `connector:${connectorId}`, 'ConnectorSyncFailed', {
        connector_id: connectorId,
        error: message,
      });
    });
  }

  private event(
    orgId: string,
    subjectId: string,
    actorId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): OutboxEventInput {
    return {
      event_type: eventType,
      work_item_id: subjectId,
      org_id: orgId,
      actor: { type: actorId.startsWith('connector:') ? 'integration' : 'user', id: actorId },
      payload: { org_id: orgId, ...payload },
    };
  }

  /** Runs a write and its audit event in one transaction, then dispatches after commit. */
  private async withEvent(work: (tx: DatabaseQueryable) => Promise<OutboxEventInput>): Promise<DomainEventEnvelope> {
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const input = await work(tx);
      event = await this.outbox.enqueue(tx, input);
    });
    if (!event) throw new Error('Transactional event was not created');
    await this.outbox.dispatch(event);
    return event;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ConnectorConfigurationError || error instanceof ConnectorCredentialError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private describe(error: unknown, fallback: string): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      return typeof response === 'string' ? response : String((response as any)?.message || error.message);
    }
    return (error as Error)?.message || fallback;
  }

  private toHttp(error: unknown, message: string): HttpException {
    if (error instanceof HttpException) return error;
    // The target is overloaded and Cadena did not call it; say so rather than report a bad gateway.
    if (error instanceof ConnectorLoadShedError) return new ServiceUnavailableException(error.message);
    if (error instanceof ConnectorCredentialError || error instanceof ConnectorConfigurationError) {
      return new UnprocessableEntityException(message);
    }
    return new BadGatewayException(message);
  }

  private mapConnector(row: any): ConnectorRecord {
    const discovery = parseJson<any>(row.discovery_metadata, {});
    return {
      id: row.id,
      orgId: row.org_id,
      provider: row.provider,
      name: row.name,
      status: row.status,
      config: parseJson(row.config, {}),
      discoveryMetadata: discovery && discovery.provider ? discovery : undefined,
      activatedAt: iso(row.activated_at),
      lastSyncedAt: iso(row.last_synced_at),
      lastSuccessAt: iso(row.last_success_at),
      syncLagSeconds: Number(row.sync_lag_seconds || 0),
      consecutiveFailures: Number(row.consecutive_failures || 0),
      errorMessage: row.error_message || undefined,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function sameState(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function pickPaths(source: Record<string, unknown>, paths: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const path of paths) {
    let value: unknown = source;
    for (const segment of path.split('.')) value = value && typeof value === 'object' ? (value as any)[segment] : undefined;
    if (value === undefined) continue;
    const segments = path.split('.');
    let cursor = picked;
    segments.slice(0, -1).forEach((segment) => {
      cursor[segment] = (cursor[segment] && typeof cursor[segment] === 'object') ? cursor[segment] : {};
      cursor = cursor[segment] as Record<string, unknown>;
    });
    cursor[segments[segments.length - 1]] = value;
  }
  return picked;
}

function providerName(provider: string): string {
  if (provider === 'jira') return 'Jira';
  if (provider === 'servicenow') return 'ServiceNow';
  return provider;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
