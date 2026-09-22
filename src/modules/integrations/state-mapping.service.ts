import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import {
  CreateStateMappingDto,
  InvalidStateMappingError,
  StateMappingConflictError,
  StateMappingDefinition,
  StateMappingDirection,
  StateMappingEndpoint,
  StateMappingIdentityNotFoundError,
  StateMappingNotFoundError,
  StateMappingRule,
  StateMappingRuleInput,
  StateSyncTransaction,
  StateTranslationDecision,
  StateTranslationReason,
  TranslateStateChangeDto,
} from './state-mapping.types';
import { SyncIdentity } from './sync-guard.types';

const TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const FIELD_PATH_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/;
const MAX_RULES = 500;

interface CorrelationNode extends SyncIdentity {
  id: string;
}

interface Evaluation {
  mapping: StateMappingDefinition | null;
  direction: StateMappingDirection | null;
  rule: StateMappingRule | null;
  status: 'ready' | 'held';
  reason: StateTranslationReason;
  message: string;
  mappedTargetState: string | null;
  missingTargetFields: string[];
}

/**
 * Versioned, tenant-scoped lifecycle translation for correlated external records.
 *
 * The service deliberately stops at a durable connector work order. US17.1 owns the native
 * Jira/ServiceNow call that consumes a `ready` decision; invalid or incomplete changes are
 * persisted as `held` so a connector can never guess a state or required field.
 */
@Injectable()
export class StateMappingService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();

  public async createDraft(
    orgId: string,
    dto: CreateStateMappingDto,
    actorId: string,
  ): Promise<StateMappingDefinition> {
    await this.dbService.initialize();
    const name = this.requiredText(dto?.name, 'name', 160);
    const source = this.normalizeEndpoint(dto?.source, 'source');
    const target = this.normalizeEndpoint(dto?.target, 'target');
    if (source.system === target.system && source.entity_type === target.entity_type) {
      throw new InvalidStateMappingError('source and target must identify different system/entity pairs');
    }
    const rules = this.normalizeRules(dto?.rules);
    let definition!: StateMappingDefinition;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;

    await this.dbService.db.transaction(async (tx) => {
      const versionResult = await tx.query<any>(
        `SELECT COALESCE(MAX(version), 0)::int + 1 AS next_version
         FROM integration_state_mapping_definitions
         WHERE org_id = $1 AND source_system = $2 AND source_entity_type = $3
           AND target_system = $4 AND target_entity_type = $5`,
        [orgId, source.system, source.entity_type, target.system, target.entity_type],
      );
      const version = Number(versionResult.rows[0]?.next_version || 1);
      const inserted = await tx.query<any>(
        `INSERT INTO integration_state_mapping_definitions
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
        event_type: 'StateMappingDraftCreated',
        work_item_id: definition.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.mappingEventPayload(definition),
      });
    });

    if (event) await this.outbox.dispatch(event);
    return definition;
  }

  public async publish(orgId: string, id: string, actorId: string): Promise<StateMappingDefinition> {
    await this.dbService.initialize();
    this.requireUuid(id, 'mapping id');
    let published!: StateMappingDefinition;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;

    await this.dbService.db.transaction(async (tx) => {
      const found = await tx.query<any>(
        `SELECT * FROM integration_state_mapping_definitions WHERE org_id = $1 AND id = $2`,
        [orgId, id],
      );
      if (found.rows.length === 0) throw new StateMappingNotFoundError('State mapping not found');
      const current = this.mapDefinition(found.rows[0]);
      if (current.status === 'superseded') {
        throw new StateMappingConflictError('A superseded state mapping cannot be published again');
      }
      if (current.status === 'published') {
        published = current;
        return;
      }

      await tx.query(
        `UPDATE integration_state_mapping_definitions
         SET status = 'superseded'
         WHERE org_id = $1 AND status = 'published'
           AND source_system = $2 AND source_entity_type = $3
           AND target_system = $4 AND target_entity_type = $5`,
        [orgId, current.source.system, current.source.entity_type, current.target.system, current.target.entity_type],
      );
      const result = await tx.query<any>(
        `UPDATE integration_state_mapping_definitions
         SET status = 'published', published_by = $3, published_at = CURRENT_TIMESTAMP
         WHERE org_id = $1 AND id = $2
         RETURNING *`,
        [orgId, id, actorId],
      );
      published = this.mapDefinition(result.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'StateMappingPublished',
        work_item_id: published.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.mappingEventPayload(published),
      });
    });

    if (event) await this.outbox.dispatch(event);
    return published;
  }

  public async list(orgId: string): Promise<StateMappingDefinition[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_state_mapping_definitions
       WHERE org_id = $1
       ORDER BY source_system, source_entity_type, target_system, target_entity_type,
                version DESC, created_at DESC`,
      [orgId],
    );
    return (result.rows || []).map((row: any) => this.mapDefinition(row));
  }

  public async get(orgId: string, id: string): Promise<StateMappingDefinition> {
    await this.dbService.initialize();
    this.requireUuid(id, 'mapping id');
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_state_mapping_definitions WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    if (result.rows.length === 0) throw new StateMappingNotFoundError('State mapping not found');
    return this.mapDefinition(result.rows[0]);
  }

  public async translate(
    orgId: string,
    dto: TranslateStateChangeDto,
    actorId: string,
  ): Promise<StateTranslationDecision> {
    await this.dbService.initialize();
    const sourceIdentity = this.normalizeIdentity(dto?.source_identity, 'source_identity');
    const targetIdentity = this.normalizeIdentity(dto?.target_identity, 'target_identity');
    const sourceState = this.requiredText(dto?.source_state, 'source_state', 160);
    const currentTargetState = dto?.current_target_state === undefined || dto.current_target_state === null
      ? null
      : this.requiredText(dto.current_target_state, 'current_target_state', 160);
    const targetFields = this.normalizeFields(dto?.target_fields);
    const dryRun = dto?.dry_run !== false;
    const sourceNode = await this.requireNode(orgId, sourceIdentity);
    const targetNode = await this.requireNode(orgId, targetIdentity);
    await this.requireCounterpartLink(orgId, sourceNode.id, targetNode.id);
    const evaluation = await this.evaluate(
      orgId,
      sourceIdentity,
      targetIdentity,
      sourceState,
      currentTargetState,
      targetFields,
    );
    const evaluatedAt = new Date().toISOString();
    let transactionId: string | null = null;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;

    if (!dryRun) {
      transactionId = randomUUID();
      await this.dbService.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO integration_state_sync_transactions
           (id, org_id, mapping_definition_id, mapping_version, source_node_id,
            target_node_id, direction, source_state, target_state_before,
            mapped_target_state, required_target_fields, provided_target_fields,
            status, reason, actor_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            transactionId, orgId, evaluation.mapping?.id || null,
            evaluation.mapping?.version || null, sourceNode.id, targetNode.id, evaluation.direction,
            sourceState, currentTargetState, evaluation.mappedTargetState,
            JSON.stringify(evaluation.rule?.required_target_fields || []),
            JSON.stringify(targetFields), evaluation.status, evaluation.reason, actorId, evaluatedAt,
          ],
        );
        event = await this.outbox.enqueue(tx, {
          event_type: evaluation.status === 'ready'
            ? 'IntegrationStateChangePrepared'
            : 'IntegrationStateChangeHeld',
          work_item_id: transactionId!,
          org_id: orgId,
          actor: { type: 'integration', id: actorId },
          payload: {
            org_id: orgId,
            transaction_id: transactionId,
            mapping_id: evaluation.mapping?.id || null,
            mapping_version: evaluation.mapping?.version || null,
            direction: evaluation.direction,
            source_identity: sourceIdentity,
            target_identity: targetIdentity,
            source_state: sourceState,
            current_target_state: currentTargetState,
            mapped_target_state: evaluation.mappedTargetState,
            decision: evaluation.status === 'ready' ? 'enqueue_connector_write' : 'hold_for_review',
            reason: evaluation.reason,
            missing_target_fields: evaluation.missingTargetFields,
          },
          timestamp: evaluatedAt,
        });
      });
      if (event) await this.outbox.dispatch(event);
    }

    return {
      transaction_id: transactionId,
      dry_run: dryRun,
      action: evaluation.status === 'ready' ? 'enqueue_connector_write' : 'hold_for_review',
      status: evaluation.status,
      reason: evaluation.reason,
      message: evaluation.message,
      direction: evaluation.direction,
      source_node_id: sourceNode.id,
      target_node_id: targetNode.id,
      source_state: sourceState,
      current_target_state: currentTargetState,
      mapped_target_state: evaluation.mappedTargetState,
      missing_target_fields: evaluation.missingTargetFields,
      mapping: evaluation.mapping
        ? { id: evaluation.mapping.id, version: evaluation.mapping.version, name: evaluation.mapping.name }
        : null,
      evaluated_at: evaluatedAt,
    };
  }

  public async listTransactions(orgId: string, limit = 100): Promise<StateSyncTransaction[]> {
    await this.dbService.initialize();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new InvalidStateMappingError('limit must be an integer from 1 to 500');
    }
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_state_sync_transactions
       WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [orgId, limit],
    );
    return (result.rows || []).map((row: any) => this.mapTransaction(row));
  }

  private async evaluate(
    orgId: string,
    source: SyncIdentity,
    target: SyncIdentity,
    sourceState: string,
    currentTargetState: string | null,
    targetFields: Record<string, unknown>,
  ): Promise<Evaluation> {
    const mapping = await this.findPublishedMapping(orgId, source, target);
    if (!mapping) {
      return {
        mapping: null,
        direction: null,
        rule: null,
        status: 'held',
        reason: 'mapping_not_found',
        message: `No published state mapping exists for ${source.system}/${source.entity_type} → ${target.system}/${target.entity_type}`,
        mappedTargetState: null,
        missingTargetFields: [],
      };
    }
    const direction = this.directionFor(mapping, source, target);
    const rule = mapping.rules.find((candidate) =>
      candidate.direction === direction && this.sameState(candidate.from_state, sourceState)) || null;
    if (!rule) {
      return {
        mapping,
        direction,
        rule: null,
        status: 'held',
        reason: 'unmapped_state',
        message: `State '${sourceState}' has no ${direction} rule in mapping ${mapping.name} v${mapping.version}`,
        mappedTargetState: null,
        missingTargetFields: [],
      };
    }

    const missingTargetFields = rule.required_target_fields.filter((path) => !this.hasValue(targetFields, path));
    if (missingTargetFields.length > 0) {
      return {
        mapping,
        direction,
        rule,
        status: 'held',
        reason: 'missing_required_fields',
        message: `Required target fields are missing: ${missingTargetFields.join(', ')}`,
        mappedTargetState: rule.to_state,
        missingTargetFields,
      };
    }

    if (rule.allowed_target_from_states.length > 0
      && (!currentTargetState
        || !rule.allowed_target_from_states.some((state) => this.sameState(state, currentTargetState)))) {
      const actual = currentTargetState ? `'${currentTargetState}'` : 'an unknown state';
      return {
        mapping,
        direction,
        rule,
        status: 'held',
        reason: 'invalid_target_transition',
        message: `Target is in ${actual}; '${rule.to_state}' is allowed only from ${rule.allowed_target_from_states.join(', ')}`,
        mappedTargetState: rule.to_state,
        missingTargetFields: [],
      };
    }

    return {
      mapping,
      direction,
      rule,
      status: 'ready',
      reason: 'mapped',
      message: `Map '${sourceState}' to '${rule.to_state}' using ${mapping.name} v${mapping.version}`,
      mappedTargetState: rule.to_state,
      missingTargetFields: [],
    };
  }

  private async findPublishedMapping(
    orgId: string,
    source: SyncIdentity,
    target: SyncIdentity,
  ): Promise<StateMappingDefinition | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_state_mapping_definitions
       WHERE org_id = $1 AND status = 'published'
         AND ((source_system = $2 AND source_entity_type = $3
               AND target_system = $4 AND target_entity_type = $5)
           OR (source_system = $4 AND source_entity_type = $5
               AND target_system = $2 AND target_entity_type = $3))
       ORDER BY version DESC LIMIT 1`,
      [orgId, source.system, source.entity_type, target.system, target.entity_type],
    );
    return result.rows[0] ? this.mapDefinition(result.rows[0]) : null;
  }

  private directionFor(
    mapping: StateMappingDefinition,
    source: SyncIdentity,
    target: SyncIdentity,
  ): StateMappingDirection {
    const direct = this.sameEndpoint(mapping.source, source) && this.sameEndpoint(mapping.target, target);
    const reverse = this.sameEndpoint(mapping.target, source) && this.sameEndpoint(mapping.source, target);
    if (!direct && !reverse) {
      throw new StateMappingConflictError('Published mapping does not match the correlated record direction');
    }
    return direct ? 'source_to_target' : 'target_to_source';
  }

  private async requireNode(orgId: string, identity: SyncIdentity): Promise<CorrelationNode> {
    const result = await this.dbService.db.query<any>(
      `SELECT id, system, entity_type, immutable_id
       FROM integration_correlation_nodes
       WHERE org_id = $1 AND system = $2 AND entity_type = $3 AND immutable_id = $4`,
      [orgId, identity.system, identity.entity_type, identity.immutable_id],
    );
    if (result.rows.length === 0) {
      throw new StateMappingIdentityNotFoundError(
        `Correlation identity not found: ${identity.system}/${identity.entity_type}/${identity.immutable_id}`,
      );
    }
    return result.rows[0] as CorrelationNode;
  }

  private async requireCounterpartLink(orgId: string, sourceNodeId: string, targetNodeId: string): Promise<void> {
    const result = await this.dbService.db.query<any>(
      `SELECT id FROM integration_correlation_links
       WHERE org_id = $1 AND relationship = 'counterpart'
         AND ((source_node_id = $2 AND target_node_id = $3)
           OR (source_node_id = $3 AND target_node_id = $2))
       LIMIT 1`,
      [orgId, sourceNodeId, targetNodeId],
    );
    if (result.rows.length === 0) {
      throw new StateMappingConflictError('Source and target are not linked as immutable counterparts');
    }
  }

  private normalizeRules(input: StateMappingRuleInput[] | undefined): StateMappingRule[] {
    if (!Array.isArray(input) || input.length === 0) {
      throw new InvalidStateMappingError('rules must contain at least one state mapping');
    }
    if (input.length > MAX_RULES) throw new InvalidStateMappingError(`rules cannot exceed ${MAX_RULES} entries`);
    const seen = new Set<string>();
    return input.map((rule, index) => {
      if (!rule || typeof rule !== 'object') throw new InvalidStateMappingError(`rules[${index}] must be an object`);
      if (rule.direction !== 'source_to_target' && rule.direction !== 'target_to_source') {
        throw new InvalidStateMappingError(`rules[${index}].direction must be source_to_target or target_to_source`);
      }
      const fromState = this.requiredText(rule.from_state, `rules[${index}].from_state`, 160);
      const toState = this.requiredText(rule.to_state, `rules[${index}].to_state`, 160);
      const key = `${rule.direction}\n${fromState.toLocaleLowerCase()}`;
      if (seen.has(key)) {
        throw new InvalidStateMappingError(`rules contains duplicate ${rule.direction} state '${fromState}'`);
      }
      seen.add(key);
      return {
        direction: rule.direction,
        from_state: fromState,
        to_state: toState,
        required_target_fields: this.normalizeFieldPaths(
          rule.required_target_fields,
          `rules[${index}].required_target_fields`,
        ),
        allowed_target_from_states: this.normalizeStates(
          rule.allowed_target_from_states,
          `rules[${index}].allowed_target_from_states`,
        ),
      };
    });
  }

  private normalizeEndpoint(input: StateMappingEndpoint | undefined, field: string): StateMappingEndpoint {
    if (!input || typeof input !== 'object') throw new InvalidStateMappingError(`${field} is required`);
    return {
      system: this.requiredToken(input.system, `${field}.system`),
      entity_type: this.requiredToken(input.entity_type, `${field}.entity_type`),
    };
  }

  private normalizeIdentity(input: SyncIdentity | undefined, field: string): SyncIdentity {
    const endpoint = this.normalizeEndpoint(input, field);
    return {
      ...endpoint,
      immutable_id: this.requiredText(input?.immutable_id, `${field}.immutable_id`, 512),
    };
  }

  private normalizeFields(input: unknown): Record<string, unknown> {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new InvalidStateMappingError('target_fields must be a JSON object');
    }
    try {
      return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    } catch {
      throw new InvalidStateMappingError('target_fields must be JSON serializable');
    }
  }

  private normalizeFieldPaths(input: unknown, field: string): string[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw new InvalidStateMappingError(`${field} must be an array`);
    const values = input.map((value, index) => {
      const path = this.requiredText(value, `${field}[${index}]`, 128);
      if (!FIELD_PATH_PATTERN.test(path)) {
        throw new InvalidStateMappingError(`${field}[${index}] is not a supported field path`);
      }
      return path;
    });
    return Array.from(new Set(values));
  }

  private normalizeStates(input: unknown, field: string): string[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw new InvalidStateMappingError(`${field} must be an array`);
    const states = input.map((value, index) => this.requiredText(value, `${field}[${index}]`, 160));
    const seen = new Set<string>();
    return states.filter((state) => {
      const key = state.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private hasValue(fields: Record<string, unknown>, path: string): boolean {
    let value: unknown = fields;
    for (const part of path.split('.')) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Object.prototype.hasOwnProperty.call(value, part)) return false;
      value = (value as Record<string, unknown>)[part];
    }
    return value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > 0);
  }

  private sameEndpoint(endpoint: StateMappingEndpoint, identity: SyncIdentity): boolean {
    return endpoint.system === identity.system && endpoint.entity_type === identity.entity_type;
  }

  private sameState(left: string, right: string): boolean {
    return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
  }

  private requiredToken(value: unknown, field: string): string {
    const normalized = this.requiredText(value, field, 64).toLowerCase();
    if (!TOKEN_PATTERN.test(normalized)) {
      throw new InvalidStateMappingError(`${field} contains unsupported characters`);
    }
    return normalized;
  }

  private requiredText(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new InvalidStateMappingError(`${field} is required`);
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      throw new InvalidStateMappingError(`${field} must be ${maxLength} characters or fewer`);
    }
    return normalized;
  }

  private requireUuid(value: string, field: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new InvalidStateMappingError(`${field} must be a UUID`);
    }
  }

  private mappingEventPayload(definition: StateMappingDefinition) {
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

  private mapDefinition(row: any): StateMappingDefinition {
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
      created_by: row.created_by,
      created_at: this.toIso(row.created_at),
      published_by: row.published_by ?? null,
      published_at: row.published_at ? this.toIso(row.published_at) : null,
    };
  }

  private mapTransaction(row: any): StateSyncTransaction {
    return {
      id: row.id,
      org_id: row.org_id,
      mapping_definition_id: row.mapping_definition_id ?? null,
      mapping_version: row.mapping_version === null || row.mapping_version === undefined
        ? null
        : Number(row.mapping_version),
      source_node_id: row.source_node_id,
      target_node_id: row.target_node_id,
      direction: row.direction,
      source_state: row.source_state,
      target_state_before: row.target_state_before ?? null,
      mapped_target_state: row.mapped_target_state ?? null,
      required_target_fields: typeof row.required_target_fields === 'string'
        ? JSON.parse(row.required_target_fields)
        : (row.required_target_fields || []),
      provided_target_fields: typeof row.provided_target_fields === 'string'
        ? JSON.parse(row.provided_target_fields)
        : (row.provided_target_fields || {}),
      status: row.status,
      reason: row.reason,
      actor_id: row.actor_id,
      created_at: this.toIso(row.created_at),
    };
  }

  private toIso(value: unknown): string {
    return new Date(value as string | number | Date).toISOString();
  }
}
