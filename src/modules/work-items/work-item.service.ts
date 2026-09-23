import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import { CustomFieldSchemaService } from './custom-field-schema.service';
import { WorkflowService } from '../workflow/workflow.service';
import { CADENA_OWNED_PROJECTED_FIELDS, ExternallyOwnedWorkItemError } from './work-item-ownership';
import {
  CreateWorkItemDto,
  DEFAULT_STATUS,
  UpdateWorkItemDto,
  VALID_WORK_ITEM_TYPES,
  VALID_PRIORITIES,
  VALID_SEVERITIES,
  WorkItem,
  WorkItemType,
} from './work-item.types';

export class UnrecognizedTypeError extends Error {
  public readonly valid_types = VALID_WORK_ITEM_TYPES;
  constructor(public readonly type: string) {
    super(`Unrecognized work item type: '${type}'`);
    this.name = 'UnrecognizedTypeError';
  }
}

export class InvalidCustomFieldsError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Custom fields validation failed: ${errors.join(', ')}`);
    this.name = 'InvalidCustomFieldsError';
  }
}

export class InvalidWorkItemUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkItemUpdateError';
  }
}

export interface ListWorkItemsFilter {
  type?: string;
  state?: string;
  status?: string;
  owner_id?: string;
  team_id?: string;
  aging_bucket?: 'green' | 'amber' | 'red';
}

/**
 * Every read joins the owning twin's live projection status, so a projected item can report
 * `source.frozen` when its connector's projection has been disabled (or the twin is held) and it
 * has therefore stopped receiving updates, rather than silently looking current.
 */
const PROJECTED_ITEM_SELECT = `
  SELECT wi.*, t.projection_status AS twin_projection_status
  FROM work_items wi
  LEFT JOIN integration_canonical_twins t ON t.id = wi.source_twin_id AND t.org_id = wi.org_id
`;

export class WorkItemService {
  private dbService = DatabaseService.getInstance();
  private schemaService = new CustomFieldSchemaService();
  private workflowService = new WorkflowService();

  constructor(private readonly outbox = new EventOutboxService()) {}

  public async createWorkItem(dto: CreateWorkItemDto, actorId: string = 'system'): Promise<WorkItem> {
    if (!VALID_WORK_ITEM_TYPES.includes(dto.type as WorkItemType)) {
      throw new UnrecognizedTypeError(dto.type);
    }

    const type = dto.type as WorkItemType;
    const customFields = dto.custom_fields || {};

    // Validate custom fields
    const schemaDef = await this.schemaService.getLatestSchema(type);
    if (schemaDef) {
      const valResult = this.schemaService.validateCustomFields(schemaDef.schema, customFields);
      if (!valResult.valid) {
        throw new InvalidCustomFieldsError(valResult.errors || []);
      }
    }

    // Lookup latest workflow definition
    const activeWorkflow = await this.workflowService.getWorkflowDefinition(type);
    const workflowVersion = activeWorkflow ? activeWorkflow.version : 1;
    const initialStatus = activeWorkflow?.definition?.initial_state || DEFAULT_STATUS[type];

    const id = randomUUID();
    const itemKey = this.createItemKey(type, id);
    const now = new Date().toISOString();
    const priority = dto.priority || 'P2';
    const severity = dto.severity || null;
    const description = dto.description || '';
    const tags = dto.tags || [];

    await this.dbService.initialize();

    const mergedCustomFields = schemaDef?.defaults
      ? { ...schemaDef.defaults, ...customFields }
      : customFields;

    const item: WorkItem = {
      id,
      key: itemKey,
      type,
      title: dto.title,
      description,
      status: initialStatus,
      workflow_version: workflowVersion,
      priority,
      severity,
      owner_id: dto.owner_id || null,
      team_id: dto.team_id,
      org_id: dto.org_id,
      entered_state_at: now,
      custom_fields: mergedCustomFields,
      tags,
      created_at: now,
      updated_at: now,
      aging_bucket: 'green',
      aging_score: 0,
      sla_elapsed_minutes: 0,
      sla_suspended: false,
      escalated_at: null,
    };

    const event = await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO work_items (
          id, item_key, type, title, description, status, workflow_version, priority, severity, owner_id, team_id, org_id, entered_state_at, custom_fields, tags, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id,
          itemKey,
          type,
          dto.title,
          description,
          initialStatus,
          workflowVersion,
          priority,
          severity,
          dto.owner_id || null,
          dto.team_id,
          dto.org_id,
          now,
          JSON.stringify(customFields),
          tags,
          now,
          now,
        ],
      );
      return this.outbox.enqueue(tx, {
        event_type: 'WorkItemCreated',
        work_item_id: id,
        org_id: dto.org_id,
        actor: { type: 'user', id: actorId },
        payload: { work_item: item },
        timestamp: now,
      });
    });

    await this.outbox.dispatch(event);

    return item;
  }

  public async getWorkItemById(id: string, orgId?: string): Promise<WorkItem | null> {
    await this.dbService.initialize();
    const res = orgId
      ? await this.dbService.db.query<any>(
          `${PROJECTED_ITEM_SELECT} WHERE wi.id = $1 AND wi.org_id = $2`,
          [id, orgId],
        )
      : await this.dbService.db.query<any>(
          `${PROJECTED_ITEM_SELECT} WHERE wi.id = $1`,
          [id],
        );
    if (!res.rows || res.rows.length === 0) return null;
    return this.mapRowToWorkItem(res.rows[0]);
  }

  /**
   * Updates the mutable WorkItem fields and commits a before/after event atomically.
   * Status is deliberately absent: lifecycle changes must continue through WorkflowService.
   */
  public async updateWorkItem(
    id: string,
    orgId: string,
    dto: UpdateWorkItemDto,
    actorId: string = 'system',
  ): Promise<WorkItem | null> {
    await this.dbService.initialize();
    const current = await this.getWorkItemById(id, orgId);
    if (!current) return null;

    const allowed = new Set(['title', 'description', 'priority', 'severity', 'owner_id', 'custom_fields', 'tags']);
    const unknown = Object.keys(dto as Record<string, unknown>).filter((field) => !allowed.has(field));
    if (unknown.length) {
      throw new InvalidWorkItemUpdateError(`Fields cannot be edited through this endpoint: ${unknown.join(', ')}`);
    }
    if (current.origin === 'connector') {
      const owned = Object.keys(dto as Record<string, unknown>)
        .filter((field) => (dto as Record<string, unknown>)[field] !== undefined && !CADENA_OWNED_PROJECTED_FIELDS.has(field));
      if (owned.length) {
        throw new ExternallyOwnedWorkItemError({
          id: current.id,
          item_key: current.key,
          source_twin_id: current.source?.twin_id,
          source_system: current.source?.system,
        }, owned);
      }
    }
    if (dto.title !== undefined && (!dto.title.trim() || dto.title.length > 500)) {
      throw new InvalidWorkItemUpdateError('title must contain 1 to 500 characters');
    }
    if (dto.priority !== undefined && !VALID_PRIORITIES.includes(dto.priority)) {
      throw new InvalidWorkItemUpdateError(`priority must be one of ${VALID_PRIORITIES.join(', ')}`);
    }
    if (dto.severity !== undefined && dto.severity !== null && !VALID_SEVERITIES.includes(dto.severity)) {
      throw new InvalidWorkItemUpdateError(`severity must be one of ${VALID_SEVERITIES.join(', ')} or null`);
    }
    if (dto.tags !== undefined && (!Array.isArray(dto.tags) || dto.tags.some((tag) => typeof tag !== 'string'))) {
      throw new InvalidWorkItemUpdateError('tags must be an array of strings');
    }
    if (dto.custom_fields !== undefined && (dto.custom_fields === null || Array.isArray(dto.custom_fields) || typeof dto.custom_fields !== 'object')) {
      throw new InvalidWorkItemUpdateError('custom_fields must be an object');
    }

    const nextCustomFields = dto.custom_fields === undefined
      ? current.custom_fields
      : { ...current.custom_fields, ...dto.custom_fields };
    if (dto.custom_fields !== undefined) {
      const schemaDef = await this.schemaService.getLatestSchema(current.type);
      if (schemaDef) {
        const validation = this.schemaService.validateCustomFields(schemaDef.schema, nextCustomFields);
        if (!validation.valid) throw new InvalidCustomFieldsError(validation.errors || []);
      }
    }

    const next = {
      title: dto.title === undefined ? current.title : dto.title.trim(),
      description: dto.description === undefined ? current.description : dto.description,
      priority: dto.priority === undefined ? current.priority : dto.priority,
      severity: dto.severity === undefined ? current.severity ?? null : dto.severity,
      owner_id: dto.owner_id === undefined ? current.owner_id ?? null : dto.owner_id,
      custom_fields: nextCustomFields,
      tags: dto.tags === undefined ? current.tags : dto.tags,
    };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of allowed) {
      if ((dto as Record<string, unknown>)[field] === undefined) continue;
      const oldValue = (current as unknown as Record<string, unknown>)[field];
      const newValue = (next as Record<string, unknown>)[field];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        before[field] = oldValue;
        after[field] = newValue;
      }
    }
    if (!Object.keys(after).length) return current;

    const now = new Date().toISOString();
    const event = await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE work_items
         SET title = $1, description = $2, priority = $3, severity = $4, owner_id = $5,
             custom_fields = $6, tags = $7, updated_at = $8
         WHERE id = $9 AND org_id = $10`,
        [next.title, next.description, next.priority, next.severity, next.owner_id,
          JSON.stringify(next.custom_fields), next.tags, now, id, orgId],
      );
      return this.outbox.enqueue(tx, {
        event_type: 'WorkItemFieldsChanged',
        work_item_id: id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: { before, after },
        timestamp: now,
      });
    });
    await this.outbox.dispatch(event);
    return this.getWorkItemById(id, orgId);
  }

  public async listWorkItems(filter: ListWorkItemsFilter, orgId: string): Promise<WorkItem[]> {
    await this.dbService.initialize();

    let query = `${PROJECTED_ITEM_SELECT} WHERE wi.org_id = $1`;
    const params: any[] = [orgId];

    if (filter.type) {
      params.push(filter.type);
      query += ` AND wi.type = $${params.length}`;
    }

    const targetState = filter.state || filter.status;
    if (targetState) {
      params.push(targetState);
      query += ` AND wi.status = $${params.length}`;
    }

    if (filter.owner_id) {
      params.push(filter.owner_id);
      query += ` AND wi.owner_id = $${params.length}`;
    }

    if (filter.team_id) {
      params.push(filter.team_id);
      query += ` AND wi.team_id = $${params.length}`;
    }

    query += ` ORDER BY wi.created_at DESC`;

    const res = await this.dbService.db.query<any>(query, params);
    const mapped = await Promise.all((res.rows || []).map((row) => this.mapRowToWorkItem(row)));

    if (filter.aging_bucket) {
      return mapped.filter((item) => item.aging_bucket === filter.aging_bucket);
    }

    return mapped;
  }

  private async mapRowToWorkItem(row: any): Promise<WorkItem> {
    const rawCustomFields = typeof row.custom_fields === 'string' ? JSON.parse(row.custom_fields) : row.custom_fields || {};
    const enteredStateAt = typeof row.entered_state_at === 'string' ? row.entered_state_at : new Date(row.entered_state_at).toISOString();

    const schemaDef = await this.schemaService.getLatestSchema(row.type);
    const customFields = schemaDef?.defaults
      ? { ...schemaDef.defaults, ...rawCustomFields }
      : rawCustomFields;

    const persistedBucket = row.aging_bucket;
    const agingBucket = persistedBucket === 'amber' || persistedBucket === 'red'
      ? persistedBucket
      : 'green';
    const agingScore = Number(row.aging_score || 0);

    return {
      id: row.id,
      key: row.item_key || this.createItemKey(row.type as WorkItemType, row.id),
      type: row.type as WorkItemType,
      title: row.title,
      description: row.description,
      status: row.status,
      workflow_version: row.workflow_version,
      priority: row.priority,
      severity: row.severity,
      owner_id: row.owner_id,
      team_id: row.team_id,
      org_id: row.org_id,
      entered_state_at: enteredStateAt,
      custom_fields: customFields,
      tags: row.tags || [],
      created_at: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
      aging_bucket: agingBucket,
      aging_score: agingScore,
      sla_elapsed_minutes: Number(row.sla_elapsed_minutes || 0),
      sla_suspended: Boolean(row.sla_suspended),
      escalated_at: row.escalated_at
        ? (typeof row.escalated_at === 'string' ? row.escalated_at : new Date(row.escalated_at).toISOString())
        : null,
      origin: row.origin === 'connector' ? 'connector' : 'local',
      source: row.origin === 'connector' && row.source_twin_id
        ? {
          system: row.source_system,
          twin_id: row.source_twin_id,
          connector_id: row.source_connector_id || null,
          native_key: row.item_key,
          native_url: row.native_url || null,
          source_updated_at: row.source_updated_at ? new Date(row.source_updated_at).toISOString() : null,
          // True once the connector's projection stops being 'projected' (disabled, or held after
          // a configuration change) — this item still reflects the last successful sync and no
          // longer updates. Unknown (no twin row at all, which should not happen) is treated as
          // frozen too, since an operator should never be told stale data is current by default.
          frozen: row.twin_projection_status !== 'projected',
        }
        : null,
    };
  }

  private createItemKey(type: WorkItemType, id: string): string {
    const prefix: Record<WorkItemType, string> = {
      epic: 'EPIC',
      story: 'STORY',
      incident: 'INC',
      release: 'REL',
    };
    return `${prefix[type]}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }
}
