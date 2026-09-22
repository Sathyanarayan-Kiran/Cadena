import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { DomainEventEnvelope } from '../events/event-bus';
import { EventConsumerRegistry } from '../events/consumer-registry.service';
import { EventOutboxService } from '../events/event-outbox.service';
import { WorkflowService } from '../workflow/workflow.service';
import {
  VALID_WORK_ITEM_TYPES,
  WorkItemPriority,
  WorkItemSeverity,
  WorkItemType,
} from '../work-items/work-item.types';
import { stringList } from './connector-config';

export const TWIN_PROJECTION_CONSUMER = 'twin-work-item-projection';

export interface TwinProjectionConfig {
  /** Projection is on unless explicitly disabled. */
  enabled?: boolean;
  /** Team that owns projected items for SLA policy, rollups and notification routing. */
  teamId?: string;
  /** `entityType` or `entityType:nativeType` (e.g. `issue:Bug`) → Cadena work-item type. */
  typeMap?: Record<string, WorkItemType>;
  /** Native assignee (account id, username or display name) → Cadena person id. */
  ownerMap?: Record<string, string>;
}

export type TwinProjectionStatus = 'pending' | 'projected' | 'held' | 'disabled';

export interface TwinProjectionOutcome {
  twinId: string;
  status: TwinProjectionStatus;
  reason?: string;
  workItemId?: string;
  created?: boolean;
  fieldsChanged?: string[];
  stateChanged?: { from: string; to: string } | null;
}

interface Snapshot {
  title: string;
  status: string;
  fields: Record<string, unknown>;
  sourceUpdatedAt: string;
}

const PRIORITY_BY_NATIVE: Record<string, WorkItemPriority> = {
  highest: 'P0', critical: 'P0', '1': 'P0',
  high: 'P1', '2': 'P1',
  medium: 'P2', moderate: 'P2', '3': 'P2',
  low: 'P3', '4': 'P3',
  lowest: 'P4', planning: 'P4', '5': 'P4',
};
const SEVERITY_BY_PRIORITY: Record<WorkItemPriority, WorkItemSeverity> = { P0: 'SEV1', P1: 'SEV2', P2: 'SEV3', P3: 'SEV4', P4: 'SEV4' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Twin-backed WorkItem projection.
 *
 * Every canonical twin is projected to exactly one `work_items` row (`origin = 'connector'`,
 * `source_twin_id` unique) so the existing SLA, traceability, notification and metrics engines
 * govern connector records without a parallel model. The projection is one-way: it is written
 * only from the twin's committed events, applies a change only if it is newer than what it has
 * already applied, and records native state changes as ordinary `WorkItemStateChanged` history at
 * the time the source changed. Local writers cannot change projected source fields; see
 * `work-item-ownership.ts`.
 */
@Injectable()
export class TwinProjectionService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private workflow = new WorkflowService();

  constructor() {
    new EventConsumerRegistry().register({
      name: TWIN_PROJECTION_CONSUMER,
      eventTypes: ['CanonicalTwinMaterialized', 'CanonicalTwinUpdated', 'CorrelationPairCreated'],
      maxAttempts: 3,
      retryDelayMs: 5,
      handle: (event) => this.handle(event),
    });
  }

  public static validateConfig(input: unknown): TwinProjectionConfig {
    if (input === undefined || input === null) return { enabled: true };
    if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('projection must be an object');
    const raw = input as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((key) => !['enabled', 'teamId', 'typeMap', 'ownerMap'].includes(key));
    if (unknown.length) throw new BadRequestException(`projection does not support ${unknown.join(', ')}`);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new BadRequestException('projection.enabled must be true or false');
    if (raw.teamId !== undefined && (typeof raw.teamId !== 'string' || !UUID.test(raw.teamId))) {
      throw new BadRequestException('projection.teamId must be a team id');
    }
    const typeMap: Record<string, WorkItemType> = {};
    if (raw.typeMap !== undefined) {
      if (!raw.typeMap || typeof raw.typeMap !== 'object' || Array.isArray(raw.typeMap)) {
        throw new BadRequestException('projection.typeMap must map entity types to work-item types');
      }
      for (const [key, value] of Object.entries(raw.typeMap as Record<string, unknown>)) {
        if (!VALID_WORK_ITEM_TYPES.includes(value as WorkItemType)) {
          throw new BadRequestException(`projection.typeMap.${key} must be one of ${VALID_WORK_ITEM_TYPES.join(', ')}`);
        }
        typeMap[key] = value as WorkItemType;
      }
    }
    const ownerMap: Record<string, string> = {};
    if (raw.ownerMap !== undefined) {
      if (!raw.ownerMap || typeof raw.ownerMap !== 'object' || Array.isArray(raw.ownerMap)) {
        throw new BadRequestException('projection.ownerMap must map native assignees to person ids');
      }
      for (const [key, value] of Object.entries(raw.ownerMap as Record<string, unknown>)) {
        if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException(`projection.ownerMap.${key} must be a person id`);
        ownerMap[key] = value;
      }
    }
    return {
      enabled: raw.enabled !== false,
      ...(raw.teamId ? { teamId: raw.teamId as string } : {}),
      ...(Object.keys(typeMap).length ? { typeMap } : {}),
      ...(Object.keys(ownerMap).length ? { ownerMap } : {}),
    };
  }

  private async handle(event: DomainEventEnvelope): Promise<void> {
    const payload = event.payload || {};
    const orgId = String(payload.org_id || '');
    if (!orgId) return;
    if (event.event_type === 'CorrelationPairCreated') {
      await this.linkCorrelation(orgId, String(payload.correlation_id || event.work_item_id));
      return;
    }
    const twinId = String(payload.twin_id || event.work_item_id || '');
    if (!twinId) return;
    await this.projectTwin(orgId, twinId, payload.source_updated_at ? {
      title: String(payload.title ?? ''),
      status: String(payload.native_status ?? ''),
      fields: (payload.fields && typeof payload.fields === 'object') ? payload.fields : {},
      sourceUpdatedAt: String(payload.source_updated_at),
    } : undefined);
  }

  /** Projects one twin from an event snapshot, or from its current row when none is given. */
  public async projectTwin(orgId: string, twinId: string, snapshot?: Snapshot): Promise<TwinProjectionOutcome> {
    await this.dbService.initialize();
    const twinRes = await this.dbService.db.query<any>(
      `SELECT t.*, c.config AS connector_config, c.name AS connector_name
       FROM integration_canonical_twins t
       JOIN integration_connectors c ON c.id = t.connector_id AND c.org_id = t.org_id
       WHERE t.id = $1 AND t.org_id = $2`,
      [twinId, orgId],
    );
    const twin = twinRes.rows[0];
    if (!twin) return { twinId, status: 'held', reason: 'twin_not_found' };
    const connectorConfig = parse(twin.connector_config, {} as Record<string, any>);
    const config = TwinProjectionService.validateConfig(connectorConfig.projection);
    const state: Snapshot = snapshot || {
      title: twin.title || '',
      status: twin.native_status || '',
      fields: parse(twin.payload, {}),
      sourceUpdatedAt: iso(twin.source_updated_at) || new Date().toISOString(),
    };

    if (!config.enabled) return this.markTwin(orgId, twinId, 'disabled', 'Projection is disabled for this connector');
    const type = this.resolveType(twin.provider, twin.artifact_type, state.fields, config);
    if (!type) {
      return this.markTwin(orgId, twinId, 'held', `No work-item type is mapped for ${twin.provider} ${twin.artifact_type}; set projection.typeMap`);
    }
    const teamId = await this.resolveTeam(orgId, config);
    if (!teamId) {
      return this.markTwin(orgId, twinId, 'held', 'No owning team is configured; set projection.teamId for this connector');
    }

    const priority = this.resolvePriority(state.fields);
    const desired = {
      type,
      title: (state.title || twin.native_key || twin.external_id).slice(0, 500),
      description: plainText(state.fields.description),
      priority,
      severity: type === 'incident' ? SEVERITY_BY_PRIORITY[priority] : null,
      owner_id: await this.resolveOwner(orgId, state.fields, config),
      team_id: teamId,
    };
    const actor = { type: 'integration' as const, id: `connector:${twin.connector_id}` };
    const source = {
      system: twin.provider,
      twin_id: twinId,
      connector_id: twin.connector_id,
      native_key: twin.native_key || twin.external_id,
      native_url: twin.native_url || null,
      source_updated_at: state.sourceUpdatedAt,
    };

    const existingRes = await this.dbService.db.query<any>(
      `SELECT * FROM work_items WHERE org_id = $1 AND source_twin_id = $2`,
      [orgId, twinId],
    );
    const existing = existingRes.rows[0];

    if (!existing) {
      const id = randomUUID();
      const created = await this.dbService.db.transaction(async (tx) => {
        const inserted = await tx.query<any>(
          `INSERT INTO work_items
           (id, item_key, type, title, description, status, workflow_version, priority, severity, owner_id, team_id,
            org_id, entered_state_at, custom_fields, tags, created_at, updated_at, origin, source_twin_id,
            source_connector_id, source_system, native_url, source_updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, '{}', '{}', $17,
                   CURRENT_TIMESTAMP, 'connector', $13, $14, $15, $16, $12)
           ON CONFLICT (org_id, source_twin_id) WHERE source_twin_id IS NOT NULL DO NOTHING
           RETURNING *`,
          [
            id, source.native_key, desired.type, desired.title, desired.description, state.status,
            desired.priority, desired.severity, desired.owner_id, desired.team_id, orgId, state.sourceUpdatedAt,
            twinId, twin.connector_id, twin.provider, source.native_url,
            // Flow metrics measure from when the record was opened in its source, not when Cadena saw it.
            sourceCreatedAt(state.fields) || state.sourceUpdatedAt,
          ],
        );
        if (!inserted.rows.length) return null;
        await tx.query(
          `UPDATE integration_canonical_twins SET work_item_id = $1, projection_status = 'projected', projection_reason = NULL
           WHERE id = $2 AND org_id = $3`,
          [id, twinId, orgId],
        );
        return this.outbox.enqueue(tx, {
          event_type: 'WorkItemCreated',
          work_item_id: id,
          org_id: orgId,
          actor,
          payload: { org_id: orgId, work_item: inserted.rows[0], source },
        });
      });
      if (!created) return this.projectTwin(orgId, twinId, snapshot); // lost a race; apply as an update
      await this.outbox.dispatch(created);
      await this.linkCounterparts(orgId, twin.correlation_node_id, actor.id);
      return { twinId, status: 'projected', workItemId: id, created: true, fieldsChanged: [], stateChanged: null };
    }

    // Replays and out-of-order deliveries never move a projection backwards.
    const appliedAt = iso(existing.source_updated_at);
    if (appliedAt && Date.parse(state.sourceUpdatedAt) < Date.parse(appliedAt)) {
      await this.markTwin(orgId, twinId, 'projected', null, existing.id);
      return { twinId, status: 'projected', workItemId: existing.id, fieldsChanged: [], stateChanged: null };
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of ['type', 'title', 'description', 'priority', 'severity', 'owner_id', 'team_id'] as const) {
      const current = existing[field] ?? null;
      const next = desired[field] ?? null;
      if (current !== next) {
        before[field] = current;
        after[field] = next;
      }
    }
    const changed = Object.keys(after);
    const event = await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE work_items
         SET type = $1, title = $2, description = $3, priority = $4, severity = $5, owner_id = $6, team_id = $7,
             item_key = $8, native_url = $9, source_updated_at = GREATEST(COALESCE(source_updated_at, $10), $10),
             updated_at = CASE WHEN $11 THEN CURRENT_TIMESTAMP ELSE updated_at END
         WHERE id = $12 AND org_id = $13`,
        [
          desired.type, desired.title, desired.description, desired.priority, desired.severity, desired.owner_id,
          desired.team_id, source.native_key, source.native_url, state.sourceUpdatedAt, changed.length > 0,
          existing.id, orgId,
        ],
      );
      await tx.query(
        `UPDATE integration_canonical_twins SET work_item_id = $1, projection_status = 'projected', projection_reason = NULL
         WHERE id = $2 AND org_id = $3`,
        [existing.id, twinId, orgId],
      );
      if (!changed.length) return null;
      return this.outbox.enqueue(tx, {
        event_type: 'WorkItemFieldsChanged',
        work_item_id: existing.id,
        org_id: orgId,
        actor,
        payload: { org_id: orgId, before, after, source },
      });
    });
    if (event) await this.outbox.dispatch(event);

    let stateChanged: TwinProjectionOutcome['stateChanged'] = null;
    if (state.status && state.status !== existing.status) {
      const applied = await this.workflow.applySourceStateChange({
        workItemId: existing.id,
        orgId,
        toState: state.status,
        at: state.sourceUpdatedAt,
        actorId: actor.id,
        source,
      });
      if (applied) stateChanged = { from: applied.from_state, to: applied.to_state };
    }
    await this.linkCounterparts(orgId, twin.correlation_node_id, actor.id);
    return { twinId, status: 'projected', workItemId: existing.id, fieldsChanged: changed, stateChanged };
  }

  /** Re-projects every twin of a connector from its current row, e.g. after a configuration change. */
  public async projectConnector(orgId: string, connectorId: string): Promise<Record<TwinProjectionStatus, number>> {
    const twins = await this.dbService.db.query<any>(
      `SELECT id FROM integration_canonical_twins WHERE org_id = $1 AND connector_id = $2 ORDER BY created_at, id`,
      [orgId, connectorId],
    );
    const totals: Record<TwinProjectionStatus, number> = { pending: 0, projected: 0, held: 0, disabled: 0 };
    for (const row of twins.rows) totals[(await this.projectTwin(orgId, row.id)).status]++;
    return totals;
  }

  private async markTwin(
    orgId: string,
    twinId: string,
    status: TwinProjectionStatus,
    reason: string | null,
    workItemId?: string,
  ): Promise<TwinProjectionOutcome> {
    await this.dbService.db.query(
      `UPDATE integration_canonical_twins
       SET projection_status = $1, projection_reason = $2, work_item_id = COALESCE($3, work_item_id)
       WHERE id = $4 AND org_id = $5`,
      [status, reason, workItemId || null, twinId, orgId],
    );
    return { twinId, status, ...(reason ? { reason } : {}), ...(workItemId ? { workItemId } : {}) };
  }

  /** Mirrors US13.2 counterpart correlations as Cadena-owned `relates_to` traceability links. */
  private async linkCorrelation(orgId: string, correlationId: string): Promise<void> {
    const link = await this.dbService.db.query<any>(
      `SELECT source_node_id, target_node_id FROM integration_correlation_links
       WHERE id = $1 AND org_id = $2 AND relationship = 'counterpart'`,
      [correlationId, orgId],
    );
    if (!link.rows[0]) return;
    await this.linkCounterparts(orgId, link.rows[0].source_node_id, 'correlation');
  }

  private async linkCounterparts(orgId: string, nodeId: string | null, actorId: string): Promise<void> {
    if (!nodeId) return;
    const pairs = await this.dbService.db.query<any>(
      `SELECT own.id AS own_item, other.id AS other_item
       FROM integration_correlation_links l
       JOIN integration_canonical_twins ot ON ot.org_id = l.org_id AND ot.correlation_node_id = $2
       JOIN integration_canonical_twins tt ON tt.org_id = l.org_id
        AND tt.correlation_node_id = CASE WHEN l.source_node_id = $2 THEN l.target_node_id ELSE l.source_node_id END
       JOIN work_items own ON own.org_id = l.org_id AND own.source_twin_id = ot.id
       JOIN work_items other ON other.org_id = l.org_id AND other.source_twin_id = tt.id
       WHERE l.org_id = $1 AND l.relationship = 'counterpart' AND (l.source_node_id = $2 OR l.target_node_id = $2)`,
      [orgId, nodeId],
    );
    for (const pair of pairs.rows) {
      const exists = await this.dbService.db.query<any>(
        `SELECT 1 FROM work_item_links
         WHERE origin = 'correlation'
           AND ((source_id = $1 AND target_id = $2) OR (source_id = $2 AND target_id = $1))`,
        [pair.own_item, pair.other_item],
      );
      if (exists.rows.length) continue;
      const linkId = randomUUID();
      const now = new Date().toISOString();
      const event = await this.dbService.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO work_item_links (id, source_id, target_id, link_type, created_at, origin)
           VALUES ($1, $2, $3, 'relates_to', $4, 'correlation')`,
          [linkId, pair.own_item, pair.other_item, now],
        );
        return this.outbox.enqueue(tx, {
          event_type: 'LinkCreated',
          work_item_id: pair.own_item,
          org_id: orgId,
          actor: { type: 'integration', id: actorId },
          payload: {
            org_id: orgId,
            origin: 'correlation',
            link: { id: linkId, source_id: pair.own_item, target_id: pair.other_item, link_type: 'relates_to', created_at: now },
          },
          timestamp: now,
        });
      });
      await this.outbox.dispatch(event);
    }
  }

  private resolveType(
    provider: string,
    entityType: string,
    fields: Record<string, unknown>,
    config: TwinProjectionConfig,
  ): WorkItemType | null {
    const nativeType = typeof fields.issueType === 'string' ? fields.issueType : null;
    const mapped = (nativeType && config.typeMap?.[`${entityType}:${nativeType}`]) || config.typeMap?.[entityType];
    if (mapped) return mapped;
    if (provider === 'jira' && entityType === 'issue') return nativeType?.toLowerCase() === 'epic' ? 'epic' : 'story';
    if (provider === 'servicenow' && (entityType === 'incident' || entityType === 'problem')) return 'incident';
    if (provider === 'servicenow' && entityType === 'change_request') return 'release';
    return null;
  }

  private resolvePriority(fields: Record<string, unknown>): WorkItemPriority {
    const raw = typeof fields.priority === 'string' ? fields.priority.trim().toLowerCase() : '';
    const token = raw.match(/^(\d)\b/)?.[1] || raw.split(/\s|-/)[0];
    return PRIORITY_BY_NATIVE[token] || PRIORITY_BY_NATIVE[raw] || 'P2';
  }

  private async resolveTeam(orgId: string, config: TwinProjectionConfig): Promise<string | null> {
    if (config.teamId) {
      const team = await this.dbService.db.query<any>(`SELECT id FROM teams WHERE id = $1 AND org_id = $2`, [config.teamId, orgId]);
      return team.rows[0]?.id || null;
    }
    // A tenant with exactly one team has an unambiguous owner.
    const teams = await this.dbService.db.query<any>(`SELECT id FROM teams WHERE org_id = $1 LIMIT 2`, [orgId]);
    return teams.rows.length === 1 ? teams.rows[0].id : null;
  }

  private async resolveOwner(orgId: string, fields: Record<string, unknown>, config: TwinProjectionConfig): Promise<string | null> {
    if (!config.ownerMap) return null;
    const candidates = stringList([fields.assigneeAccountId, fields.assignee, fields.assigned_to]);
    const personId = candidates.map((candidate) => config.ownerMap![candidate]).find(Boolean);
    if (!personId) return null;
    const person = await this.dbService.db.query<any>(`SELECT id FROM people WHERE id = $1 AND org_id = $2`, [personId, orgId]);
    return person.rows[0]?.id || null;
  }
}

function sourceCreatedAt(fields: Record<string, unknown>): string | null {
  const value = typeof fields.createdAt === 'string' ? Date.parse(fields.createdAt) : NaN;
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/** Jira v3 descriptions are Atlassian Document Format; the projection keeps their plain text. */
export function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const parts: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
      if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type)) parts.push('\n');
    }
  };
  walk(value);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function parse<T>(value: unknown, fallback: T): T {
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
