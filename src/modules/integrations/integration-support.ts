import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import { WorkflowService } from '../workflow/workflow.service';
import { ExternalArtifact, IntegrationTransitionResult } from './integration.types';

export interface IntegrationWorkItemRef {
  id: string;
  key: string;
  type: string;
  status: string;
}

export interface DeliveryLookup<T> {
  status: string;
  result: T | null;
}

export interface AttemptTransitionOptions {
  /** Role presented to the workflow engine. Guards are still evaluated against it. */
  actorRole?: string;
  fields?: Record<string, unknown>;
  skippedEventType?: string;
}

/**
 * Shared persistence and automation helpers for inbound integration gateways.
 *
 * The Git/CI gateway (Epic 6) and the monitoring/APM gateway (Epic 7) both record
 * provider-owned objects as `external_artifacts`, deduplicate inbound deliveries on
 * (tenant, provider, delivery id), and drive any automatic state change through the
 * normal `WorkflowService` path so guards and required fields are never bypassed.
 */
export class IntegrationSupport {
  private dbService = DatabaseService.getInstance();
  private workflowService = new WorkflowService();
  private eventBus = InProcessEventBus.getInstance();

  public async findDelivery<T>(
    orgId: string,
    provider: string,
    deliveryId: string,
  ): Promise<DeliveryLookup<T> | null> {
    const existing = await this.dbService.db.query<any>(
      `SELECT result, status FROM integration_deliveries
       WHERE org_id = $1 AND provider = $2 AND delivery_id = $3`,
      [orgId, provider, deliveryId],
    );
    if (existing.rows.length === 0) return null;
    return {
      status: existing.rows[0].status,
      result: this.parseJson<T>(existing.rows[0].result),
    };
  }

  public async beginDelivery(
    orgId: string,
    provider: string,
    deliveryId: string,
    eventType: string,
    payload: unknown,
  ): Promise<string> {
    const recordId = randomUUID();
    await this.dbService.db.query(
      `INSERT INTO integration_deliveries
       (id, org_id, provider, delivery_id, event_type, status, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, CURRENT_TIMESTAMP)`,
      [recordId, orgId, provider, deliveryId, eventType, JSON.stringify(payload)],
    );
    return recordId;
  }

  public async completeDelivery(recordId: string, result: unknown): Promise<void> {
    await this.dbService.db.query(
      `UPDATE integration_deliveries
       SET status = 'completed', result = $1, error = NULL, processed_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [JSON.stringify(result), recordId],
    );
  }

  public async failDelivery(recordId: string, message: string): Promise<void> {
    await this.dbService.db.query(
      `UPDATE integration_deliveries
       SET status = 'failed', error = $1, processed_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [message, recordId],
    );
  }

  public async getDeliveryRecord(orgId: string, provider: string, deliveryId: string): Promise<any | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT id, integration_kind, provider, delivery_id, event_type, status, attempts,
              result, error, created_at, claimed_at, processed_at
       FROM integration_deliveries
       WHERE org_id = $1 AND provider = $2 AND delivery_id = $3`,
      [orgId, provider.toLowerCase(), deliveryId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      ...row,
      result: this.parseJson(row.result),
      created_at: this.toIso(row.created_at),
      claimed_at: row.claimed_at ? this.toIso(row.claimed_at) : null,
      processed_at: row.processed_at ? this.toIso(row.processed_at) : null,
    };
  }

  public async findArtifact(
    orgId: string,
    provider: string,
    artifactType: ExternalArtifact['artifact_type'],
    externalId: string,
  ): Promise<ExternalArtifact | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM external_artifacts
       WHERE org_id = $1 AND provider = $2 AND artifact_type = $3 AND external_id = $4`,
      [orgId, provider, artifactType, externalId],
    );
    return result.rows.length > 0 ? this.mapArtifact(result.rows[0]) : null;
  }

  public async upsertArtifact(
    orgId: string,
    provider: string,
    artifactType: ExternalArtifact['artifact_type'],
    externalId: string,
    input: { title: string; url?: string; status?: string; payload: Record<string, unknown> },
  ): Promise<ExternalArtifact> {
    const result = await this.dbService.db.query<any>(
      `INSERT INTO external_artifacts
       (id, org_id, provider, artifact_type, external_id, title, url, status, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, provider, artifact_type, external_id)
       DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, status = EXCLUDED.status,
                     payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        randomUUID(), orgId, provider, artifactType, externalId, input.title,
        input.url || null, input.status || null, JSON.stringify(input.payload),
      ],
    );
    return this.mapArtifact(result.rows[0]);
  }

  public async linkArtifact(artifactId: string, workItemId: string, linkType: string): Promise<void> {
    await this.dbService.db.query(
      `INSERT INTO external_artifact_links
       (id, artifact_id, work_item_id, link_type, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (artifact_id, work_item_id, link_type) DO NOTHING`,
      [randomUUID(), artifactId, workItemId, linkType],
    );
  }

  public async resolveReferences(
    orgId: string,
    keys: string[],
  ): Promise<{ items: IntegrationWorkItemRef[]; unresolved: string[] }> {
    const items: IntegrationWorkItemRef[] = [];
    const unresolved: string[] = [];
    for (const key of keys) {
      const result = await this.dbService.db.query<any>(
        `SELECT id, item_key, type, status FROM work_items
         WHERE org_id = $1 AND UPPER(item_key) = $2`,
        [orgId, key.toUpperCase()],
      );
      if (result.rows.length === 0) {
        if (CADENA_KEY_PATTERN.test(key)) unresolved.push(key);
      } else {
        items.push({
          id: result.rows[0].id,
          key: result.rows[0].item_key,
          type: result.rows[0].type,
          status: result.rows[0].status,
        });
      }
    }
    return { items, unresolved };
  }

  /**
   * Requests one state change through the workflow engine. A rejected guard or missing
   * required field is recorded as a skipped outcome with its reason; it is never forced.
   */
  public async attemptTransition(
    item: IntegrationWorkItemRef,
    orgId: string,
    targetState: string,
    actorId: string,
    options: AttemptTransitionOptions = {},
  ): Promise<IntegrationTransitionResult> {
    try {
      const transition = await this.workflowService.transitionWorkItem({
        workItemId: item.id,
        orgId,
        toState: targetState,
        actorId,
        actorRole: options.actorRole || 'integration',
        actorType: 'integration',
        fields: options.fields,
      });
      return {
        work_item_id: item.id,
        work_item_key: item.key,
        from_state: transition.from_state,
        to_state: transition.to_state,
        outcome: 'applied',
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Transition was rejected';
      await this.eventBus.publish(
        options.skippedEventType || 'IntegrationAutoTransitionSkipped',
        item.id,
        { type: 'integration', id: actorId },
        {
          org_id: orgId,
          work_item_key: item.key,
          from_state: item.status,
          to_state: targetState,
          reason,
        },
      );
      return {
        work_item_id: item.id,
        work_item_key: item.key,
        from_state: item.status,
        to_state: targetState,
        outcome: 'skipped',
        reason,
      };
    }
  }

  public mapArtifact(row: any): ExternalArtifact {
    return {
      id: row.id,
      org_id: row.org_id,
      provider: row.provider,
      artifact_type: row.artifact_type,
      external_id: row.external_id,
      title: row.title,
      url: row.url,
      status: row.status,
      payload: this.parseJson<Record<string, unknown>>(row.payload) || {},
      created_at: this.toIso(row.created_at),
      updated_at: this.toIso(row.updated_at),
    };
  }

  public parseJson<T = any>(value: any): T | null {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? JSON.parse(value) as T : value as T;
  }

  public toIso(value: any): string {
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}

/** Keys Cadena itself issues; only these are reported when they do not resolve. */
const CADENA_KEY_PATTERN = /^(?:EPIC|STORY|INC|REL)-[A-Z0-9]+$/;
