import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { DatabaseQueryable } from '../../database/database-adapter';
import { stableStringify } from '../audit/audit-integrity';
import { EventOutboxService, OutboxEventInput } from '../events/event-outbox.service';
import { CorrelationService } from '../integrations/correlation.service';
import { StateMappingService } from '../integrations/state-mapping.service';
import { SyncGuardService } from '../integrations/sync-guard.service';
import { SyncIdentity } from '../integrations/sync-guard.types';
import { ConnectorAdapter, ConnectorContext } from './connector.interface';
import {
  ConnectorConfigurationError,
  ConnectorCredentialError,
  ConnectorRemoteError,
} from './connector-http';
import { stringList } from './connector-config';
import { JiraConnectorAdapter } from './jira-connector.adapter';
import { ServiceNowConnectorAdapter } from './servicenow-connector.adapter';
import {
  CanonicalTwin,
  ConnectorCapabilityReport,
  ConnectorConfigDto,
  ConnectorDiscoveryResult,
  ConnectorHealth,
  ConnectorLimitation,
  ConnectorProviderDescriptor,
  ConnectorProviderType,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorWorkOrder,
  ConnectorWorkOrderStatus,
  ConnectorWriteBackPolicy,
  ExternalRecordPayload,
  IngestionPollResult,
  TwinCounterpart,
  TwinDetail,
  TwinEditResult,
  TwinFieldPolicy,
  TwinWorkspaceRow,
  WatermarkCursor,
  WorkspaceOverview,
} from './connector.types';
import { SecretManagerResolver } from './secret-manager-ref';
import { getProviderSandbox } from './sandbox/provider-sandbox';
import { loadRuntimeConfig } from '../../config/runtime-config';

const MAX_WORK_ORDER_ATTEMPTS = 5;
const WORK_ORDER_BASE_BACKOFF_MS = 30_000;
const WORK_ORDER_MAX_BACKOFF_MS = 60 * 60_000;
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
 * The in-process single-flight lock assumes the single-replica deployment documented in
 * deploy/staging; horizontal scaling needs a database lease first.
 */
@Injectable()
export class ConnectorService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private correlationService = new CorrelationService();
  private stateMappingService = new StateMappingService();
  private syncGuardService = new SyncGuardService();
  private secrets = new SecretManagerResolver();
  private adapters = new Map<ConnectorProviderType, ConnectorAdapter>();
  private inFlight = new Set<string>();

  constructor() {
    // The sandbox is a local-only demonstration transport; runtime config refuses it elsewhere.
    const transport = loadRuntimeConfig().connectorSandbox ? getProviderSandbox().fetch : undefined;
    this.registerAdapter(new JiraConnectorAdapter(transport));
    this.registerAdapter(new ServiceNowConnectorAdapter(transport));
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
    }));
    this.guard(() => adapter.validateConfig(config));

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
    return this.getConnector(orgId, connectorId);
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

  // ─── Ingestion ─────────────────────────────────────────────────────────────

  public async syncConnector(orgId: string, connectorId: string, actorId = 'system'): Promise<IngestionPollResult> {
    const startTime = Date.now();
    const connector = await this.getConnector(orgId, connectorId);
    if (!connector.activatedAt) throw new ConflictException('Connector must be discovered and activated before it can synchronize');
    if (connector.status === 'paused') throw new ConflictException('Connector is paused');
    const lockKey = `${orgId}:${connectorId}`;
    if (this.inFlight.has(lockKey)) throw new ConflictException('A synchronization for this connector is already running');
    this.inFlight.add(lockKey);

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
      };
      await this.processDueWorkOrders(orgId, connector, counters);

      const recordErrors: IngestionPollResult['recordErrors'] = [];
      const nextCursors: WatermarkCursor[] = [];
      let fetchedCount = 0;
      let hasMore = false;
      let oldestPending: number | null = null;

      for (const entityType of adapter.entityTypes(connector.config)) {
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
          const message = this.describe(error, 'Change query failed');
          await this.recordPollFailure(orgId, connectorId, `${entityType}: ${message}`);
          throw this.toHttp(error, `Synchronization failed for ${entityType}: ${message}`);
        }
        fetchedCount += page.records.length;

        let firstFailure: string | null = null;
        for (const record of page.records) {
          try {
            await this.processRecord(orgId, connector, record, counters);
          } catch (error) {
            recordErrors.push({
              externalId: record.externalId,
              entityType,
              message: this.describe(error, 'Record processing failed'),
            });
            if (!firstFailure || Date.parse(record.updatedAt) < Date.parse(firstFailure)) firstFailure = record.updatedAt;
          }
        }

        // Never advance past a record that failed; it is re-fetched on the next poll.
        const cursorValue = firstFailure || page.nextCursor.cursorValue;
        await this.dbService.db.query(
          `INSERT INTO integration_connector_cursors (id, connector_id, entity_type, cursor_value, updated_at)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
           ON CONFLICT (connector_id, entity_type)
           DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = CURRENT_TIMESTAMP`,
          [randomUUID(), connectorId, entityType, cursorValue],
        );
        nextCursors.push({ entityType, cursorValue });
        if (page.hasMore || firstFailure) {
          hasMore = hasMore || page.hasMore;
          const pending = Date.parse(cursorValue);
          oldestPending = oldestPending === null ? pending : Math.min(oldestPending, pending);
        }
      }

      const now = Date.now();
      const lagSeconds = oldestPending === null ? 0 : Math.max(0, Math.round((now - oldestPending) / 1000));
      const status: ConnectorStatus = recordErrors.length ? 'degraded' : 'active';
      const errorMessage = recordErrors.length
        ? `${recordErrors.length} record(s) failed; first: ${recordErrors[0].message}`.slice(0, 500)
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
      };

      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_connectors
           SET status = $1, last_synced_at = $2, last_success_at = $2, sync_lag_seconds = $3,
               consecutive_failures = 0, error_message = $4, updated_at = CURRENT_TIMESTAMP
           WHERE id = $5 AND org_id = $6`,
          [status, new Date(now).toISOString(), lagSeconds, errorMessage, connectorId, orgId],
        );
        return this.event(orgId, connectorId, actorId, 'ConnectorSyncCompleted', {
          connector_id: connectorId,
          provider: connector.provider,
          fetched: fetchedCount,
          ...counters,
          record_errors: recordErrors.length,
          has_more: hasMore,
          lag_seconds: lagSeconds,
        });
      });
      return result;
    } finally {
      this.inFlight.delete(lockKey);
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
      `SELECT t.id, t.connector_id, t.content_hash, t.native_status, c.name AS connector_name
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
       WHERE t.org_id = $1 AND t.provider = $2 AND t.artifact_type = $3 AND t.external_id = $4`,
      [orgId, connector.provider, record.artifactType, record.externalId],
    );
    const prior = existing.rows[0];
    if (prior && prior.connector_id !== connector.id) {
      throw new Error(`${connector.provider}/${record.artifactType}/${record.externalId} is already managed by connector "${prior.connector_name}"`);
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
    await this.withEvent(async (tx) => {
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
      });
    });
    if (prior) counters.twinsUpdated++;
    else counters.twinsCreated++;

    const stateChanged = !prior || !sameState(prior.native_status, record.status);
    if (stateChanged && record.status) {
      await this.propagateStateChange(orgId, connector, identity, node.id, record, counters);
    }
    return prior ? 'updated' : 'created';
  }

  /**
   * Screens a native state change for echoes, then translates it for every managed counterpart.
   * The sync-guard projection is deliberately `{ state }`: the same projection is recorded when a
   * work order writes a state, so our own write returning on the next poll is suppressed.
   */
  private async propagateStateChange(
    orgId: string,
    connector: ConnectorRecord,
    identity: SyncIdentity,
    nodeId: string,
    record: ExternalRecordPayload,
    counters: PollCounters,
    options: { skipEchoCheck?: boolean } = {},
  ): Promise<void> {
    // An operator edit Cadena itself just wrote is already recorded; it is propagated directly.
    if (!options.skipEchoCheck) {
      const decision = await this.syncGuardService.evaluateWebhook(orgId, {
        identity,
        actor_id: record.updatedBy || `${connector.provider}:unattributed`,
        payload: { state: record.status },
      });
      if (decision.suppressed) {
        counters.echoesSuppressed++;
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
      [orgId, nodeId],
    );

    for (const target of counterparts.rows) {
      const translation = await this.stateMappingService.translate(orgId, {
        source_identity: identity,
        target_identity: { system: target.provider, entity_type: target.artifact_type, immutable_id: target.external_id },
        source_state: record.status,
        current_target_state: target.native_status || null,
        target_fields: record.fields,
        dry_run: false,
      }, `connector:${connector.id}`);

      if (translation.status !== 'ready' || !translation.transaction_id || !translation.mapped_target_state) {
        counters.workOrdersHeld++;
        continue;
      }

      const required = await this.dbService.db.query<any>(
        `SELECT required_target_fields FROM integration_state_sync_transactions WHERE id = $1 AND org_id = $2`,
        [translation.transaction_id, orgId],
      );
      const requiredPaths: string[] = parseJson(required.rows[0]?.required_target_fields, []);
      const fields = pickPaths(record.fields, requiredPaths);
      const noop = sameState(target.native_status, translation.mapped_target_state);
      const workOrderId = randomUUID();
      await this.dbService.db.query(
        `INSERT INTO integration_connector_work_orders
         (id, org_id, transaction_id, source_connector_id, target_connector_id, target_twin_id,
          target_entity_type, target_external_id, target_state, fields, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (transaction_id) DO NOTHING`,
        [
          workOrderId, orgId, translation.transaction_id, connector.id, target.connector_id, target.id,
          target.artifact_type, target.external_id, translation.mapped_target_state, JSON.stringify(fields),
          noop ? 'noop' : 'pending',
        ],
      );
      counters.workOrdersPrepared++;
      if (!noop) {
        const outcome = await this.executeWorkOrder(orgId, workOrderId);
        if (outcome === 'executed') counters.workOrdersExecuted++;
        else if (outcome === 'failed' || outcome === 'dead') counters.workOrdersFailed++;
      }
    }
  }

  // ─── Work orders ───────────────────────────────────────────────────────────

  private async processDueWorkOrders(orgId: string, connector: ConnectorRecord, counters: PollCounters): Promise<void> {
    const due = await this.dbService.db.query<any>(
      `SELECT id FROM integration_connector_work_orders
       WHERE org_id = $1 AND target_connector_id = $2 AND status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
       ORDER BY created_at ASC LIMIT 50`,
      [orgId, connector.id],
    );
    for (const row of due.rows) {
      const outcome = await this.executeWorkOrder(orgId, row.id);
      if (outcome === 'executed') counters.workOrdersExecuted++;
      else if (outcome === 'failed' || outcome === 'dead') counters.workOrdersFailed++;
    }
  }

  /** Executes one work order at most once. Returns its resulting status. */
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
    if (row.status !== 'pending' && row.status !== 'failed') return row.status;
    // A target that is not activated or is paused keeps the order queued rather than failing it.
    if (!row.connector_activated_at || row.connector_status === 'paused') return row.status;

    const claimed = await this.dbService.db.query<any>(
      `UPDATE integration_connector_work_orders
       SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2 AND status = $3 AND attempts = $4
       RETURNING attempts`,
      [workOrderId, orgId, row.status, row.attempts],
    );
    if (!claimed.rows.length) return row.status;
    const attempts = Number(claimed.rows[0].attempts);

    const target = await this.getConnector(orgId, row.target_connector_id);
    const adapter = this.getAdapter(target.provider);
    const fields = parseJson<Record<string, unknown>>(row.fields, {});
    try {
      const result = await adapter.pushStateChange(this.context(target), {
        entityType: row.target_entity_type,
        externalId: row.target_external_id,
        targetState: row.target_state,
        fields,
      });
      await this.syncGuardService.recordIntegrationWrite(orgId, {
        identity: { system: target.provider, entity_type: row.target_entity_type, immutable_id: row.target_external_id },
        service_account_id: `connector:${target.id}`,
        payload: { state: row.target_state },
      });
      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_connector_work_orders
           SET status = 'executed', executed_at = CURRENT_TIMESTAMP, last_error = NULL,
               next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND org_id = $2`,
          [workOrderId, orgId],
        );
        return this.event(orgId, workOrderId, `connector:${target.id}`, 'ConnectorWorkOrderExecuted', {
          work_order_id: workOrderId,
          transaction_id: row.transaction_id,
          target_connector_id: target.id,
          target_external_id: row.target_external_id,
          target_state: row.target_state,
          attempts,
          message: result.message,
        });
      });
      return 'executed';
    } catch (error) {
      const message = this.describe(error, 'Connector write failed');
      const retryable = (error instanceof ConnectorRemoteError && error.retryable) || error instanceof ConnectorCredentialError;
      const status: ConnectorWorkOrderStatus = retryable && attempts < MAX_WORK_ORDER_ATTEMPTS ? 'failed' : 'dead';
      const retryAfterMs = error instanceof ConnectorRemoteError && error.retryAfterSeconds
        ? error.retryAfterSeconds * 1000
        : Math.min(WORK_ORDER_BASE_BACKOFF_MS * 2 ** (attempts - 1), WORK_ORDER_MAX_BACKOFF_MS);
      await this.withEvent(async (tx) => {
        await tx.query(
          `UPDATE integration_connector_work_orders
           SET status = $1, last_error = $2, next_attempt_at = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND org_id = $5`,
          [
            status, message.slice(0, 500),
            status === 'failed' ? new Date(Date.now() + retryAfterMs).toISOString() : null,
            workOrderId, orgId,
          ],
        );
        return this.event(orgId, workOrderId, `connector:${target.id}`, 'ConnectorWorkOrderFailed', {
          work_order_id: workOrderId,
          transaction_id: row.transaction_id,
          target_connector_id: target.id,
          target_external_id: row.target_external_id,
          target_state: row.target_state,
          attempts,
          retryable,
          final: status === 'dead',
          error: message,
        });
      });
      return status;
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
      lastError: row.last_error || undefined,
      nextAttemptAt: iso(row.next_attempt_at),
      executedAt: iso(row.executed_at),
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  // ─── Operational visibility ────────────────────────────────────────────────

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
    const workOrders: Record<ConnectorWorkOrderStatus, number> = { pending: 0, executed: 0, failed: 0, dead: 0, noop: 0 };
    for (const row of orders.rows) workOrders[row.status as ConnectorWorkOrderStatus] = Number(row.count);
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
      ['error', 'degraded'].includes(source.status) || source.workOrders.dead > 0 || source.workOrders.failed > 0);
    return {
      sources,
      totals: {
        sources: sources.length,
        healthy: sources.filter((source) => source.status === 'active' && !attention.includes(source)).length,
        attention: attention.length,
        twins: sources.reduce((sum, source) => sum + source.twinCount, 0),
        maxLagSeconds: sources.reduce((max, source) => Math.max(max, source.syncLagSeconds), 0),
        queuedWrites: sources.reduce((sum, source) => sum + source.workOrders.pending + source.workOrders.failed, 0),
        failedWrites: sources.reduce((sum, source) => sum + source.workOrders.dead, 0),
      },
    };
  }

  public async listTwinWorkspace(orgId: string): Promise<TwinWorkspaceRow[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT t.*, c.name AS connector_name, c.status AS connector_status, c.last_success_at AS connector_last_success_at,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status IN ('pending', 'failed')) AS queued_writes,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status = 'dead') AS failed_writes
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
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
    return {
      ...row,
      fields: this.fieldPolicies(row, connector),
      workOrders: orders.rows.map((order) => this.mapWorkOrder(order)),
    };
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

    const value = policy.allowedValues?.find((candidate) => sameState(candidate, input.value)) || null;
    if (!value) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        decision: 'blocked',
        field: policy.field,
        reason: 'invalid_value',
        message: `'${String(input.value).trim()}' is not a ${providerName(twin.provider)} ${policy.label.toLowerCase()}. Allowed: ${(policy.allowedValues || []).join(', ')}`,
      });
    }
    const empty = { prepared: 0, executed: 0, held: 0 };
    if (sameState(twin.status, value)) {
      return { decision: 'noop', twinId, field: policy.field, value, propagation: empty, message: `${twin.nativeKey || twin.externalId} is already ${value}` };
    }

    const workOrderId = randomUUID();
    await this.withEvent(async (tx) => {
      await tx.query(
        `INSERT INTO integration_connector_work_orders
         (id, org_id, transaction_id, origin, requested_by, source_connector_id, target_connector_id, target_twin_id,
          target_entity_type, target_external_id, target_state, fields, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'operator_edit', $3, NULL, $4, $5, $6, $7, $8, '{}', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [workOrderId, orgId, actorId, twin.connectorId, twinId, twin.artifactType, twin.externalId, value],
      );
      return this.event(orgId, twinId, actorId, 'TwinEditRouted', {
        twin_id: twinId,
        work_order_id: workOrderId,
        connector_id: twin.connectorId,
        field: policy.field,
        before: twin.status || null,
        after: value,
      });
    });

    const outcome = await this.executeWorkOrder(orgId, workOrderId);
    const propagation = { ...empty };
    if (outcome === 'executed') {
      const connector = await this.getConnector(orgId, twin.connectorId);
      const counters: PollCounters = {
        twinsCreated: 0, twinsUpdated: 0, twinsUnchanged: 0, echoesSuppressed: 0,
        workOrdersPrepared: 0, workOrdersHeld: 0, workOrdersExecuted: 0, workOrdersFailed: 0,
      };
      if (twin.correlationNodeId) {
        await this.propagateStateChange(
          orgId,
          connector,
          { system: twin.provider, entity_type: twin.artifactType, immutable_id: twin.externalId },
          twin.correlationNodeId,
          {
            externalId: twin.externalId,
            artifactType: twin.artifactType,
            title: twin.title || '',
            status: value,
            fields: twin.payload,
            updatedAt: new Date().toISOString(),
          },
          counters,
          { skipEchoCheck: true },
        );
      }
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
          : `The change is queued until ${twin.connectorName} is active`;
    return { decision: 'routed', twinId, field: policy.field, value, workOrder: order, propagation, message };
  }

  private async listTwinWorkspaceRows(orgId: string, twinId: string): Promise<TwinWorkspaceRow[]> {
    const result = await this.dbService.db.query<any>(
      `SELECT t.*, c.name AS connector_name, c.status AS connector_status, c.last_success_at AS connector_last_success_at,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status IN ('pending', 'failed')) AS queued_writes,
              (SELECT COUNT(*)::int FROM integration_connector_work_orders w
                WHERE w.org_id = t.org_id AND w.target_twin_id = t.id AND w.status = 'dead') AS failed_writes
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
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
    for (const [fieldId, authority] of Object.entries(twin.fieldAuthority)) {
      if (fieldId === nativeState) continue;
      const schema = entity?.fields.find((field) => field.id === fieldId);
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
    if (input === undefined || input === null) return { state: false };
    if (typeof input !== 'object' || Array.isArray(input)) throw new ConnectorConfigurationError('writeBack must be an object');
    const unknown = Object.keys(input).filter((key) => key !== 'state');
    if (unknown.length) {
      throw new ConnectorConfigurationError(`writeBack supports only 'state'; no outbound mapping exists for ${unknown.join(', ')}`);
    }
    const state = (input as Record<string, unknown>).state;
    if (state !== undefined && typeof state !== 'boolean') throw new ConnectorConfigurationError('writeBack.state must be true or false');
    return { state: state === true };
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
  private async withEvent(work: (tx: DatabaseQueryable) => Promise<OutboxEventInput>): Promise<void> {
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const input = await work(tx);
      event = await this.outbox.enqueue(tx, input);
    });
    if (event) await this.outbox.dispatch(event);
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
