export interface WorkflowTransitionGuard {
  role?: string;
  roles?: string[];
  requires_fields?: string[];
}

export interface WorkflowTransitionRule {
  from: string;
  to: string;
  guard?: string | WorkflowTransitionGuard;
  requires_fields?: string[];
}

export interface WorkflowDefinition {
  type: string;
  states: string[];
  initial_state: string;
  terminal_states: string[];
  transitions: WorkflowTransitionRule[];
}

export interface PublishedWorkflowRecord {
  id: string;
  type: string;
  version: number;
  definition: WorkflowDefinition;
  created_at: string;
}
