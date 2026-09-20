import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ServiceRegistryService } from '../services/service-registry.service';
import { SERVICE_LINK_TYPE } from '../services/service-registry.types';
import { VALID_SEVERITIES } from '../work-items/work-item.types';
import {
  CLOSED_INCIDENT_STATES,
  DEFAULT_IMPACT_DEPTH,
  ImpactEdge,
  ImpactNode,
  ImpactSummary,
  ImpactedWorkItem,
  MAX_IMPACT_DEPTH,
  ServiceImpactQuery,
  ServiceImpactResult,
} from './impact.types';

export class ServiceNotFoundError extends Error {
  constructor(serviceId: string) {
    super(`Service '${serviceId}' not found in this tenant`);
    this.name = 'ServiceNotFoundError';
  }
}

interface TraversalState {
  item: ImpactedWorkItem;
  distance: number;
  via: ImpactEdge[];
}

/**
 * US4.3 — downstream impact analysis from a Service.
 *
 * Seeds from the Service's `affects` edges (Spec §3.2, stored in `work_item_service_links`)
 * and then walks the work-item graph outward to the requested depth, so an outage answers
 * "which releases and stories are implicated?" rather than just "which incidents are open?".
 *
 * The walk is **undirected**. The backlog asks for "all affected work items within a
 * specified depth", and an implicated Release sits upstream of the Incident it caused while
 * a remediating Story sits downstream; filtering by direction would drop one or the other.
 * Every node therefore carries the `via` edge chain that implicates it, so a reader can judge
 * relevance instead of trusting an opaque list.
 */
@Injectable()
export class ImpactService {
  private dbService = DatabaseService.getInstance();
  private registry = new ServiceRegistryService();

  public async getServiceImpact(query: ServiceImpactQuery): Promise<ServiceImpactResult> {
    await this.dbService.initialize();

    const service = await this.registry.getServiceById(query.orgId, query.serviceId);
    if (!service) throw new ServiceNotFoundError(query.serviceId);

    const depth = this.clampDepth(query.depth);
    const edgeFilter = query.edgeTypes && query.edgeTypes.length > 0
      ? new Set(query.edgeTypes)
      : null;

    const seeds = await this.loadDirectlyAffected(query.orgId, query.serviceId);
    const visited = new Map<string, TraversalState>();
    const queue: TraversalState[] = [];

    for (const item of seeds) {
      const state: TraversalState = {
        item,
        distance: 1,
        via: [{ link_type: SERVICE_LINK_TYPE, from_key: service.service_key, to_key: item.key }],
      };
      visited.set(item.id, state);
      queue.push(state);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.distance >= depth) continue;

      for (const neighbour of await this.loadNeighbours(query.orgId, current.item.id)) {
        if (edgeFilter && !edgeFilter.has(neighbour.link_type)) continue;
        if (visited.has(neighbour.item.id)) continue;

        const state: TraversalState = {
          item: neighbour.item,
          distance: current.distance + 1,
          via: [
            ...current.via,
            {
              link_type: neighbour.link_type,
              from_key: neighbour.reversed ? neighbour.item.key : current.item.key,
              to_key: neighbour.reversed ? current.item.key : neighbour.item.key,
            },
          ],
        };
        visited.set(neighbour.item.id, state);
        queue.push(state);
      }
    }

    const impacted: ImpactNode[] = Array.from(visited.values())
      .sort((a, b) => a.distance - b.distance || a.item.key.localeCompare(b.item.key))
      .map((state) => ({ work_item: state.item, distance: state.distance, via: state.via }));

    return {
      service,
      depth,
      generated_at: new Date().toISOString(),
      summary: this.summarize(impacted),
      impacted,
    };
  }

  private clampDepth(depth?: number): number {
    if (depth === undefined || Number.isNaN(depth)) return DEFAULT_IMPACT_DEPTH;
    return Math.max(1, Math.min(MAX_IMPACT_DEPTH, Math.floor(depth)));
  }

  private async loadDirectlyAffected(orgId: string, serviceId: string): Promise<ImpactedWorkItem[]> {
    const result = await this.dbService.db.query<any>(
      `SELECT item.id, item.item_key, item.type, item.title, item.status,
              item.severity, item.priority, item.aging_bucket, item.team_id
       FROM work_item_service_links link
       JOIN work_items item ON item.id = link.work_item_id
       WHERE link.service_id = $1 AND link.org_id = $2 AND item.org_id = $2
         AND link.link_type = $3
       ORDER BY item.created_at ASC`,
      [serviceId, orgId, SERVICE_LINK_TYPE],
    );
    return result.rows.map((row) => this.mapItem(row));
  }

  private async loadNeighbours(orgId: string, workItemId: string): Promise<Array<{
    item: ImpactedWorkItem;
    link_type: string;
    reversed: boolean;
  }>> {
    const result = await this.dbService.db.query<any>(
      `SELECT link.link_type,
              (link.target_id = $1) AS reversed,
              other.id, other.item_key, other.type, other.title, other.status,
              other.severity, other.priority, other.aging_bucket, other.team_id
       FROM work_item_links link
       JOIN work_items source_item ON source_item.id = link.source_id
       JOIN work_items target_item ON target_item.id = link.target_id
       JOIN work_items other
         ON other.id = CASE WHEN link.source_id = $1 THEN link.target_id ELSE link.source_id END
       WHERE (link.source_id = $1 OR link.target_id = $1)
         AND source_item.org_id = $2 AND target_item.org_id = $2 AND other.org_id = $2
       ORDER BY link.created_at ASC`,
      [workItemId, orgId],
    );
    return result.rows.map((row) => ({
      item: this.mapItem(row),
      link_type: row.link_type,
      reversed: row.reversed === true,
    }));
  }

  private summarize(impacted: ImpactNode[]): ImpactSummary {
    const byType: Record<string, number> = {};
    let openIncidents = 0;
    let highestSeverity: string | null = null;

    for (const node of impacted) {
      const item = node.work_item;
      byType[item.type] = (byType[item.type] || 0) + 1;

      if (item.type === 'incident') {
        if (!CLOSED_INCIDENT_STATES.includes(item.status as (typeof CLOSED_INCIDENT_STATES)[number])) {
          openIncidents += 1;
        }
        if (item.severity && VALID_SEVERITIES.includes(item.severity as any)) {
          const rank = VALID_SEVERITIES.indexOf(item.severity as any);
          const currentRank = highestSeverity
            ? VALID_SEVERITIES.indexOf(highestSeverity as any)
            : Number.MAX_SAFE_INTEGER;
          if (rank < currentRank) highestSeverity = item.severity;
        }
      }
    }

    return {
      total: impacted.length,
      by_type: byType,
      open_incidents: openIncidents,
      highest_severity: highestSeverity,
    };
  }

  private mapItem(row: any): ImpactedWorkItem {
    return {
      id: row.id,
      key: row.item_key,
      type: row.type,
      title: row.title,
      status: row.status,
      severity: row.severity,
      priority: row.priority,
      aging_bucket: row.aging_bucket || 'green',
      team_id: row.team_id,
    };
  }
}
