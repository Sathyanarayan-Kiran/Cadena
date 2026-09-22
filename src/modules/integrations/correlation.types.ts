export interface CorrelationEntityInput {
  /** Connector or platform family, for example `servicenow` or `jira`. */
  system: string;
  /** Provider-native entity kind, for example `incident` or `issue`. */
  entity_type: string;
  /** Stable provider identifier. This is the only value used for resolution. */
  immutable_id: string;
  /** Mutable human-facing key, such as INC0010042 or ENG-4821. */
  display_key?: string | null;
  /** Mutable deep link. Moving a record may change this without changing its identity. */
  url?: string | null;
}

export interface CreateCorrelationDto {
  source: CorrelationEntityInput;
  target: CorrelationEntityInput;
  /** Directed edge semantics. `counterpart` is treated as symmetric for deduplication. */
  relationship?: string;
}

export interface UpdateCorrelationMetadataDto {
  display_key?: string | null;
  url?: string | null;
}

export interface CorrelationNode {
  id: string;
  org_id: string;
  system: string;
  entity_type: string;
  immutable_id: string;
  display_key: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
  distance?: number;
}

export interface CorrelationReference {
  node_id: string;
  system: string;
  field: 'cadena_counterpart_id';
  value: string;
}

export interface CorrelationLink {
  id: string;
  org_id: string;
  source_node_id: string;
  target_node_id: string;
  relationship: string;
  created_by: string;
  created_at: string;
  references: {
    source: CorrelationReference;
    target: CorrelationReference;
  };
}

export interface CorrelationPairResult {
  created: boolean;
  source: CorrelationNode;
  target: CorrelationNode;
  link: CorrelationLink;
}

export interface CorrelationGraph {
  root: CorrelationNode;
  depth: number;
  nodes: CorrelationNode[];
  links: CorrelationLink[];
  summary: {
    node_count: number;
    link_count: number;
    direct_counterparts: number;
    max_distance: number;
  };
}

export class InvalidCorrelationError extends Error {}
export class CorrelationNotFoundError extends Error {}

