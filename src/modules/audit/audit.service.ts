import { DatabaseService } from '../../database/database.service';
import { WorkItemService } from '../work-items/work-item.service';
import {
  AUDIT_HASH_ALGORITHM,
  AUDIT_PROOF_VERSION,
  AuditIntegrityMetadata,
  IntegrityEventInput,
  verifyAuditEntry,
  verifyTenantAuditChain,
} from './audit-integrity';

export class AuditWorkItemNotFoundError extends Error {
  constructor(workItemId: string) {
    super(`Work item '${workItemId}' not found`);
    this.name = 'AuditWorkItemNotFoundError';
  }
}

export interface AuditTrailEvent {
  id: string;
  event_type: string;
  actor: { type: string; id: string };
  timestamp: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  integrity: AuditIntegrityMetadata;
}

export interface AuditExportDocument {
  schema: 'cadena.audit-trail.v1';
  work_item: { id: string; key: string; type: string; title: string; status: string };
  org_id: string;
  generated_at: string;
  generated_by: string;
  event_count: number;
  integrity: {
    algorithm: typeof AUDIT_HASH_ALGORITHM;
    proof_version: number;
    chain_scope: 'tenant';
    chain_length: number;
    chain_head: string | null;
    chain_verified: boolean;
    exported_event_count: number;
    exported_events_verified: number;
    verified: boolean;
  };
  events: AuditTrailEvent[];
}

/** Tenant-scoped projection over the immutable domain and workflow event stores. */
export class AuditService {
  private dbService = DatabaseService.getInstance();
  private workItems = new WorkItemService();

  public async getTrail(workItemId: string, orgId: string, actorId: string): Promise<AuditExportDocument> {
    await this.dbService.initialize();
    const item = await this.workItems.getWorkItemById(workItemId, orgId);
    if (!item) throw new AuditWorkItemNotFoundError(workItemId);

    const domainResult = await this.dbService.db.query<any>(
      `SELECT event.event_id, event.org_id, event.event_type, event.schema_version,
              event.work_item_id, event.actor_type, event.actor_id, event.payload, event.occurred_at,
              integrity.sequence, integrity.previous_hash, integrity.event_hash, integrity.proof_version
       FROM domain_events event
       LEFT JOIN audit_integrity_entries integrity
         ON integrity.source = 'domain_events' AND integrity.event_id = event.event_id
       WHERE event.org_id = $1
         AND (
           event.work_item_id = $2
           OR (event.event_type = 'LinkCreated' AND (
             event.payload->'link'->>'source_id' = $2 OR event.payload->'link'->>'target_id' = $2
           ))
         )
       ORDER BY event.occurred_at ASC, event.event_id ASC`,
      [orgId, workItemId],
    );
    const auditResult = await this.dbService.db.query<any>(
      `SELECT audit.id, item.org_id, audit.work_item_id::text AS work_item_id,
              audit.event_type, audit.actor_type, audit.actor_id, audit.payload, audit.timestamp,
              integrity.sequence, integrity.previous_hash, integrity.event_hash, integrity.proof_version
       FROM audit_events audit
       JOIN work_items item ON item.id = audit.work_item_id
       LEFT JOIN audit_integrity_entries integrity
         ON integrity.source = 'audit_events' AND integrity.event_id = audit.id
       WHERE audit.work_item_id = $1 AND item.org_id = $2
       ORDER BY audit.timestamp ASC, audit.id ASC`,
      [workItemId, orgId],
    );

    const auditRows = auditResult.rows || [];
    const auditDuplicateKeys = new Set(auditRows.map((row: any) =>
      `${row.event_type}|${row.actor_id}|${this.toIso(row.timestamp)}`));
    const domainEvents = (domainResult.rows || [])
      .filter((row: any) => !auditDuplicateKeys.has(`${row.event_type}|${row.actor_id}|${this.toIso(row.occurred_at)}`))
      .map((row: any) => this.fromDomainEvent(row));
    const storedAudits = auditRows.map((row: any) => this.fromAuditEvent(row));
    const events = [...domainEvents, ...storedAudits].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
    const chain = await verifyTenantAuditChain(this.dbService.db, orgId);
    const exportedEventsVerified = events.filter((event) => event.integrity.verified).length;

    return {
      schema: 'cadena.audit-trail.v1',
      work_item: { id: item.id, key: item.key, type: item.type, title: item.title, status: item.status },
      org_id: orgId,
      generated_at: new Date().toISOString(),
      generated_by: actorId,
      event_count: events.length,
      integrity: {
        ...chain,
        exported_event_count: events.length,
        exported_events_verified: exportedEventsVerified,
        verified: events.length > 0 && chain.chain_verified && exportedEventsVerified === events.length,
      },
      events,
    };
  }

  private fromDomainEvent(row: any): AuditTrailEvent {
    const payload = this.json(row.payload);
    const timestamp = this.toIso(row.occurred_at);
    const integrityInput: IntegrityEventInput = {
      source: 'domain_events',
      event_id: row.event_id,
      org_id: row.org_id,
      work_item_id: row.work_item_id || null,
      event_type: row.event_type,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      payload,
      occurred_at: timestamp,
    };
    let before = this.objectOrNull(payload.before);
    let after = this.objectOrNull(payload.after);

    if (row.event_type === 'WorkItemCreated') {
      before = null;
      after = this.objectOrNull(payload.work_item);
    } else if (row.event_type === 'LinkCreated') {
      before = null;
      after = this.objectOrNull(payload.link);
    } else if (row.event_type === 'WorkItemStateChanged' && !before && !after) {
      before = { status: payload.from_state };
      after = { status: payload.to_state, ...(payload.fields ? { custom_fields: payload.fields } : {}) };
    } else if (!before && !after) {
      after = payload;
    }

    return {
      id: row.event_id,
      event_type: row.event_type,
      actor: { type: row.actor_type, id: row.actor_id },
      timestamp,
      before,
      after,
      metadata: { source: 'domain_events', schema_version: Number(row.schema_version) },
      integrity: this.integrityFor(row, integrityInput),
    };
  }

  private fromAuditEvent(row: any): AuditTrailEvent {
    const payload = this.json(row.payload);
    const timestamp = this.toIso(row.timestamp);
    const integrityInput: IntegrityEventInput = {
      source: 'audit_events',
      event_id: row.id,
      org_id: row.org_id,
      work_item_id: row.work_item_id,
      event_type: row.event_type,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      payload,
      occurred_at: timestamp,
    };
    let before = this.objectOrNull(payload.before);
    let after = this.objectOrNull(payload.after);
    if (row.event_type === 'WorkItemStateChanged' && !before && !after) {
      before = { status: payload.from_state };
      after = { status: payload.to_state, ...(payload.fields ? { custom_fields: payload.fields } : {}) };
    } else if (row.event_type === 'IncidentSeverityEscalated' && !before && !after) {
      before = { severity: payload.from_severity, priority: payload.from_priority ?? null };
      after = { severity: payload.to_severity, priority: payload.to_priority ?? payload.priority };
    }
    return {
      id: row.id,
      event_type: row.event_type,
      actor: { type: row.actor_type, id: row.actor_id },
      timestamp,
      before,
      after,
      metadata: { source: 'audit_events' },
      integrity: this.integrityFor(row, integrityInput),
    };
  }

  private integrityFor(row: any, input: IntegrityEventInput): AuditIntegrityMetadata {
    if (row.sequence !== null && row.sequence !== undefined) return verifyAuditEntry(row, input);
    return {
      algorithm: AUDIT_HASH_ALGORITHM,
      proof_version: AUDIT_PROOF_VERSION,
      sequence: 0,
      previous_hash: null,
      hash: '',
      verified: false,
    };
  }

  private json(value: any): Record<string, any> {
    return (typeof value === 'string' ? JSON.parse(value) : value) || {};
  }

  private objectOrNull(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : null;
  }

  private toIso(value: any): string {
    return new Date(value).toISOString();
  }
}
