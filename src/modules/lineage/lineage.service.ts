import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import {
  ALLOWED_EDGES_BY_PAIR,
  LineageExportDocument,
  LinkType,
  WorkItemLink,
} from './lineage.types';
import { WorkItemService } from '../work-items/work-item.service';
import { WorkItem } from '../work-items/work-item.types';

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

export class LineageExportNotFoundError extends Error {
  constructor(exportId: string) {
    super(`Lineage export '${exportId}' not found`);
    this.name = 'LineageExportNotFoundError';
  }
}

export class LineageWorkItemNotFoundError extends Error {
  constructor(workItemId: string) {
    super(`Work item '${workItemId}' not found`);
    this.name = 'LineageWorkItemNotFoundError';
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

export interface LineageGraphNode extends WorkItem {
  distance: number;
  directions: Array<'root' | 'up' | 'down'>;
}

export interface LineageGraphResult {
  root_id: string;
  depth: number;
  nodes: LineageGraphNode[];
  edges: WorkItemLink[];
  summary: {
    node_count: number;
    edge_count: number;
    upstream_nodes: number;
    downstream_nodes: number;
  };
}

interface TraversalResult {
  orderedNodeIds: string[];
  distances: Map<string, number>;
  edges: WorkItemLink[];
}

export class LineageService {
  private dbService = DatabaseService.getInstance();
  private workItemService = new WorkItemService();

  constructor(private readonly outbox = new EventOutboxService()) {}

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

    const link: WorkItemLink = {
      id: linkId,
      source_id: sourceId,
      target_id: targetId,
      link_type: linkType,
      created_at: now,
    };

    const tenantId = sourceRes.rows[0].org_id;
    const event = await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO work_item_links (id, source_id, target_id, link_type, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [linkId, sourceId, targetId, linkType, now],
      );
      return this.outbox.enqueue(tx, {
        event_type: 'LinkCreated',
        work_item_id: sourceId,
        org_id: tenantId,
        actor: { type: 'user', id: actorId },
        payload: { org_id: tenantId, link },
        timestamp: now,
      });
    });

    await this.outbox.dispatch(event);

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
    const traversal = await this.traverseLineage(params, direction, maxDepth);

    const nodes: any[] = [];
    for (const id of traversal.orderedNodeIds) {
      const item = await this.workItemService.getWorkItemById(id, params.orgId);
      if (item) nodes.push(item);
    }

    return {
      root_id: params.workItemId,
      direction,
      nodes,
      edges: traversal.edges,
      chain: nodes,
    };
  }

  /** Returns both semantic directions in one bounded graph for the interactive explorer. */
  public async getLineageGraph(
    workItemId: string,
    orgId: string,
    depth: number,
  ): Promise<LineageGraphResult> {
    await this.dbService.initialize();
    const root = await this.workItemService.getWorkItemById(workItemId, orgId);
    if (!root) throw new LineageWorkItemNotFoundError(workItemId);

    const params: LineageQueryParams = { workItemId, orgId };
    const upstream = await this.traverseLineage(params, 'up', depth);
    const downstream = await this.traverseLineage(params, 'down', depth);
    const nodeMeta = new Map<string, { distance: number; directions: Set<'up' | 'down'> }>();

    const mergeTraversal = (result: TraversalResult, direction: 'up' | 'down') => {
      for (const id of result.orderedNodeIds) {
        if (id === workItemId) continue;
        const distance = result.distances.get(id) || 0;
        const current = nodeMeta.get(id) || { distance, directions: new Set<'up' | 'down'>() };
        current.distance = Math.min(current.distance, distance);
        current.directions.add(direction);
        nodeMeta.set(id, current);
      }
    };
    mergeTraversal(upstream, 'up');
    mergeTraversal(downstream, 'down');

    const nodes: LineageGraphNode[] = [{ ...root, distance: 0, directions: ['root'] }];
    const orderedIds = [...nodeMeta.keys()].sort((left, right) => {
      const a = nodeMeta.get(left)!;
      const b = nodeMeta.get(right)!;
      const aDirection = a.directions.has('up') ? 0 : 1;
      const bDirection = b.directions.has('up') ? 0 : 1;
      return aDirection - bDirection || a.distance - b.distance || left.localeCompare(right);
    });
    for (const id of orderedIds) {
      const item = await this.workItemService.getWorkItemById(id, orgId);
      if (!item) continue;
      const meta = nodeMeta.get(id)!;
      nodes.push({ ...item, distance: meta.distance, directions: [...meta.directions] });
    }

    const edgeMap = new Map<string, WorkItemLink>();
    for (const edge of [...upstream.edges, ...downstream.edges]) edgeMap.set(edge.id, edge);
    const edges = [...edgeMap.values()].sort(
      (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
    );

    return {
      root_id: workItemId,
      depth,
      nodes,
      edges,
      summary: {
        node_count: nodes.length,
        edge_count: edges.length,
        upstream_nodes: [...nodeMeta.values()].filter((meta) => meta.directions.has('up')).length,
        downstream_nodes: [...nodeMeta.values()].filter((meta) => meta.directions.has('down')).length,
      },
    };
  }

  /**
   * Captures the complete connected component around a work item as an immutable report.
   * The report is stored rather than recreated on download so an audit keeps the exact
   * graph, labels and timestamps that existed when the reviewer requested it.
   */
  public async createLineageExport(
    workItemId: string,
    orgId: string,
    actorId: string,
  ): Promise<LineageExportDocument> {
    await this.dbService.initialize();

    const root = await this.workItemService.getWorkItemById(workItemId, orgId);
    if (!root) throw new LineageWorkItemNotFoundError(workItemId);

    const visitedNodeIds = new Set<string>([workItemId]);
    const visitedEdgeIds = new Set<string>();
    const orderedNodeIds = [workItemId];
    const queue = [workItemId];
    const edges: WorkItemLink[] = [];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const result = await this.dbService.db.query<any>(
        `SELECT link.* FROM work_item_links link
         JOIN work_items source_item ON source_item.id = link.source_id
         JOIN work_items target_item ON target_item.id = link.target_id
         WHERE (link.source_id = $1 OR link.target_id = $1)
           AND source_item.org_id = $2 AND target_item.org_id = $2
         ORDER BY link.created_at ASC, link.id ASC`,
        [currentId, orgId],
      );

      for (const row of result.rows || []) {
        const link = this.mapRowToLink(row);
        if (!visitedEdgeIds.has(link.id)) {
          visitedEdgeIds.add(link.id);
          edges.push(link);
        }

        const connectedId = link.source_id === currentId ? link.target_id : link.source_id;
        if (!visitedNodeIds.has(connectedId)) {
          visitedNodeIds.add(connectedId);
          orderedNodeIds.push(connectedId);
          queue.push(connectedId);
        }
      }
    }

    const nodes: LineageExportDocument['nodes'] = [];
    for (const id of orderedNodeIds) {
      const item = await this.workItemService.getWorkItemById(id, orgId);
      if (!item) continue;
      nodes.push({
        id: item.id,
        key: item.key,
        type: item.type,
        title: item.title,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
      });
    }

    const exportId = randomUUID();
    const generatedAt = new Date().toISOString();
    const report: LineageExportDocument = {
      schema: 'cadena.lineage-report.v1',
      export_id: exportId,
      root_work_item_id: workItemId,
      root_key: root.key,
      org_id: orgId,
      generated_at: generatedAt,
      generated_by: actorId,
      download_url: `/workitems/${workItemId}/lineage-exports/${exportId}`,
      summary: { node_count: nodes.length, edge_count: edges.length },
      nodes,
      edges,
    };

    await this.dbService.db.query(
      `INSERT INTO lineage_exports
       (id, org_id, root_work_item_id, created_by, report, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [exportId, orgId, workItemId, actorId, JSON.stringify(report), generatedAt],
    );

    return report;
  }

  public async getLineageExport(
    workItemId: string,
    exportId: string,
    orgId: string,
  ): Promise<LineageExportDocument> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT report FROM lineage_exports
       WHERE id = $1 AND root_work_item_id = $2 AND org_id = $3`,
      [exportId, workItemId, orgId],
    );
    if (!result.rows?.length) throw new LineageExportNotFoundError(exportId);

    const value = result.rows[0].report;
    return (typeof value === 'string' ? JSON.parse(value) : value) as LineageExportDocument;
  }

  private async traverseLineage(
    params: LineageQueryParams,
    direction: 'up' | 'down',
    maxDepth: number,
  ): Promise<TraversalResult> {
    const filterEdgeTypes = params.edgeTypes?.length ? new Set(params.edgeTypes) : null;
    const visitedNodeIds = new Set<string>([params.workItemId]);
    const visitedEdgeIds = new Set<string>();
    const nodeQueue: Array<{ id: string; currentDepth: number }> = [
      { id: params.workItemId, currentDepth: 0 },
    ];
    const orderedNodeIds = [params.workItemId];
    const distances = new Map<string, number>([[params.workItemId, 0]]);
    const edges: WorkItemLink[] = [];

    while (nodeQueue.length > 0) {
      const { id: currentId, currentDepth } = nodeQueue.shift()!;
      if (currentDepth >= maxDepth) continue;

      const links = params.orgId
        ? await this.dbService.db.query<any>(
            `SELECT link.* FROM work_item_links link
             JOIN work_items source_item ON source_item.id = link.source_id
             JOIN work_items target_item ON target_item.id = link.target_id
             WHERE (link.source_id = $1 OR link.target_id = $1)
               AND source_item.org_id = $2 AND target_item.org_id = $2
             ORDER BY link.created_at ASC, link.id ASC`,
            [currentId, params.orgId],
          )
        : await this.dbService.db.query<any>(
            `SELECT * FROM work_item_links
             WHERE source_id = $1 OR target_id = $1
             ORDER BY created_at ASC, id ASC`,
            [currentId],
          );

      for (const row of links.rows || []) {
        const link = this.mapRowToLink(row);
        if (filterEdgeTypes && !filterEdgeTypes.has(link.link_type)) continue;
        const nextId = this.getNextNodeId(link, currentId, direction);
        if (!nextId) continue;

        if (!visitedEdgeIds.has(link.id)) {
          visitedEdgeIds.add(link.id);
          edges.push(link);
        }
        if (!visitedNodeIds.has(nextId)) {
          visitedNodeIds.add(nextId);
          orderedNodeIds.push(nextId);
          distances.set(nextId, currentDepth + 1);
          nodeQueue.push({ id: nextId, currentDepth: currentDepth + 1 });
        }
      }
    }

    return { orderedNodeIds, distances, edges };
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
