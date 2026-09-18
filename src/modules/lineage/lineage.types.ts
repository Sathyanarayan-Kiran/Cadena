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

export const ALLOWED_EDGES_BY_PAIR: Record<string, LinkType[]> = {
  'story:story': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'duplicate_of', 'fixed_by', 'deployed_in'],
  'story:incident': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'caused_by', 'fixed_by', 'affects'],
  'incident:story': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'caused_by', 'fixed_by', 'affects'],
  'incident:incident': ['parent_of', 'child_of', 'blocks', 'blocked_by', 'relates_to', 'caused_by', 'duplicate_of', 'affects'],
};
