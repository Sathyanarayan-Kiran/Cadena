import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../../../database/database.service';
import { EventOutboxService } from '../../events/event-outbox.service';
import { checkMappingScriptSyntax } from './script-sandbox';
import { evaluateFieldMapping, FieldMappingEvaluationResult, SchemaFieldLookup } from './field-mapping-evaluator';
import {
  ConditionalCase,
  ConditionalTransform,
  ConstantTransform,
  CreateFieldMappingDto,
  DirectTransform,
  FieldMappingConflictError,
  FieldMappingDefinition,
  FieldMappingDirection,
  FieldMappingEndpoint,
  FieldMappingNotFoundError,
  FieldMappingRule,
  FieldMappingRuleInput,
  FieldMappingTransform,
  InvalidFieldMappingError,
  PreviewFieldMappingDto,
  ScriptTransform,
  ValueTableTransform,
} from './field-mapping.types';

const TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const FIELD_PATH_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/;
const MAX_RULES = 200;
const MAX_TABLE_ENTRIES = 500;
const MAX_CONDITIONAL_CASES = 100;

/**
 * Versioned, tenant-scoped field-level translation for correlated external records (US17.2).
 *
 * A published mapping is one directional-rule set between two connector-owned entity types
 * (mirroring US13.1's state mapping, but for arbitrary fields instead of the lifecycle field).
 * Every rule resolves through {@link evaluateFieldMapping}: a picklist/reference/assignment-group
 * value table, a conditional, a constant, a direct copy, or a sandboxed script. A rule that cannot
 * resolve safely holds the whole translation rather than writing a partial or guessed value.
 */
@Injectable()
export class FieldMappingService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();

  public async createDraft(orgId: string, dto: CreateFieldMappingDto, actorId: string): Promise<FieldMappingDefinition> {
    await this.dbService.initialize();
    const name = this.requiredText(dto?.name, 'name', 160);
    const source = this.normalizeEndpoint(dto?.source, 'source');
    const target = this.normalizeEndpoint(dto?.target, 'target');
    if (source.system === target.system && source.entity_type === target.entity_type) {
      throw new InvalidFieldMappingError('source and target must identify different system/entity pairs');
    }
    const rules = await this.normalizeRules(dto?.rules);

    let definition!: FieldMappingDefinition;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const versionResult = await tx.query<any>(
        `SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
         FROM integration_field_mapping_definitions
         WHERE org_id = $1 AND source_system = $2 AND source_entity_type = $3
           AND target_system = $4 AND target_entity_type = $5`,
        [orgId, source.system, source.entity_type, target.system, target.entity_type],
      );
      const version = Number(versionResult.rows[0]?.next_version || 1);
      const inserted = await tx.query<any>(
        `INSERT INTO integration_field_mapping_definitions
         (id, org_id, name, source_system, source_entity_type, target_system,
          target_entity_type, version, status, definition, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          randomUUID(), orgId, name, source.system, source.entity_type, target.system,
          target.entity_type, version, JSON.stringify({ rules }), actorId,
        ],
      );
      definition = this.mapDefinition(inserted.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'FieldMappingDraftCreated',
        work_item_id: definition.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.mappingEventPayload(definition),
      });
    });
    if (event) await this.outbox.dispatch(event);
    return definition;
  }

  /**
   * Publishes a draft. Refuses to publish (rather than publishing with a warning) when a rule
   * references a field that the currently discovered schema for its endpoint does not have — a
   * mapping that could never safely execute should not become the active one. Records a fingerprint
   * of each endpoint's discovered fields for audit; `translate`/`preview` re-check field presence
   * live on every run, since a fingerprint match at publish time does not guarantee the schema is
   * unchanged an hour, a day, or a schema migration later.
   */
  public async publish(orgId: string, id: string, actorId: string): Promise<FieldMappingDefinition> {
    await this.dbService.initialize();
    this.requireUuid(id, 'mapping id');

    // Read outside the transaction: schemaFieldIds queries through the service's own connection
    // (not a tx), and PGlite serializes all callers of one connection onto a single queue, so
    // calling it with a transaction already open on that same connection would deadlock the
    // transaction against itself.
    const found = await this.dbService.db.query<any>(
      `SELECT * FROM integration_field_mapping_definitions WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    if (found.rows.length === 0) throw new FieldMappingNotFoundError('Field mapping not found');
    const current = this.mapDefinition(found.rows[0]);
    if (current.status === 'superseded') throw new FieldMappingConflictError('A superseded field mapping cannot be published again');
    if (current.status === 'published') return current;

    // Only the *target* field is checked against discovery: it is what a work order would
    // actually write, so it must be something the provider currently accepts. The source field is
    // read from the twin's own already-ingested canonical payload, which legitimately includes
    // derived fields (e.g. Jira's `projectKey`) that never appear in the provider's raw field list.
    const [sourceSchema, targetSchema] = await Promise.all([
      this.schemaFieldIds(orgId, current.source),
      this.schemaFieldIds(orgId, current.target),
    ]);
    const missing: string[] = [];
    for (const rule of current.rules) {
      if (targetSchema && !targetSchema.has(topLevel(rule.target_field))) missing.push(`target field '${rule.target_field}'`);
    }
    if (missing.length) {
      throw new InvalidFieldMappingError(`Cannot publish: not in the discovered schema — ${Array.from(new Set(missing)).join(', ')}`);
    }

    let published!: FieldMappingDefinition;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      // Re-checked inside the transaction so a concurrent publish cannot both supersede the same
      // published row: this is the same read-then-write pattern US13.1 state mappings use.
      const guard = await tx.query<any>(
        `SELECT status FROM integration_field_mapping_definitions WHERE org_id = $1 AND id = $2`,
        [orgId, id],
      );
      if (guard.rows[0]?.status !== 'draft') {
        published = this.mapDefinition((await tx.query<any>(
          `SELECT * FROM integration_field_mapping_definitions WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        )).rows[0]);
        return;
      }

      await tx.query(
        `UPDATE integration_field_mapping_definitions SET status = 'superseded'
         WHERE org_id = $1 AND status = 'published'
           AND source_system = $2 AND source_entity_type = $3
           AND target_system = $4 AND target_entity_type = $5`,
        [orgId, current.source.system, current.source.entity_type, current.target.system, current.target.entity_type],
      );
      const result = await tx.query<any>(
        `UPDATE integration_field_mapping_definitions
         SET status = 'published', published_by = $3, published_at = CURRENT_TIMESTAMP,
             source_schema_fingerprint = $4, target_schema_fingerprint = $5
         WHERE org_id = $1 AND id = $2 RETURNING *`,
        [orgId, id, actorId, fingerprint(sourceSchema), fingerprint(targetSchema)],
      );
      published = this.mapDefinition(result.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'FieldMappingPublished',
        work_item_id: published.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.mappingEventPayload(published),
      });
    });
    if (event) await this.outbox.dispatch(event);
    return published;
  }

  public async list(orgId: string): Promise<FieldMappingDefinition[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_field_mapping_definitions WHERE org_id = $1
       ORDER BY source_system, source_entity_type, target_system, target_entity_type, version DESC, created_at DESC`,
      [orgId],
    );
    return (result.rows || []).map((row: any) => this.mapDefinition(row));
  }

  public async get(orgId: string, id: string): Promise<FieldMappingDefinition> {
    await this.dbService.initialize();
    this.requireUuid(id, 'mapping id');
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_field_mapping_definitions WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    if (result.rows.length === 0) throw new FieldMappingNotFoundError('Field mapping not found');
    return this.mapDefinition(result.rows[0]);
  }

  /** Non-destructive: evaluates a published mapping without producing a work order. */
  public async preview(orgId: string, dto: PreviewFieldMappingDto & { source: FieldMappingEndpoint; target: FieldMappingEndpoint }) {
    const mapping = await this.findPublished(orgId, dto.source, dto.target);
    const evaluatedAt = new Date().toISOString();
    if (!mapping) {
      return { mapping: null, direction: dto.direction, status: 'no_mapping' as const, fields: {}, outcomes: [], evaluated_at: evaluatedAt };
    }
    const targetSchema = await this.schemaFieldIds(orgId, dto.target);
    const result = await evaluateFieldMapping(mapping, dto.direction, {
      sourceFields: this.normalizeFields(dto.source_fields),
      sourceState: dto.source_state ?? null,
      targetState: dto.target_state ?? null,
    }, this.schemaLookup(targetSchema));
    return {
      mapping: { id: mapping.id, version: mapping.version, name: mapping.name },
      direction: dto.direction,
      status: result.status,
      fields: result.fields,
      outcomes: result.outcomes,
      evaluated_at: evaluatedAt,
    };
  }

  /**
   * Finds the published mapping for a correlated pair (if any) and evaluates it in the direction
   * implied by which endpoint is the source. Returns `null` when no mapping is published — the
   * caller (connector propagation) treats that as "nothing to translate," not an error.
   */
  public async translate(
    orgId: string,
    source: FieldMappingEndpoint,
    target: FieldMappingEndpoint,
    input: { sourceFields: Record<string, unknown>; sourceState: string | null; targetState: string | null },
  ): Promise<(FieldMappingEvaluationResult & { mapping: { id: string; version: number; name: string } }) | null> {
    const mapping = await this.findPublished(orgId, source, target);
    if (!mapping) return null;
    const direction = this.directionFor(mapping, source, target);
    const targetSchema = await this.schemaFieldIds(orgId, target);
    const result = await evaluateFieldMapping(mapping, direction, input, this.schemaLookup(targetSchema));
    return { ...result, mapping: { id: mapping.id, version: mapping.version, name: mapping.name } };
  }

  private async findPublished(orgId: string, a: FieldMappingEndpoint, b: FieldMappingEndpoint): Promise<FieldMappingDefinition | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_field_mapping_definitions
       WHERE org_id = $1 AND status = 'published'
         AND ((source_system = $2 AND source_entity_type = $3 AND target_system = $4 AND target_entity_type = $5)
           OR (source_system = $4 AND source_entity_type = $5 AND target_system = $2 AND target_entity_type = $3))
       ORDER BY version DESC LIMIT 1`,
      [orgId, a.system, a.entity_type, b.system, b.entity_type],
    );
    return result.rows[0] ? this.mapDefinition(result.rows[0]) : null;
  }

  private directionFor(mapping: FieldMappingDefinition, source: FieldMappingEndpoint, target: FieldMappingEndpoint): FieldMappingDirection {
    const direct = sameEndpoint(mapping.source, source) && sameEndpoint(mapping.target, target);
    return direct ? 'source_to_target' : 'target_to_source';
  }

  /** The discovered field ids for the most recently discovered connector of this provider/entity, or null if none has ever been discovered. */
  private async schemaFieldIds(orgId: string, endpoint: FieldMappingEndpoint): Promise<Set<string> | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT discovery_metadata FROM integration_connectors
       WHERE org_id = $1 AND provider = $2 AND discovery_metadata IS NOT NULL
       ORDER BY updated_at DESC`,
      [orgId, endpoint.system],
    );
    for (const row of result.rows) {
      const discovery = typeof row.discovery_metadata === 'string' ? JSON.parse(row.discovery_metadata) : row.discovery_metadata;
      const entity = discovery?.entities?.find((candidate: any) => candidate.entityType === endpoint.entity_type);
      if (entity) return new Set(entity.fields.map((field: any) => String(field.id)));
    }
    return null;
  }

  /** Undiscovered endpoints (no connector has ever run discovery) pass through rather than block. */
  private schemaLookup(fieldIds: Set<string> | null): SchemaFieldLookup {
    return (path: string) => (fieldIds === null ? true : fieldIds.has(topLevel(path)));
  }

  private normalizeEndpoint(input: FieldMappingEndpoint | undefined, field: string): FieldMappingEndpoint {
    if (!input || typeof input !== 'object') throw new InvalidFieldMappingError(`${field} is required`);
    return {
      system: this.requiredToken(input.system, `${field}.system`),
      entity_type: this.requiredToken(input.entity_type, `${field}.entity_type`),
    };
  }

  private async normalizeRules(input: FieldMappingRuleInput[] | undefined): Promise<FieldMappingRule[]> {
    if (!Array.isArray(input) || input.length === 0) throw new InvalidFieldMappingError('rules must contain at least one field mapping');
    if (input.length > MAX_RULES) throw new InvalidFieldMappingError(`rules cannot exceed ${MAX_RULES} entries`);
    const seen = new Set<string>();
    const rules: FieldMappingRule[] = [];
    for (const [index, rule] of input.entries()) {
      if (!rule || typeof rule !== 'object') throw new InvalidFieldMappingError(`rules[${index}] must be an object`);
      if (rule.direction !== 'source_to_target' && rule.direction !== 'target_to_source') {
        throw new InvalidFieldMappingError(`rules[${index}].direction must be source_to_target or target_to_source`);
      }
      const sourceField = this.requiredFieldPath(rule.source_field, `rules[${index}].source_field`);
      const targetField = this.requiredFieldPath(rule.target_field, `rules[${index}].target_field`);
      const key = `${rule.direction}\n${sourceField.toLowerCase()}\n${targetField.toLowerCase()}`;
      if (seen.has(key)) throw new InvalidFieldMappingError(`rules contains a duplicate ${rule.direction} mapping for ${sourceField} → ${targetField}`);
      seen.add(key);
      rules.push({
        direction: rule.direction,
        source_field: sourceField,
        target_field: targetField,
        transform: await this.normalizeTransform(rule.transform, `rules[${index}].transform`),
      });
    }
    return rules;
  }

  private async normalizeTransform(input: unknown, field: string): Promise<FieldMappingTransform> {
    if (!input || typeof input !== 'object') throw new InvalidFieldMappingError(`${field} is required`);
    const type = (input as { type?: unknown }).type;
    switch (type) {
      case 'direct':
        return { type: 'direct' } satisfies DirectTransform;
      case 'constant': {
        const value = (input as { value?: unknown }).value;
        if (value === undefined) throw new InvalidFieldMappingError(`${field}.value is required for a constant transform`);
        return { type: 'constant', value: this.normalizeJsonValue(value, `${field}.value`) } satisfies ConstantTransform;
      }
      case 'value_table':
        return this.normalizeValueTable(input as Record<string, unknown>, field);
      case 'conditional':
        return this.normalizeConditional(input as Record<string, unknown>, field);
      case 'script':
        return this.normalizeScript(input as Record<string, unknown>, field);
      default:
        throw new InvalidFieldMappingError(`${field}.type must be one of direct, constant, value_table, conditional, script`);
    }
  }

  private normalizeValueTable(input: Record<string, unknown>, field: string): ValueTableTransform {
    const table = input.table;
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new InvalidFieldMappingError(`${field}.table must be an object`);
    const entries = Object.entries(table as Record<string, unknown>);
    if (entries.length === 0) throw new InvalidFieldMappingError(`${field}.table must have at least one entry`);
    if (entries.length > MAX_TABLE_ENTRIES) throw new InvalidFieldMappingError(`${field}.table cannot exceed ${MAX_TABLE_ENTRIES} entries`);
    const normalizedTable: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (!key.trim()) throw new InvalidFieldMappingError(`${field}.table has an empty key`);
      normalizedTable[key] = this.normalizeJsonValue(value, `${field}.table.${key}`);
    }
    const hasDefault = Object.prototype.hasOwnProperty.call(input, 'default_value');
    return {
      type: 'value_table',
      table: normalizedTable,
      has_default: hasDefault,
      ...(hasDefault ? { default_value: this.normalizeJsonValue(input.default_value, `${field}.default_value`) } : {}),
    };
  }

  private normalizeConditional(input: Record<string, unknown>, field: string): ConditionalTransform {
    const cases = input.cases;
    if (!Array.isArray(cases) || cases.length === 0) throw new InvalidFieldMappingError(`${field}.cases must be a non-empty array`);
    if (cases.length > MAX_CONDITIONAL_CASES) throw new InvalidFieldMappingError(`${field}.cases cannot exceed ${MAX_CONDITIONAL_CASES} entries`);
    const normalizedCases = cases.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new InvalidFieldMappingError(`${field}.cases[${index}] must be an object`);
      const when = (entry as { when?: unknown }).when;
      if (!when || typeof when !== 'object') throw new InvalidFieldMappingError(`${field}.cases[${index}].when is required`);
      const whenField = (when as ConditionalCase).field;
      if (whenField !== '$value' && !FIELD_PATH_PATTERN.test(String(whenField))) {
        throw new InvalidFieldMappingError(`${field}.cases[${index}].when.field must be '$value' or a field path`);
      }
      const equals = (when as ConditionalCase).equals;
      if (typeof equals !== 'string' || !equals.trim()) throw new InvalidFieldMappingError(`${field}.cases[${index}].when.equals must be a non-empty string`);
      const then = (entry as { then?: unknown }).then;
      if (then === undefined) throw new InvalidFieldMappingError(`${field}.cases[${index}].then is required`);
      return { when: { field: String(whenField), equals: equals.trim() }, then: this.normalizeJsonValue(then, `${field}.cases[${index}].then`) };
    });
    const hasElse = Object.prototype.hasOwnProperty.call(input, 'else_value');
    return {
      type: 'conditional',
      cases: normalizedCases,
      has_else: hasElse,
      ...(hasElse ? { else_value: this.normalizeJsonValue(input.else_value, `${field}.else_value`) } : {}),
    };
  }

  /** Compiles the script (never runs it), so a syntax error is caught at save time, not first use. */
  private async normalizeScript(input: Record<string, unknown>, field: string): Promise<ScriptTransform> {
    const code = input.code;
    if (typeof code !== 'string' || !code.trim()) throw new InvalidFieldMappingError(`${field}.code is required`);
    const check = await checkMappingScriptSyntax(code);
    if (!check.valid) throw new InvalidFieldMappingError(`${field}.code does not compile: ${check.message}`);
    return { type: 'script', code };
  }

  private normalizeJsonValue(value: unknown, field: string): unknown {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      throw new InvalidFieldMappingError(`${field} must be a JSON-serializable value`);
    }
  }

  private requiredFieldPath(value: unknown, field: string): string {
    const text = this.requiredText(value, field, 128);
    if (!FIELD_PATH_PATTERN.test(text)) throw new InvalidFieldMappingError(`${field} is not a supported field path`);
    return text;
  }

  private normalizeFields(input: unknown): Record<string, unknown> {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) throw new InvalidFieldMappingError('source_fields must be a JSON object');
    try {
      return JSON.parse(JSON.stringify(input));
    } catch {
      throw new InvalidFieldMappingError('source_fields must be JSON serializable');
    }
  }

  private requiredToken(value: unknown, field: string): string {
    const normalized = this.requiredText(value, field, 64).toLowerCase();
    if (!TOKEN_PATTERN.test(normalized)) throw new InvalidFieldMappingError(`${field} contains unsupported characters`);
    return normalized;
  }

  private requiredText(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new InvalidFieldMappingError(`${field} is required`);
    const normalized = value.trim();
    if (normalized.length > maxLength) throw new InvalidFieldMappingError(`${field} must be ${maxLength} characters or fewer`);
    return normalized;
  }

  private requireUuid(value: string, field: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new InvalidFieldMappingError(`${field} must be a UUID`);
    }
  }

  private mappingEventPayload(definition: FieldMappingDefinition) {
    return {
      org_id: definition.org_id,
      mapping_id: definition.id,
      name: definition.name,
      version: definition.version,
      status: definition.status,
      source: definition.source,
      target: definition.target,
      rule_count: definition.rules.length,
    };
  }

  private mapDefinition(row: any): FieldMappingDefinition {
    const definition = typeof row.definition === 'string' ? JSON.parse(row.definition) : (row.definition || {});
    return {
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      source: { system: row.source_system, entity_type: row.source_entity_type },
      target: { system: row.target_system, entity_type: row.target_entity_type },
      version: Number(row.version),
      status: row.status,
      rules: Array.isArray(definition.rules) ? definition.rules : [],
      source_schema_fingerprint: row.source_schema_fingerprint ?? null,
      target_schema_fingerprint: row.target_schema_fingerprint ?? null,
      created_by: row.created_by,
      created_at: new Date(row.created_at).toISOString(),
      published_by: row.published_by ?? null,
      published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
    };
  }
}

function topLevel(path: string): string {
  return path.split('.')[0];
}

function sameEndpoint(a: FieldMappingEndpoint, b: FieldMappingEndpoint): boolean {
  return a.system === b.system && a.entity_type === b.entity_type;
}

function fingerprint(fieldIds: Set<string> | null): string | null {
  if (fieldIds === null) return null;
  return createHash('sha256').update(Array.from(fieldIds).sort().join(','), 'utf8').digest('hex');
}
