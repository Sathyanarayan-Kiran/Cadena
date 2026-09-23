export type FieldMappingDirection = 'source_to_target' | 'target_to_source';
export type FieldMappingStatus = 'draft' | 'published' | 'superseded';

export interface FieldMappingEndpoint {
  system: string;
  entity_type: string;
}

/** A picklist, reference or assignment-group lookup: native source value → native target value. */
export interface ValueTableTransform {
  type: 'value_table';
  /** Keyed by the source value's string form, case-insensitively. */
  table: Record<string, unknown>;
  /** Used when the source value has no entry in `table`. Omitting it holds the rule instead of guessing. */
  default_value?: unknown;
  has_default: boolean;
}

/** if/else-if over any field already present on the record (not only the mapped source field). */
export interface ConditionalCase {
  field: string;
  equals: string;
}
export interface ConditionalTransform {
  type: 'conditional';
  cases: Array<{ when: ConditionalCase; then: unknown }>;
  else_value?: unknown;
  has_else: boolean;
}

export interface DirectTransform { type: 'direct'; }
export interface ConstantTransform { type: 'constant'; value: unknown; }
export interface ScriptTransform { type: 'script'; code: string; }

export type FieldMappingTransform = DirectTransform | ConstantTransform | ValueTableTransform | ConditionalTransform | ScriptTransform;

export interface FieldMappingRuleInput {
  direction: FieldMappingDirection | null;
  /** Dot-delimited canonical field path on the record whose change triggers this rule, e.g. `priority`. */
  source_field: string;
  /** Dot-delimited canonical field path this rule writes on the counterpart, e.g. `assignment_group`. */
  target_field: string;
  transform: FieldMappingTransform;
}

export type FieldMappingRule = FieldMappingRuleInput;

export interface CreateFieldMappingDto {
  name: string;
  source: FieldMappingEndpoint;
  target: FieldMappingEndpoint;
  rules: FieldMappingRuleInput[];
}

export interface FieldMappingDefinition {
  id: string;
  org_id: string;
  name: string;
  source: FieldMappingEndpoint;
  target: FieldMappingEndpoint;
  version: number;
  status: FieldMappingStatus;
  rules: FieldMappingRule[];
  /** Snapshot of the endpoints' discovered field ids at publish time; re-checked on every execution. */
  source_schema_fingerprint: string | null;
  target_schema_fingerprint: string | null;
  created_by: string;
  created_at: string;
  published_by: string | null;
  published_at: string | null;
}

export interface PreviewFieldMappingDto {
  direction: FieldMappingDirection;
  /** The full canonical field set of the changed record, as stored on its twin. */
  source_fields: Record<string, unknown>;
  source_state?: string | null;
  target_state?: string | null;
}

export type FieldMappingRuleOutcome =
  | { rule: FieldMappingRule; status: 'applied'; value: unknown }
  | { rule: FieldMappingRule; status: 'unchanged' }
  | { rule: FieldMappingRule; status: 'held'; reason: FieldMappingHoldReason; message: string };

export type FieldMappingHoldReason =
  | 'no_source_value'
  | 'no_table_entry'
  | 'no_conditional_match'
  | 'script_failed'
  | 'schema_drift'
  | 'missing_required_fields';

export interface FieldMappingPreviewResult {
  mapping: { id: string; version: number; name: string } | null;
  direction: FieldMappingDirection;
  status: 'ready' | 'held' | 'no_mapping';
  fields: Record<string, unknown>;
  outcomes: FieldMappingRuleOutcome[];
  evaluated_at: string;
}

export class InvalidFieldMappingError extends Error {}
export class FieldMappingNotFoundError extends Error {}
export class FieldMappingConflictError extends Error {}
