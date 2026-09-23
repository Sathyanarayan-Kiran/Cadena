import { runMappingScript } from './script-sandbox';
import {
  FieldMappingDefinition,
  FieldMappingDirection,
  FieldMappingHoldReason,
  FieldMappingRule,
  FieldMappingRuleOutcome,
} from './field-mapping.types';

export interface FieldMappingEvaluationInput {
  sourceFields: Record<string, unknown>;
  sourceState: string | null;
  targetState: string | null;
}

export interface FieldMappingEvaluationResult {
  status: 'ready' | 'held';
  /** Dot-path-merged output, ready to send to the target's connector adapter. */
  fields: Record<string, unknown>;
  outcomes: FieldMappingRuleOutcome[];
}

/** Discovered field ids currently known for one endpoint, used for the live schema-drift check. */
export type SchemaFieldLookup = (path: string) => boolean;

/**
 * Evaluates every rule of one published mapping for one direction against one record.
 *
 * A rule with no value at its `source_field` is silently skipped — most fields are optional, and
 * "not set" is not itself something to hold on. A rule whose source value is present but cannot
 * be resolved to a target value (an unmapped picklist entry, no matching conditional case, a
 * failed script, or a field the target no longer exposes) holds the *whole* translation: a
 * partially-applied field mapping would leave the counterpart in a state the operator did not
 * ask for, and is a worse outcome than pausing for review, exactly as an unmapped state holds in
 * US13.1 rather than guessing.
 */
export async function evaluateFieldMapping(
  mapping: FieldMappingDefinition,
  direction: FieldMappingDirection,
  input: FieldMappingEvaluationInput,
  targetSchemaHas: SchemaFieldLookup,
): Promise<FieldMappingEvaluationResult> {
  const outcomes: FieldMappingRuleOutcome[] = [];
  const fields: Record<string, unknown> = {};
  let held = false;

  for (const rule of mapping.rules) {
    if (rule.direction !== direction) continue;
    if (!targetSchemaHas(rule.target_field)) {
      outcomes.push(holdOutcome(rule, 'schema_drift', `Target field '${rule.target_field}' is no longer part of the discovered schema`));
      held = true;
      continue;
    }
    const sourceValue = getPath(input.sourceFields, rule.source_field);
    if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
      outcomes.push({ rule, status: 'unchanged' });
      continue;
    }

    const resolved = await resolveTransform(rule, sourceValue, input);
    if (!resolved.ok) {
      outcomes.push(holdOutcome(rule, resolved.reason, resolved.message));
      held = true;
      continue;
    }
    setPath(fields, rule.target_field, resolved.value);
    outcomes.push({ rule, status: 'applied', value: resolved.value });
  }

  return { status: held ? 'held' : 'ready', fields, outcomes };
}

type TransformResolution =
  | { ok: true; value: unknown }
  | { ok: false; reason: FieldMappingHoldReason; message: string };

async function resolveTransform(
  rule: FieldMappingRule,
  sourceValue: unknown,
  input: FieldMappingEvaluationInput,
): Promise<TransformResolution> {
  const transform = rule.transform;
  switch (transform.type) {
    case 'direct':
      return { ok: true, value: sourceValue };
    case 'constant':
      return { ok: true, value: transform.value };
    case 'value_table': {
      const key = String(sourceValue).toLowerCase();
      const match = Object.entries(transform.table).find(([tableKey]) => tableKey.toLowerCase() === key);
      if (match) return { ok: true, value: match[1] };
      if (transform.has_default) return { ok: true, value: transform.default_value };
      return {
        ok: false,
        reason: 'no_table_entry',
        message: `'${String(sourceValue)}' has no entry in the value table for ${rule.source_field} → ${rule.target_field}`,
      };
    }
    case 'conditional': {
      for (const entry of transform.cases) {
        // `$value` is the rule's own (already-confirmed-present) source value; any other path
        // reads elsewhere on the record, so a rule can branch on a *different* field than the one
        // it writes — e.g. route by `category` while translating `priority`.
        const candidate = entry.when.field === '$value' ? sourceValue : getPath(input.sourceFields, entry.when.field);
        if (candidate !== undefined && candidate !== null && sameText(candidate, entry.when.equals)) return { ok: true, value: entry.then };
      }
      if (transform.has_else) return { ok: true, value: transform.else_value };
      return {
        ok: false,
        reason: 'no_conditional_match',
        message: `No condition matched for ${rule.source_field} → ${rule.target_field}, and no default was configured`,
      };
    }
    case 'script': {
      const result = await runMappingScript(transform.code, {
        fields: input.sourceFields,
        sourceState: input.sourceState,
        targetState: input.targetState,
        direction: rule.direction === 'target_to_source' ? 'target_to_source' : 'source_to_target',
      });
      if (!result.ok) {
        return { ok: false, reason: 'script_failed', message: `Script for ${rule.source_field} → ${rule.target_field} failed: ${result.message}` };
      }
      return { ok: true, value: result.value };
    }
    default:
      return { ok: false, reason: 'script_failed', message: `Unknown transform type on ${rule.source_field} → ${rule.target_field}` };
  }
}

function holdOutcome(rule: FieldMappingRule, reason: FieldMappingHoldReason, message: string): FieldMappingRuleOutcome {
  return { rule, status: 'held', reason, message };
}

function sameText(left: unknown, right: unknown): boolean {
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'accent' }) === 0;
}

export function getPath(source: Record<string, unknown>, path: string): unknown {
  let value: unknown = source;
  for (const segment of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    cursor[segment] = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}
