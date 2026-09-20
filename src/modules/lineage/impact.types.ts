import { ServiceRecord } from '../services/service-registry.types';

/**
 * Incident states treated as no longer demanding attention when counting open incidents
 * in an impact summary. Kept deliberately narrow: `Mitigated` still counts as open,
 * because Epic 7 automation can propose mitigation but a human has not yet confirmed it.
 */
export const CLOSED_INCIDENT_STATES = ['Resolved', 'Closed'] as const;

export const DEFAULT_IMPACT_DEPTH = 3;
export const MAX_IMPACT_DEPTH = 10;

export interface ImpactEdge {
  link_type: string;
  from_key: string;
  to_key: string;
}

export interface ImpactedWorkItem {
  id: string;
  key: string;
  type: string;
  title: string;
  status: string;
  severity: string | null;
  priority: string;
  aging_bucket: string;
  team_id: string;
}

export interface ImpactNode {
  work_item: ImpactedWorkItem;
  /** Hops from the Service. 1 means a direct `affects` edge. */
  distance: number;
  /** The edge chain that implicates this item, starting at the Service. */
  via: ImpactEdge[];
}

export interface ImpactSummary {
  total: number;
  by_type: Record<string, number>;
  open_incidents: number;
  highest_severity: string | null;
}

export interface ServiceImpactResult {
  service: ServiceRecord;
  depth: number;
  generated_at: string;
  summary: ImpactSummary;
  impacted: ImpactNode[];
}

export interface ServiceImpactQuery {
  orgId: string;
  serviceId: string;
  depth?: number;
  edgeTypes?: string[];
}
