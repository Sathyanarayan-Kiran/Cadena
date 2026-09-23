export const VALID_WORK_ITEM_TYPES = ['epic', 'story', 'incident', 'release'] as const;
export type WorkItemType = (typeof VALID_WORK_ITEM_TYPES)[number];

export const VALID_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type WorkItemPriority = (typeof VALID_PRIORITIES)[number];

export const VALID_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export type WorkItemSeverity = (typeof VALID_SEVERITIES)[number];

export const DEFAULT_STATUS: Record<WorkItemType, string> = {
  epic: 'Proposed',
  story: 'Proposed',
  incident: 'Triaged',
  release: 'Draft',
};

export interface WorkItem {
  id: string;
  key: string;
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
  /** Accrued SLA minutes retained while the item is in a configured hold state. */
  sla_elapsed_minutes: number;
  /** True while SLA accrual is paused by the current state's policy. */
  sla_suspended: boolean;
  /** Set by the Epic 8 escalation path once an item passes the tenant escalation threshold. */
  escalated_at?: string | null;
  /** `local` items are Cadena-owned; `connector` items are twin-backed projections of a source record. */
  origin?: 'local' | 'connector';
  /** Provenance for twin-backed items. Source fields are read-only locally. */
  source?: WorkItemSource | null;
}

export interface WorkItemSource {
  system: string;
  twin_id: string;
  connector_id: string | null;
  native_key: string;
  native_url: string | null;
  source_updated_at: string | null;
  /** True once the connector's projection is no longer 'projected'; this item has stopped updating. */
  frozen: boolean;
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

/** Fields that can be edited without bypassing the workflow state machine. */
export interface UpdateWorkItemDto {
  title?: string;
  description?: string;
  priority?: WorkItemPriority;
  severity?: WorkItemSeverity | null;
  owner_id?: string | null;
  custom_fields?: Record<string, any>;
  tags?: string[];
}
