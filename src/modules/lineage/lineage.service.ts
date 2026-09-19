import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import { ALLOWED_EDGES_BY_PAIR, LinkType, WorkItemLink } from './lineage.types';
import { WorkItemService } from '../work-items/work-item.service';

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

export interface LineageQueryParams {
  workItemId: string;
  orgId?: string;
  direction?: 'up' | 'down';
  depth?: number;
  edgeTypes?: string[];
}

export interface LineageResult {
  root_id: string;
  direction: 'up' | 'down';
  nodes: any[];
  edges: WorkItemLink[];
  chain: any[];
}

export class LineageService {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();
  private workItemService = new WorkItemService();

  public async createLink(
    sourceId: string,
    targetId: string,
    linkType: LinkType,
    actorId: string = 'user-1',
    orgId?: string,
  ): Promise<WorkItemLink> {
    await this.dbService.initialize();

    const sourceRes = await this.dbService.db.query<any>(
      orgId
        ? `SELECT id, type, org_id FROM work_items WHERE id = $1 AND org_id = $2`
        : `SELECT id, type, org_id FROM work_items WHERE id = $1`,
      orgId ? [sourceId, orgId] : [sourceId],
    );
    if (!sourceRes.rows || sourceRes.rows.length === 0) {
      throw new Error(`Source work item '${sourceId}' not found`);
    }

    const targetRes = await this.dbService.db.query<any>(
      orgId
        ? `SELECT id, type, org_id FROM work_items WHERE id = $1 AND org_id = $2`
        : `SELECT id, type, org_id FROM work_items WHERE id = $1`,
      orgId ? [targetId, orgId] : [targetId],
    );
    if (!targetRes.rows || targetRes.rows.length === 0) {
      throw new Error(`Target work item '${targetId}' not found`);
    }
    if (sourceRes.rows[0].org_id !== targetRes.rows[0].org_id) {
      throw new Error('Cross-tenant work item links are not allowed');
    }

    const sourceType = sourceRes.rows[0].type;
    const targetType = targetRes.rows[0].type;
    const pairKey = `${sourceType}:${targetType}`;
    const allowedEdges = ALLOWED_EDGES_BY_PAIR[pairKey] || ['relates_to'];

    if (!allowedEdges.includes(linkType)) {
      throw new InvalidEdgeTypeError(sourceType, targetType, linkType, allowedEdges);
    }

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

    await this.eventBus.publish(
      'LinkCreated',
      sourceId,
      { type: 'user', id: actorId },
      { link },
    );

    return link;
  }

  public async getItemRelationships(workItemId: string, orgId?: string): Promise<{ outgoing: WorkItemLink[]; incoming: WorkItemLink[]; all: WorkItemLink[] }> {
    await this.dbService.initialize();

    if (orgId) {
      const item = await this.workItemService.getWorkItemById(workItemId, orgId);
      if (!item) throw new Error(`Work item '${workItemId}' not found`);
    }

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

  public async getLineage(params: LineageQueryParams): Promise<LineageResult> {
    await this.dbService.initialize();

    const root = await this.workItemService.getWorkItemById(params.workItemId, params.orgId);
    if (!root) throw new Error(`Work item '${params.workItemId}' not found`);

    const direction = params.direction || 'up';
    const maxDepth = params.depth || 10;
    const filterEdgeTypes = params.edgeTypes && params.edgeTypes.length > 0 ? new Set(params.edgeTypes) : null;

    const visitedNodeIds = new Set<string>();
    const visitedEdgeIds = new Set<string>();
    const nodeQueue: { id: string; currentDepth: number }[] = [{ id: params.workItemId, currentDepth: 0 }];

    visitedNodeIds.add(params.workItemId);
    const resultEdges: WorkItemLink[] = [];
    const orderedNodeIds: string[] = [params.workItemId];

    while (nodeQueue.length > 0) {
      const { id: currId, currentDepth } = nodeQueue.shift()!;
      if (currentDepth >= maxDepth) continue;

      // Query links for currId
      const linksRes = params.orgId
        ? await this.dbService.db.query<any>(
            `SELECT link.* FROM work_item_links link
             JOIN work_items source_item ON source_item.id = link.source_id
             JOIN work_items target_item ON target_item.id = link.target_id
             WHERE (link.source_id = $1 OR link.target_id = $1)
               AND source_item.org_id = $2 AND target_item.org_id = $2`,
            [currId, params.orgId],
          )
        : await this.dbService.db.query<any>(
            `SELECT * FROM work_item_links WHERE source_id = $1 OR target_id = $1`,
            [currId],
          );

      for (const row of linksRes.rows || []) {
        const link = this.mapRowToLink(row);
        if (filterEdgeTypes && !filterEdgeTypes.has(link.link_type)) continue;

        const nextId = this.getNextNodeId(link, currId, direction);

        if (nextId && !visitedNodeIds.has(nextId)) {
          visitedNodeIds.add(nextId);
          orderedNodeIds.push(nextId);
          nodeQueue.push({ id: nextId, currentDepth: currentDepth + 1 });
        }

        if (!visitedEdgeIds.has(link.id)) {
          visitedEdgeIds.add(link.id);
          resultEdges.push(link);
        }
      }
    }

    // Fetch node details for orderedNodeIds
    const nodes: any[] = [];
    for (const id of orderedNodeIds) {
      const item = await this.workItemService.getWorkItemById(id, params.orgId);
      if (item) nodes.push(item);
    }

    return {
      root_id: params.workItemId,
      direction,
      nodes,
      edges: resultEdges,
      chain: nodes,
    };
  }

  private getNextNodeId(link: WorkItemLink, currentId: string, direction: 'up' | 'down'): string | null {
    if (link.link_type === 'relates_to') {
      return link.source_id === currentId ? link.target_id : link.source_id;
    }

    const sourcePointsUpstream = new Set<LinkType>([
      'child_of', 'blocked_by', 'caused_by', 'fixed_by', 'deployed_in', 'duplicate_of',
    ]);
    const sourcePointsDownstream = new Set<LinkType>(['parent_of', 'blocks', 'affects']);

    if (sourcePointsUpstream.has(link.link_type)) {
      if (direction === 'up' && link.source_id === currentId) return link.target_id;
      if (direction === 'down' && link.target_id === currentId) return link.source_id;
      return null;
    }

    if (sourcePointsDownstream.has(link.link_type)) {
      if (direction === 'up' && link.target_id === currentId) return link.source_id;
      if (direction === 'down' && link.source_id === currentId) return link.target_id;
    }

    return null;
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
