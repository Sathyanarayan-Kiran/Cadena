export const VALID_WORK_ITEM_TYPES = ['epic', 'story', 'incident'] as const;
export type WorkItemType = (typeof VALID_WORK_ITEM_TYPES)[number];

export const VALID_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type WorkItemPriority = (typeof VALID_PRIORITIES)[number];

export const VALID_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export type WorkItemSeverity = (typeof VALID_SEVERITIES)[number];

export const DEFAULT_STATUS: Record<WorkItemType, string> = {
  epic: 'Proposed',
  story: 'Proposed',
  incident: 'Triaged',
};

export interface WorkItem {
  id: string;
  type: WorkItemType;
  title: string;
  description: string;
  status: string;
  workflow_version: number;
  priority: WorkItemPriority;
  severity?: WorkItemSeverity | null;
  owner_id?: string | null;
  team_id: string;
  org_id: string;
  entered_state_at: string;
  custom_fields: Record<string, any>;
  tags: string[];
  created_at: string;
  updated_at: string;
  aging_bucket: 'green' | 'amber' | 'red';
  aging_score: number;
}

export interface CreateWorkItemDto {
  type: string;
  title: string;
  description?: string;
  priority?: WorkItemPriority;
  severity?: WorkItemSeverity | null;
  owner_id?: string;
  team_id: string;
  org_id: string;
  custom_fields?: Record<string, any>;
  tags?: string[];
}
