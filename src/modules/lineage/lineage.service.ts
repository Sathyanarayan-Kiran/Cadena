import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import { ALLOWED_EDGES_BY_PAIR, LinkType, WorkItemLink } from './lineage.types';

export class InvalidEdgeTypeError extends Error {
  constructor(
    public readonly sourceType: string,
    public readonly targetType: string,
    public readonly linkType: string,
    public readonly allowedEdgeTypes: LinkType[],
  ) {
    super(
      `Edge type '${linkType}' is not allowed between '${sourceType}' and '${targetType}'`,
    );
    this.name = 'InvalidEdgeTypeError';
  }
}

export class LineageService {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();

  public async createLink(
    sourceId: string,
    targetId: string,
    linkType: LinkType,
    actorId: string = 'user-1',
  ): Promise<WorkItemLink> {
    await this.dbService.initialize();

    // 1. Fetch source & target work items to check existence & types
    const sourceRes = await this.dbService.db.query<any>(
      `SELECT id, type FROM work_items WHERE id = $1`,
      [sourceId],
    );
    if (!sourceRes.rows || sourceRes.rows.length === 0) {
      throw new Error(`Source work item '${sourceId}' not found`);
    }

    const targetRes = await this.dbService.db.query<any>(
      `SELECT id, type FROM work_items WHERE id = $1`,
      [targetId],
    );
    if (!targetRes.rows || targetRes.rows.length === 0) {
      throw new Error(`Target work item '${targetId}' not found`);
    }

    const sourceType = sourceRes.rows[0].type;
    const targetType = targetRes.rows[0].type;
    const pairKey = `${sourceType}:${targetType}`;
    const allowedEdges = ALLOWED_EDGES_BY_PAIR[pairKey] || ['relates_to'];

    if (!allowedEdges.includes(linkType)) {
      throw new InvalidEdgeTypeError(sourceType, targetType, linkType, allowedEdges);
    }

    // 2. Insert link into work_item_links
    const linkId = randomUUID();
    const now = new Date().toISOString();

    await this.dbService.db.query(
      `INSERT INTO work_item_links (id, source_id, target_id, link_type, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [linkId, sourceId, targetId, linkType, now],
    );

    const link: WorkItemLink = {
      id: linkId,
      source_id: sourceId,
      target_id: targetId,
      link_type: linkType,
      created_at: now,
    };

    // 3. Publish Event
    await this.eventBus.publish(
      'LinkCreated',
      sourceId,
      { type: 'user', id: actorId },
      { link },
    );

    return link;
  }

  public async getItemRelationships(workItemId: string): Promise<{ outgoing: WorkItemLink[]; incoming: WorkItemLink[]; all: WorkItemLink[] }> {
    await this.dbService.initialize();

    const outRes = await this.dbService.db.query<any>(
      `SELECT * FROM work_item_links WHERE source_id = $1 ORDER BY created_at ASC`,
      [workItemId],
    );
    const inRes = await this.dbService.db.query<any>(
      `SELECT * FROM work_item_links WHERE target_id = $1 ORDER BY created_at ASC`,
      [workItemId],
    );

    const outgoing: WorkItemLink[] = (outRes.rows || []).map((row) => this.mapRowToLink(row));
    const incoming: WorkItemLink[] = (inRes.rows || []).map((row) => this.mapRowToLink(row));

    return {
      outgoing,
      incoming,
      all: [...outgoing, ...incoming],
    };
  }

  private mapRowToLink(row: any): WorkItemLink {
    return {
      id: row.id,
      source_id: row.source_id,
      target_id: row.target_id,
      link_type: row.link_type as LinkType,
      created_at: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    };
  }
}
