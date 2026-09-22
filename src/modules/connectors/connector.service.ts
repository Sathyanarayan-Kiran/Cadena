import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import { CorrelationService } from '../integrations/correlation.service';
import { StateMappingService } from '../integrations/state-mapping.service';
import { SyncGuardService } from '../integrations/sync-guard.service';
import { ConnectorAdapter } from './connector.interface';
import { JiraConnectorAdapter } from './jira-connector.adapter';
import { ServiceNowConnectorAdapter } from './servicenow-connector.adapter';
import {
  CanonicalTwin,
  ConnectorConfigDto,
  ConnectorDiscoveryResult,
  ConnectorProviderType,
  ConnectorRecord,
  IngestionPollResult,
  WatermarkCursor,
} from './connector.types';
import { SecretManagerResolver } from './secret-manager-ref';

@Injectable()
export class ConnectorService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private correlationService = new CorrelationService();
  private stateMappingService = new StateMappingService();
  private syncGuardService = new SyncGuardService();

  private adapters: Map<string, ConnectorAdapter> = new Map();

  constructor() {
    this.registerAdapter(new JiraConnectorAdapter());
    this.registerAdapter(new ServiceNowConnectorAdapter());
  }

  public registerAdapter(adapter: ConnectorAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  public getAdapter(provider: ConnectorProviderType): ConnectorAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new BadRequestException(`Unsupported connector provider: ${provider}`);
    }
    return adapter;
  }

  public async createConnector(
    orgId: string,
    dto: ConnectorConfigDto,
    actorId: string = 'system',
  ): Promise<ConnectorRecord> {
    await this.dbService.initialize();
    if (!dto.name || !dto.name.trim()) {
      throw new BadRequestException('Connector name is required');
    }
    if (!dto.provider) {
      throw new BadRequestException('Connector provider is required');
    }

    const sanitizedConfig = SecretManagerResolver.sanitizeConfigForStorage({
      baseUrl: dto.baseUrl,
      authType: dto.authType || 'bearer',
      credentials: dto.credentials || {},
      options: dto.options || {},
      projectKeys: dto.projectKeys,
      tableNames: dto.tableNames,
    });

    const connectorId = randomUUID();
    const now = new Date().toISOString();
    let connector!: ConnectorRecord;

    await this.dbService.db.transaction(async (tx) => {
      const inserted = await tx.query<any>(
        `INSERT INTO integration_connectors
         (id, org_id, provider, name, status, config, discovery_metadata, sync_lag_seconds, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'unconfigured', $5, '{}', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING *`,
        [connectorId, orgId, dto.provider, dto.name.trim(), JSON.stringify(sanitizedConfig)],
      );
      connector = this.mapConnector(inserted.rows[0]);

      await this.outbox.enqueue(tx, {
        event_type: 'ConnectorRegistered',
        work_item_id: connectorId,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: {
          connector_id: connectorId,
          provider: dto.provider,
          name: dto.name,
        },
      });
    });

    return connector;
  }

  public async getConnector(orgId: string, connectorId: string): Promise<ConnectorRecord> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_connectors WHERE id = $1 AND org_id = $2`,
      [connectorId, orgId],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException(`Connector ${connectorId} not found`);
    }
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

  public async testConnection(orgId: string, connectorId: string): Promise<{ success: boolean; status: string; message?: string }> {
    const connector = await this.getConnector(orgId, connectorId);
    const adapter = this.getAdapter(connector.provider);

    try {
      const ok = await adapter.testConnection(connector);
      const newStatus = ok ? 'connected' : 'error';
      const errorMessage = ok ? null : 'Connection test failed';

      await this.dbService.db.query(
        `UPDATE integration_connectors
         SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND org_id = $4`,
        [newStatus, errorMessage, connectorId, orgId],
      );

      return { success: ok, status: newStatus, message: errorMessage || 'Connection verified successfully' };
    } catch (err: any) {
      const msg = err?.message || 'Connection attempt failed';
      await this.dbService.db.query(
        `UPDATE integration_connectors
         SET status = 'error', error_message = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND org_id = $3`,
        [msg, connectorId, orgId],
      );
      return { success: false, status: 'error', message: msg };
    }
  }

  public async discoverSchema(orgId: string, connectorId: string, actorId: string = 'system'): Promise<ConnectorDiscoveryResult> {
    const connector = await this.getConnector(orgId, connectorId);
    const adapter = this.getAdapter(connector.provider);

    await this.dbService.db.query(
      `UPDATE integration_connectors SET status = 'discovering' WHERE id = $1 AND org_id = $2`,
      [connectorId, orgId],
    );

    try {
      const discovery = await adapter.discoverSchema(connector);

      await this.dbService.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE integration_connectors
           SET status = 'active', discovery_metadata = $1, error_message = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND org_id = $3`,
          [JSON.stringify(discovery), connectorId, orgId],
        );

        await this.outbox.enqueue(tx, {
          event_type: 'ConnectorDiscovered',
          work_item_id: connectorId,
          org_id: orgId,
          actor: { type: 'user', id: actorId },
          payload: {
            connector_id: connectorId,
            provider: connector.provider,
            entity_count: discovery.entities.length,
            discovered_at: discovery.discoveredAt,
          },
        });
      });

      return discovery;
    } catch (err: any) {
      const msg = err?.message || 'Schema discovery failed';
      await this.dbService.db.query(
        `UPDATE integration_connectors SET status = 'error', error_message = $1 WHERE id = $2 AND org_id = $3`,
        [msg, connectorId, orgId],
      );
      throw new BadRequestException(`Discovery failed: ${msg}`);
    }
  }

  public async syncConnector(
    orgId: string,
    connectorId: string,
    actorId: string = 'system',
  ): Promise<IngestionPollResult> {
    const startTime = Date.now();
    const connector = await this.getConnector(orgId, connectorId);
    const adapter = this.getAdapter(connector.provider);

    // Read stored cursor
    const cursorResult = await this.dbService.db.query<any>(
      `SELECT entity_type, cursor_value, updated_at FROM integration_connector_cursors
       WHERE connector_id = $1`,
      [connectorId],
    );

    const storedCursor: WatermarkCursor | undefined =
      cursorResult.rows.length > 0
        ? { entityType: cursorResult.rows[0].entity_type, cursorValue: cursorResult.rows[0].cursor_value }
        : undefined;

    const { records, nextCursor } = await adapter.fetchChanges(connector, storedCursor);

    let twinsCreated = 0;
    let twinsUpdated = 0;
    let workOrdersPrepared = 0;
    let workOrdersHeld = 0;
    let workOrdersExecuted = 0;

    for (const record of records) {
      // 1. Materialize / update correlation node first via CorrelationService
      const node = await this.correlationService.upsertNode(orgId, {
        system: record.fieldAuthority?.[Object.keys(record.fieldAuthority)[0]] || connector.provider,
        entity_type: record.artifactType,
        immutable_id: record.externalId,
        display_key: record.nativeKey || record.externalId,
        url: record.nativeUrl,
      }, actorId);

      // 2. Check if canonical twin exists
      const existingTwinRes = await this.dbService.db.query<any>(
        `SELECT id, payload, sync_state FROM integration_canonical_twins
         WHERE org_id = $1 AND provider = $2 AND artifact_type = $3 AND external_id = $4`,
        [orgId, connector.provider, record.artifactType, record.externalId],
      );

      let twinId: string;
      if (existingTwinRes.rows.length === 0) {
        twinId = randomUUID();
        await this.dbService.db.query(
          `INSERT INTO integration_canonical_twins
           (id, org_id, connector_id, provider, artifact_type, external_id, native_key, native_url,
            sync_state, field_authority, payload, correlation_node_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'synced', $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            twinId, orgId, connectorId, connector.provider, record.artifactType,
            record.externalId, record.nativeKey || null, record.nativeUrl || null,
            JSON.stringify(record.fieldAuthority || {}), JSON.stringify(record.fields), node.id,
          ],
        );
        twinsCreated++;
      } else {
        twinId = existingTwinRes.rows[0].id;
        await this.dbService.db.query(
          `UPDATE integration_canonical_twins
           SET native_key = $1, native_url = $2, field_authority = $3, payload = $4,
               correlation_node_id = $5, updated_at = CURRENT_TIMESTAMP
           WHERE id = $6`,
          [
            record.nativeKey || null, record.nativeUrl || null,
            JSON.stringify(record.fieldAuthority || {}), JSON.stringify(record.fields), node.id, twinId,
          ],
        );
        twinsUpdated++;
      }
    }

    // Update cursor watermark
    if (nextCursor) {
      await this.dbService.db.query(
        `INSERT INTO integration_connector_cursors (id, connector_id, entity_type, cursor_value, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (connector_id, entity_type)
         DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = CURRENT_TIMESTAMP`,
        [randomUUID(), connectorId, nextCursor.entityType, nextCursor.cursorValue],
      );
    }

    // Update connector status and lag
    const durationMs = Date.now() - startTime;
    const nowIso = new Date().toISOString();

    await this.dbService.db.query(
      `UPDATE integration_connectors
       SET status = 'active', last_synced_at = $1, last_success_at = $1, sync_lag_seconds = 0,
           error_message = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3`,
      [nowIso, connectorId, orgId],
    );

    return {
      connectorId,
      provider: connector.provider,
      fetchedCount: records.length,
      twinsCreated,
      twinsUpdated,
      workOrdersPrepared,
      workOrdersHeld,
      workOrdersExecuted,
      nextCursors: nextCursor ? [nextCursor] : [],
      durationMs,
    };
  }

  public async listTwins(orgId: string, connectorId?: string): Promise<CanonicalTwin[]> {
    await this.dbService.initialize();
    let query = `SELECT * FROM integration_canonical_twins WHERE org_id = $1`;
    const params: any[] = [orgId];

    if (connectorId) {
      query += ` AND connector_id = $2`;
      params.push(connectorId);
    }
    query += ` ORDER BY updated_at DESC`;

    const result = await this.dbService.db.query<any>(query, params);
    return result.rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      connectorId: row.connector_id,
      provider: row.provider,
      artifactType: row.artifact_type,
      externalId: row.external_id,
      nativeKey: row.native_key,
      nativeUrl: row.native_url,
      syncState: row.sync_state,
      fieldAuthority: typeof row.field_authority === 'string' ? JSON.parse(row.field_authority) : row.field_authority || {},
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {},
      correlationNodeId: row.correlation_node_id,
      createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
    }));
  }

  private mapConnector(row: any): ConnectorRecord {
    return {
      id: row.id,
      orgId: row.org_id,
      provider: row.provider,
      name: row.name,
      status: row.status,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {},
      discoveryMetadata: typeof row.discovery_metadata === 'string' ? JSON.parse(row.discovery_metadata) : row.discovery_metadata || {},
      lastSyncedAt: row.last_synced_at ? (typeof row.last_synced_at === 'string' ? row.last_synced_at : new Date(row.last_synced_at).toISOString()) : undefined,
      lastSuccessAt: row.last_success_at ? (typeof row.last_success_at === 'string' ? row.last_success_at : new Date(row.last_success_at).toISOString()) : undefined,
      syncLagSeconds: Number(row.sync_lag_seconds || 0),
      errorMessage: row.error_message || undefined,
      createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
    };
  }
}
