import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
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

export class WorkItemService {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();

  public async createWorkItem(dto: CreateWorkItemDto, actorId: string = 'system'): Promise<WorkItem> {
    if (!VALID_WORK_ITEM_TYPES.includes(dto.type as WorkItemType)) {
      throw new UnrecognizedTypeError(dto.type);
    }

    const type = dto.type as WorkItemType;
    const id = randomUUID();
    const status = DEFAULT_STATUS[type];
    const now = new Date().toISOString();
    const priority = dto.priority || 'P2';
    const severity = dto.severity || null;
    const description = dto.description || '';
    const customFields = dto.custom_fields || {};
    const tags = dto.tags || [];

    await this.dbService.initialize();

    await this.dbService.db.query(
      `INSERT INTO work_items (
        id, type, title, description, status, workflow_version, priority, severity, owner_id, team_id, org_id, entered_state_at, custom_fields, tags, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        type,
        dto.title,
        description,
        status,
        1,
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

    const item: WorkItem = {
      id,
      type,
      title: dto.title,
      description,
      status,
      workflow_version: 1,
      priority,
      severity,
      owner_id: dto.owner_id || null,
      team_id: dto.team_id,
      org_id: dto.org_id,
      entered_state_at: now,
      custom_fields: customFields,
      tags,
      created_at: now,
      updated_at: now,
    };

    await this.eventBus.publish('WorkItemCreated', id, { type: 'user', id: actorId }, { work_item: item });

    return item;
  }

  public async getWorkItemById(id: string): Promise<WorkItem | null> {
    await this.dbService.initialize();
    const res = await this.dbService.db.query<any>(
      `SELECT * FROM work_items WHERE id = $1`,
      [id],
    );
    if (!res.rows || res.rows.length === 0) return null;
    return this.mapRowToWorkItem(res.rows[0]);
  }

  private mapRowToWorkItem(row: any): WorkItem {
    return {
      id: row.id,
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
      entered_state_at: typeof row.entered_state_at === 'string' ? row.entered_state_at : new Date(row.entered_state_at).toISOString(),
      custom_fields: typeof row.custom_fields === 'string' ? JSON.parse(row.custom_fields) : row.custom_fields || {},
      tags: row.tags || [],
      created_at: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
    };
  }
}
