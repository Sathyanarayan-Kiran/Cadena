import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import { CustomFieldSchemaService } from './custom-field-schema.service';
import { WorkflowService } from '../workflow/workflow.service';
import {
  CreateWorkItemDto,
  DEFAULT_STATUS,
  VALID_WORK_ITEM_TYPES,
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

export interface ListWorkItemsFilter {
  type?: string;
  state?: string;
  status?: string;
  owner_id?: string;
  team_id?: string;
  aging_bucket?: 'green' | 'amber' | 'red';
}

export class WorkItemService {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();
  private schemaService = new CustomFieldSchemaService();
  private workflowService = new WorkflowService();

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

    await this.dbService.db.query(
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

    await this.eventBus.publish('WorkItemCreated', id, { type: 'user', id: actorId }, { work_item: item });

    return item;
  }

  public async getWorkItemById(id: string, orgId?: string): Promise<WorkItem | null> {
    await this.dbService.initialize();
    const res = orgId
      ? await this.dbService.db.query<any>(
          `SELECT * FROM work_items WHERE id = $1 AND org_id = $2`,
          [id, orgId],
        )
      : await this.dbService.db.query<any>(
          `SELECT * FROM work_items WHERE id = $1`,
          [id],
        );
    if (!res.rows || res.rows.length === 0) return null;
    return this.mapRowToWorkItem(res.rows[0]);
  }

  public async listWorkItems(filter: ListWorkItemsFilter, orgId: string): Promise<WorkItem[]> {
    await this.dbService.initialize();

    let query = `SELECT * FROM work_items WHERE org_id = $1`;
    const params: any[] = [orgId];

    if (filter.type) {
      params.push(filter.type);
      query += ` AND type = $${params.length}`;
    }

    const targetState = filter.state || filter.status;
    if (targetState) {
      params.push(targetState);
      query += ` AND status = $${params.length}`;
    }

    if (filter.owner_id) {
      params.push(filter.owner_id);
      query += ` AND owner_id = $${params.length}`;
    }

    if (filter.team_id) {
      params.push(filter.team_id);
      query += ` AND team_id = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

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
