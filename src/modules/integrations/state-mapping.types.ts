import { SyncIdentity } from './sync-guard.types';

export type StateMappingDirection = 'source_to_target' | 'target_to_source';
export type StateMappingStatus = 'draft' | 'published' | 'superseded';

export interface StateMappingEndpoint {
  system: string;
  entity_type: string;
}

export interface StateMappingRuleInput {
  direction: StateMappingDirection | null;
  from_state: string;
  to_state: string;
  /** Dot-delimited target field paths, for example `resolution.code`. */
  required_target_fields?: string[];
  /** When supplied, the target must currently be in one of these states. */
  allowed_target_from_states?: string[];
}

export interface StateMappingRule extends StateMappingRuleInput {
  required_target_fields: string[];
  allowed_target_from_states: string[];
}

export interface CreateStateMappingDto {
  name: string;
  source: StateMappingEndpoint;
  target: StateMappingEndpoint;
  rules: StateMappingRuleInput[];
}

export interface StateMappingDefinition {
  id: string;
  org_id: string;
  name: string;
  source: StateMappingEndpoint;
  target: StateMappingEndpoint;
  version: number;
  status: StateMappingStatus;
  rules: StateMappingRule[];
  created_by: string;
  created_at: string;
  published_by: string | null;
  published_at: string | null;
}

export interface TranslateStateChangeDto {
  /** The record whose provider state changed. */
  source_identity: SyncIdentity;
  /** Its immutable, correlated counterpart that should receive the mapped state. */
  target_identity: SyncIdentity;
  source_state: string;
  current_target_state?: string | null;
  target_fields?: Record<string, unknown>;
  /** Preview is non-destructive. `false` records a ready/held connector work order. */
  dry_run?: boolean;
}

export type StateTranslationReason =
  | 'mapped'
  | 'mapping_not_found'
  | 'unmapped_state'
  | 'missing_required_fields'
  | 'invalid_target_transition';

export interface StateTranslationDecision {
  transaction_id: string | null;
  dry_run: boolean;
  action: 'enqueue_connector_write' | 'hold_for_review';
  status: 'ready' | 'held';
  reason: StateTranslationReason;
  message: string;
  direction: StateMappingDirection | null;
  source_node_id: string;
  target_node_id: string;
  source_state: string;
  current_target_state: string | null;
  mapped_target_state: string | null;
  missing_target_fields: string[];
  mapping: {
    id: string;
    version: number;
    name: string;
  } | null;
  evaluated_at: string;
}

export interface StateSyncTransaction {
  id: string;
  org_id: string;
  mapping_definition_id: string | null;
  mapping_version: number | null;
  source_node_id: string;
  target_node_id: string;
  direction: StateMappingDirection;
  source_state: string;
  target_state_before: string | null;
  mapped_target_state: string | null;
  required_target_fields: string[];
  provided_target_fields: Record<string, unknown>;
  status: 'ready' | 'held';
  reason: StateTranslationReason;
  actor_id: string;
  created_at: string;
}

export class InvalidStateMappingError extends Error {}
export class StateMappingNotFoundError extends Error {}
export class StateMappingConflictError extends Error {}
export class StateMappingIdentityNotFoundError extends Error {}
