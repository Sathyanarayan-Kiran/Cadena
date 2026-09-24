import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../../../database/database.service';
import { EventOutboxService } from '../../events/event-outbox.service';
import { ConnectorService } from '../connector.service';
import { ConnectorRemoteError } from '../connector-http';
import { ConnectorProviderType, ConnectorRecord } from '../connector.types';
import { validateNativeQuery } from './native-query-validator';
import {
  CreateNativeQueryDto,
  InvalidNativeQueryError,
  NativeQueryConflictError,
  NativeQueryDefinition,
  NativeQueryLanguage,
  NativeQueryNotFoundError,
  NativeQueryRunResult,
  NativeQueryValidation,
  UpdateNativeQueryDto,
} from './native-query.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 86_400;
const DEFAULT_INTERVAL_SECONDS = 900;
/** A first run may start at most this far back; deeper history is a backfill, not a trigger. */
const MAX_LOOKBACK_MS = 366 * 86_400_000;
/** Provider → the one native query language a scheduled query for it is written in. */
const PROVIDER_LANGUAGE: Partial<Record<ConnectorProviderType, NativeQueryLanguage>> = {
  jira: 'jql',
  servicenow: 'encoded',
};

/** A claimed run holds its query for this long; a crashed worker's claim simply expires. */
const RUN_LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_SECONDS = 6 * 3600;

class LeaseLostError extends Error {}

/** A definition together with the lease token proving this worker may run it. */
type ClaimedQuery = NativeQueryDefinition & { leaseOwner: string };

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);

/**
 * Definitions and lifecycle of scheduled native-query triggers (US17.3).
 *
 * A query is bound to one connector, written in that provider's native language, and starts as a
 * draft. Publishing re-runs validation and is refused while the query could scan without bound;
 * the watermark it starts from is fixed at publication, so a run can never reach older history.
 */
@Injectable()
export class NativeQueryService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private readonly workerId = randomUUID();

  constructor(@Inject(ConnectorService) private readonly connectors: ConnectorService) {}

  public validateAdHoc(language: unknown, query: unknown): NativeQueryValidation {
    if (language !== 'jql' && language !== 'wiql' && language !== 'encoded') {
      throw new InvalidNativeQueryError("language must be 'jql', 'wiql' or 'encoded'");
    }
    if (typeof query !== 'string') throw new InvalidNativeQueryError('query must be a string');
    return validateNativeQuery(language, query);
  }

  public async createDraft(orgId: string, dto: CreateNativeQueryDto, actorId: string): Promise<NativeQueryDefinition> {
    await this.dbService.initialize();
    const name = this.requiredText(dto?.name, 'name', 160);
    const query = this.requiredText(dto?.query, 'query', 100_000);
    const entityType = this.requiredText(dto?.entity_type, 'entity_type', 80);
    const { language } = await this.resolveTarget(orgId, dto?.connector_id, entityType);
    const interval = this.interval(dto.interval_seconds);
    const startFrom = this.startFrom(dto.start_from);

    let created!: NativeQueryDefinition;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const duplicate = await tx.query<any>(
        `SELECT 1 FROM integration_native_queries WHERE org_id = $1 AND name = $2`, [orgId, name],
      );
      if (duplicate.rows.length) throw new NativeQueryConflictError(`A native query named '${name}' already exists`);
      const inserted = await tx.query<any>(
        `INSERT INTO integration_native_queries
         (id, org_id, connector_id, name, language, entity_type, query, interval_seconds, status,
          start_from, validation, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          randomUUID(), orgId, dto.connector_id, name, language, entityType, query, interval, startFrom,
          JSON.stringify(validateNativeQuery(language, query)), actorId,
        ],
      );
      created = this.map(inserted.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'NativeQueryDraftCreated',
        work_item_id: created.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.eventPayload(created),
      });
    });
    if (event) await this.outbox.dispatch(event);
    return created;
  }

  /** Edits a draft or disabled query. A published query must be disabled first so its watermark cannot silently outlive its text. */
  public async update(orgId: string, id: string, dto: UpdateNativeQueryDto): Promise<NativeQueryDefinition> {
    const current = await this.get(orgId, id);
    if (current.status === 'published') throw new NativeQueryConflictError('Disable a published query before editing it');
    const name = dto?.name === undefined ? current.name : this.requiredText(dto.name, 'name', 160);
    const query = dto?.query === undefined ? current.query : this.requiredText(dto.query, 'query', 100_000);
    const entityType = dto?.entity_type === undefined ? current.entity_type : this.requiredText(dto.entity_type, 'entity_type', 80);
    await this.resolveTarget(orgId, current.connector_id, entityType);
    const interval = dto?.interval_seconds === undefined ? current.interval_seconds : this.interval(dto.interval_seconds);
    const startFrom = dto?.start_from === undefined ? current.start_from : this.startFrom(dto.start_from);
    const result = await this.dbService.db.query<any>(
      `UPDATE integration_native_queries
       SET name = $3, query = $4, entity_type = $5, interval_seconds = $6, start_from = $7, validation = $8
       WHERE org_id = $1 AND id = $2 RETURNING *`,
      [orgId, id, name, query, entityType, interval, startFrom, JSON.stringify(validateNativeQuery(current.language, query))],
    ).catch((error: any) => {
      if (/unique/i.test(String(error?.message))) throw new NativeQueryConflictError(`A native query named '${name}' already exists`);
      throw error;
    });
    return this.map(result.rows[0]);
  }

  /** Publishes after re-validating. An unbounded query is refused with the validator's actionable hint. */
  public async publish(orgId: string, id: string, actorId: string): Promise<NativeQueryDefinition> {
    const current = await this.get(orgId, id);
    if (current.status === 'published') return current;

    // Reads happen before the transaction: PGlite serializes one connection, so querying through
    // the service connection while a transaction is open on it would deadlock.
    const { connector } = await this.resolveTarget(orgId, current.connector_id, current.entity_type);
    if (!connector.activatedAt) {
      throw new NativeQueryConflictError('The connector must be discovered and activated before a query on it can be published');
    }
    const validation = validateNativeQuery(current.language, current.query);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw new InvalidNativeQueryError(`Cannot publish: ${first.message} ${first.hint}`, validation);
    }

    const hash = createHash('sha256').update(`${current.language}\n${current.entity_type}\n${current.query}`).digest('hex');
    let published!: NativeQueryDefinition;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const guard = await tx.query<any>(`SELECT status, watermark, watermark_query_hash FROM integration_native_queries WHERE org_id = $1 AND id = $2`, [orgId, id]);
      if (guard.rows[0]?.status === 'published') {
        published = this.map((await tx.query<any>(`SELECT * FROM integration_native_queries WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]);
        return;
      }
      // The watermark only survives a re-publish of the *same* query; changed text or scope could
      // match records that changed before it, so it restarts from `start_from`.
      const keepWatermark = guard.rows[0]?.watermark && guard.rows[0]?.watermark_query_hash === hash;
      const result = await tx.query<any>(
        `UPDATE integration_native_queries
         SET status = 'published', validation = $3, watermark_query_hash = $4,
             watermark = ${keepWatermark ? 'watermark' : 'COALESCE(start_from, CURRENT_TIMESTAMP)'},
             next_run_at = CURRENT_TIMESTAMP, consecutive_failures = 0, last_error = NULL,
             published_by = $5, published_at = CURRENT_TIMESTAMP
         WHERE org_id = $1 AND id = $2 RETURNING *`,
        [orgId, id, JSON.stringify(validation), hash, actorId],
      );
      published = this.map(result.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'NativeQueryPublished',
        work_item_id: published.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.eventPayload(published),
      });
    });
    if (event) await this.outbox.dispatch(event);
    return published;
  }

  public async disable(orgId: string, id: string, actorId: string): Promise<NativeQueryDefinition> {
    const current = await this.get(orgId, id);
    if (current.status !== 'published') return current;
    let disabled!: NativeQueryDefinition;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const result = await tx.query<any>(
        `UPDATE integration_native_queries
         SET status = 'disabled', next_run_at = NULL, lease_owner = NULL, lease_expires_at = NULL
         WHERE org_id = $1 AND id = $2 RETURNING *`,
        [orgId, id],
      );
      disabled = this.map(result.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'NativeQueryDisabled',
        work_item_id: disabled.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.eventPayload(disabled),
      });
    });
    if (event) await this.outbox.dispatch(event);
    return disabled;
  }

  public async list(orgId: string): Promise<NativeQueryDefinition[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_native_queries WHERE org_id = $1 ORDER BY name ASC`, [orgId],
    );
    return result.rows.map((row: any) => this.map(row));
  }

  public async get(orgId: string, id: string): Promise<NativeQueryDefinition> {
    await this.dbService.initialize();
    if (!UUID.test(id)) throw new NativeQueryNotFoundError('Native query not found');
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_native_queries WHERE org_id = $1 AND id = $2`, [orgId, id],
    );
    if (!result.rows.length) throw new NativeQueryNotFoundError('Native query not found');
    return this.map(result.rows[0]);
  }

  // ─── Runs ────────────────────────────────────────────────────────────────

  /** Operator action: runs one published query immediately, outside its schedule. */
  public async runNow(orgId: string, id: string, actorId: string): Promise<NativeQueryRunResult> {
    const current = await this.get(orgId, id);
    if (current.status !== 'published') throw new NativeQueryConflictError('Only a published query can run; publish it first');
    const claimed = await this.claim('org_id = $2 AND id = $3', [orgId, id], 1);
    if (!claimed.length) throw new NativeQueryConflictError('This query is already running');
    return this.execute(claimed[0], actorId, true);
  }

  /** Scheduler entry point: runs every published query whose next run has come due, oldest first. */
  public async runDue(limit = 10): Promise<NativeQueryRunResult[]> {
    await this.dbService.initialize();
    const claimed = await this.claim('next_run_at <= CURRENT_TIMESTAMP', [], limit);
    const results: NativeQueryRunResult[] = [];
    for (const definition of claimed) results.push(await this.execute(definition, 'native-query-scheduler', false));
    return results;
  }

  /**
   * Atomically takes the run lease on published, unleased queries, so two schedulers (or a
   * scheduler and an operator) can never run the same query at once. Parameters are: $1 the lease
   * owner, then `params`, then the row limit and the lease expiry.
   */
  private async claim(condition: string, params: unknown[], limit: number): Promise<ClaimedQuery[]> {
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    const expires = new Date(Date.now() + RUN_LEASE_MS).toISOString();
    const result = await this.dbService.db.query<any>(
      `UPDATE integration_native_queries SET lease_owner = $1, lease_expires_at = $${params.length + 3}
       WHERE id IN (
         SELECT id FROM integration_native_queries
         WHERE status = 'published' AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
           AND ${condition}
         ORDER BY next_run_at ASC NULLS LAST LIMIT $${params.length + 2}
       ) RETURNING *`,
      [leaseOwner, ...params, limit, expires],
    );
    return result.rows.map((row: any) => ({ ...this.map(row), leaseOwner }));
  }

  private async execute(definition: ClaimedQuery, actorId: string, manual: boolean): Promise<NativeQueryRunResult> {
    const { leaseOwner } = definition;
    const base = { query_id: definition.id, fetched: 0, enqueued: 0, watermark: definition.watermark, has_more: false };

    let connector: ConnectorRecord;
    try {
      connector = await this.connectors.getConnector(definition.org_id, definition.connector_id);
    } catch (error) {
      return this.fail(definition, `Connector unavailable: ${this.message(error)}`, base);
    }
    if (!connector.activatedAt || connector.status === 'paused') {
      const reason = connector.status === 'paused' ? 'The connector is paused' : 'The connector is not activated';
      await this.dbService.db.query(
        `UPDATE integration_native_queries
         SET next_run_at = $3, last_error = $4, lease_owner = NULL, lease_expires_at = NULL
         WHERE org_id = $1 AND id = $2 AND lease_owner = $5`,
        [definition.org_id, definition.id, new Date(Date.now() + definition.interval_seconds * 1000).toISOString(), `Skipped: ${reason}`, leaseOwner],
      );
      return { ...base, status: 'skipped', message: reason };
    }

    // Re-validated on every run so a query saved under older rules, or edited at rest, still cannot scan unbounded.
    const validation = validateNativeQuery(definition.language, definition.query);
    if (!validation.valid) {
      return this.fail(definition, `Query no longer passes validation: ${validation.errors[0].message} ${validation.errors[0].hint}`, base);
    }
    if (!definition.watermark) return this.fail(definition, 'The query has no watermark; publish it again', base);
    const priorWatermark = definition.watermark;

    let page;
    try {
      page = await this.connectors.fetchNativeQueryPage(connector, definition.entity_type, definition.query, {
        entityType: definition.entity_type,
        cursorValue: priorWatermark,
      });
    } catch (error) {
      return this.fail(
        definition,
        this.message(error),
        base,
        error instanceof ConnectorRemoteError ? error.retryAfterSeconds : undefined,
      );
    }

    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    let watermark = priorWatermark;
    try {
      const accepted = await this.connectors.enqueueNativeQueryRecords(
        definition.org_id, connector, definition.entity_type, page.records,
        async (tx, inserted) => {
          // Never move backwards: a run reads from a minute of overlap before the watermark.
          watermark = new Date(Math.max(Date.parse(priorWatermark), Date.parse(page.nextCursor.cursorValue))).toISOString();
          const nextRun = page.hasMore ? new Date() : new Date(Date.now() + definition.interval_seconds * 1000);
          const updated = await tx.query<any>(
            `UPDATE integration_native_queries
             SET watermark = $3, last_run_at = CURRENT_TIMESTAMP, last_run_status = 'succeeded', last_error = NULL,
                 last_enqueued = $4, total_enqueued = total_enqueued + $4, consecutive_failures = 0,
                 next_run_at = $5, lease_owner = NULL, lease_expires_at = NULL
             WHERE org_id = $1 AND id = $2 AND lease_owner = $6 AND status = 'published'
             RETURNING id`,
            [definition.org_id, definition.id, watermark, inserted, nextRun.toISOString(), leaseOwner],
          );
          // Disabled or re-leased mid-run: abandon the whole transaction, records included.
          if (!updated.rows.length) throw new LeaseLostError();
          if (manual || inserted > 0) {
            event = await this.outbox.enqueue(tx, {
              event_type: 'NativeQueryRunCompleted',
              work_item_id: definition.id,
              org_id: definition.org_id,
              actor: { type: manual ? 'user' : 'system', id: actorId },
              payload: {
                ...this.eventPayload(definition),
                fetched: page.records.length,
                enqueued: inserted,
                watermark,
                has_more: page.hasMore,
                trigger: manual ? 'manual' : 'schedule',
              },
            });
          }
        },
      );
      if (event) await this.outbox.dispatch(event);
      // Best effort: the records are durable, and the next sync drains them if a sync holds the lease.
      if (accepted.inserted > 0) await this.connectors.drainIngestionQueue(definition.org_id, definition.connector_id).catch(() => false);
      return { ...base, status: 'succeeded', fetched: page.records.length, enqueued: accepted.inserted, watermark, has_more: page.hasMore };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return { ...base, status: 'skipped', message: 'The query was disabled or taken over while it ran; nothing was enqueued' };
      }
      return this.fail(definition, this.message(error), base);
    }
  }

  /** Records a failed run, keeps the watermark where it was, and backs off exponentially up to six hours. */
  private async fail(
    definition: ClaimedQuery,
    message: string,
    base: Omit<NativeQueryRunResult, 'status'>,
    retryAfterSeconds?: number,
  ): Promise<NativeQueryRunResult> {
    const failures = definition.consecutive_failures + 1;
    const exponential = Math.min(definition.interval_seconds * 2 ** (failures - 1), Math.max(definition.interval_seconds, MAX_BACKOFF_SECONDS));
    const backoff = Math.max(exponential, Math.ceil(retryAfterSeconds || 0));
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const updated = await tx.query<any>(
        `UPDATE integration_native_queries
         SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'failed', last_error = $3,
             consecutive_failures = $4, next_run_at = $5, lease_owner = NULL, lease_expires_at = NULL
         WHERE org_id = $1 AND id = $2 AND lease_owner = $6
         RETURNING id`,
        [definition.org_id, definition.id, message.slice(0, 500), failures, new Date(Date.now() + backoff * 1000).toISOString(), definition.leaseOwner],
      );
      if (!updated.rows.length) return;
      event = await this.outbox.enqueue(tx, {
        event_type: 'NativeQueryRunFailed',
        work_item_id: definition.id,
        org_id: definition.org_id,
        actor: { type: 'system', id: 'native-query-scheduler' },
        payload: { ...this.eventPayload(definition), error: message.slice(0, 500), consecutive_failures: failures },
      });
    });
    if (event) await this.outbox.dispatch(event);
    return { ...base, status: 'failed', message };
  }

  private message(error: unknown): string {
    const response = (error as any)?.getResponse?.();
    if (response) return typeof response === 'string' ? response : String(response?.message || (error as Error).message);
    return (error as Error)?.message || 'Query run failed';
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** The connector must belong to the tenant, speak a language a query can be written in, and expose the entity type. */
  private async resolveTarget(orgId: string, connectorId: unknown, entityType: string) {
    if (typeof connectorId !== 'string' || !UUID.test(connectorId)) throw new InvalidNativeQueryError('connector_id must be a connector UUID');
    const connector = await this.connectors.getConnector(orgId, connectorId);
    const language = PROVIDER_LANGUAGE[connector.provider];
    if (!language) {
      throw new InvalidNativeQueryError(
        `Scheduled queries are supported for Jira (JQL) and ServiceNow (encoded query) connectors; ${connector.provider} has no query runner. WIQL can be checked with POST /integrations/native-queries/validate but not scheduled.`,
      );
    }
    const entityTypes = this.connectors.getAdapter(connector.provider).entityTypes(connector.config);
    if (!entityTypes.includes(entityType)) {
      throw new InvalidNativeQueryError(`entity_type '${entityType}' is not configured on this connector (available: ${entityTypes.join(', ')})`);
    }
    return { connector, language };
  }

  private requiredText(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new InvalidNativeQueryError(`${field} is required`);
    if (value.trim().length > max) throw new InvalidNativeQueryError(`${field} must be at most ${max} characters`);
    return value.trim();
  }

  private interval(value: unknown): number {
    if (value === undefined || value === null) return DEFAULT_INTERVAL_SECONDS;
    if (!Number.isInteger(value) || (value as number) < MIN_INTERVAL_SECONDS || (value as number) > MAX_INTERVAL_SECONDS) {
      throw new InvalidNativeQueryError(`interval_seconds must be a whole number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`);
    }
    return value as number;
  }

  private startFrom(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isNaN(parsed)) throw new InvalidNativeQueryError('start_from must be an ISO-8601 timestamp');
    if (parsed > Date.now() + 60_000) throw new InvalidNativeQueryError('start_from cannot be in the future');
    if (parsed < Date.now() - MAX_LOOKBACK_MS) {
      throw new InvalidNativeQueryError('start_from is more than 366 days back; a trigger cannot replay that much history. Choose a more recent watermark.');
    }
    return new Date(parsed).toISOString();
  }

  private eventPayload(query: NativeQueryDefinition) {
    return {
      query_id: query.id,
      connector_id: query.connector_id,
      name: query.name,
      language: query.language,
      entity_type: query.entity_type,
      interval_seconds: query.interval_seconds,
      status: query.status,
      watermark: query.watermark,
    };
  }

  private map(row: any): NativeQueryDefinition {
    return {
      id: row.id,
      org_id: row.org_id,
      connector_id: row.connector_id,
      name: row.name,
      language: row.language,
      entity_type: row.entity_type,
      query: row.query,
      interval_seconds: Number(row.interval_seconds),
      status: row.status,
      start_from: iso(row.start_from),
      watermark: iso(row.watermark),
      validation: typeof row.validation === 'string' ? JSON.parse(row.validation) : row.validation,
      next_run_at: iso(row.next_run_at),
      last_run_at: iso(row.last_run_at),
      last_run_status: row.last_run_status ?? null,
      last_error: row.last_error ?? null,
      last_enqueued: Number(row.last_enqueued || 0),
      total_enqueued: Number(row.total_enqueued || 0),
      consecutive_failures: Number(row.consecutive_failures || 0),
      created_by: row.created_by,
      created_at: iso(row.created_at)!,
      published_by: row.published_by ?? null,
      published_at: iso(row.published_at),
    };
  }
}
