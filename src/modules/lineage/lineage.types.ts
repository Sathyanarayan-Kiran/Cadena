export const VALID_LINK_TYPES = [
  'parent_of',
  'child_of',
  'blocks',
  'blocked_by',
  'relates_to',
  'caused_by',
  'fixed_by',
  'deployed_in',
  'affects',
  'duplicate_of',
] as const;

export type LinkType = (typeof VALID_LINK_TYPES)[number];

export interface WorkItemLink {
  id: string;
  source_id: string;
  target_id: string;
  link_type: LinkType;
  created_at: string;
}

export interface CreateLinkDto {
  target_id: string;
  link_type: LinkType;
}

export interface LineageExportDocument {
  schema: 'cadena.lineage-report.v1';
  export_id: string;
  root_work_item_id: string;
  root_key: string;
  org_id: string;
  generated_at: string;
  generated_by: string;
  download_url: string;
  summary: {
    node_count: number;
    edge_count: number;
  };
  nodes: Array<{
    id: string;
    key: string;
    type: string;
    title: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>;
  edges: WorkItemLink[];
}

export const ALLOWED_EDGES_BY_PAIR: Record<string, LinkType[]> = {
  'epic:epic': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of'],
  'epic:story': ['parent_of', 'blocks', 'relates_to'],
  'story:epic': ['child_of', 'blocked_by', 'relates_to'],
  'epic:incident': ['relates_to', 'caused_by', 'affects'],
  'incident:epic': ['relates_to', 'caused_by', 'affects'],
  'story:story': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of', 'fixed_by', 'deployed_in'],
  'story:incident': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'caused_by', 'fixed_by', 'affects'],
  'incident:story': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'caused_by', 'fixed_by', 'affects'],
  'incident:incident': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'caused_by', 'duplicate_of', 'affects'],
  'release:release': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to'],
  'release:story': ['parent_of', 'relates_to'],
  'story:release': ['child_of', 'relates_to', 'deployed_in'],
  'release:epic': ['child_of', 'relates_to'],
  'epic:release': ['parent_of', 'relates_to', 'deployed_in'],
  'release:incident': ['relates_to', 'caused_by', 'affects'],
  'incident:release': ['relates_to', 'caused_by', 'affects'],
};
