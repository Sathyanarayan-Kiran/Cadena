import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../../database/database.service';
import { EventOutboxService } from '../../events/event-outbox.service';
import { ConnectorService } from '../connector.service';
import { validateNativeQuery } from '../native-query/native-query-validator';
import { NativeQueryLanguage } from '../native-query/native-query.types';
import { BackfillPlanError, DEFAULT_CHUNK_SECONDS, floorToMinute, planChunks } from './backfill-planner';
import {
  BackfillChunk,
  BackfillConflictError,
  BackfillCounts,
  BackfillJob,
  BackfillJobStatus,
  BackfillNotFoundError,
  CreateBackfillJobDto,
  InvalidBackfillError,
} from './backfill.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_RPM = 300;
const PROVIDER_LANGUAGE: Record<string, NativeQueryLanguage> = { jira: 'jql', servicenow: 'encoded' };

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);

/**
 * Governed historical backfill jobs (US17.4).
 *
 * A job is a time range split into persisted chunks. Nothing is read from a provider until an
 * operator starts it, and at most one job per connector runs at a time so a migration cannot
 * stack load on a platform that is also being synchronized. Execution lives in
 * `BackfillRunnerService`; this service owns the plan, the lifecycle and the counts.
 */
@Injectable()
export class BackfillService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();

  constructor(@Inject(ConnectorService) private readonly connectors: ConnectorService) {}

  public async create(orgId: string, dto: CreateBackfillJobDto, actorId: string): Promise<BackfillJob> {
    await this.dbService.initialize();
    const name = this.text(dto?.name, 'name', 160);
    const entityType = this.text(dto?.entity_type, 'entity_type', 80);
    if (typeof dto?.connector_id !== 'string' || !UUID.test(dto.connector_id)) throw new InvalidBackfillError('connector_id must be a connector UUID');
    const connector = await this.connectors.getConnector(orgId, dto.connector_id);
    const language = PROVIDER_LANGUAGE[connector.provider];
    if (!language || !this.connectors.supportsBackfill(connector)) {
      throw new InvalidBackfillError(`Historical backfill is supported for Jira and ServiceNow connectors; ${connector.provider} has no backfill adapter.`);
    }
    if (!connector.activatedAt) throw new BackfillConflictError('The connector must be discovered and activated before a backfill can be planned');
    const entityTypes = this.connectors.getAdapter(connector.provider).entityTypes(connector.config);
    if (!entityTypes.includes(entityType)) {
      throw new InvalidBackfillError(`entity_type '${entityType}' is not configured on this connector (available: ${entityTypes.join(', ')})`);
    }

    let query: string | null = null;
    if (dto.query !== undefined && dto.query !== null && String(dto.query).trim()) {
      query = this.text(dto.query, 'query', 100_000);
      const validation = validateNativeQuery(language, query);
      if (!validation.valid) {
        throw new InvalidBackfillError(`Cannot plan: ${validation.errors[0].message} ${validation.errors[0].hint}`, validation);
      }
    }

    const from = this.instant(dto.from, 'from');
    const to = dto.to === undefined || dto.to === null ? floorToMinute(new Date()) : this.instant(dto.to, 'to');
    if (to.getTime() > Date.now() + 60_000) throw new InvalidBackfillError('to cannot be in the future; a backfill reads history that already exists');
    const chunkSeconds = dto.chunk_seconds === undefined ? DEFAULT_CHUNK_SECONDS : dto.chunk_seconds;
    let chunks;
    try {
      chunks = planChunks(from, to, chunkSeconds);
    } catch (error) {
      if (error instanceof BackfillPlanError) throw new InvalidBackfillError(error.message);
      throw error;
    }
    const maxConcurrency = this.bounded(dto.max_concurrency, DEFAULT_MAX_CONCURRENCY, 1, 8, 'max_concurrency');
    const maxRpm = this.bounded(dto.max_requests_per_minute, DEFAULT_MAX_RPM, 1, 6000, 'max_requests_per_minute');

    let job!: BackfillJob;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const inserted = await tx.query<any>(
        `INSERT INTO integration_backfill_jobs
         (id, org_id, connector_id, name, entity_type, language, query, from_at, to_at, chunk_seconds,
          status, max_concurrency, max_requests_per_minute, concurrency, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, 1, $13, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          randomUUID(), orgId, connector.id, name, entityType, query ? language : null, query,
          chunks[0].windowStart.toISOString(), chunks[chunks.length - 1].windowEnd.toISOString(), chunkSeconds,
          maxConcurrency, maxRpm, actorId,
        ],
      );
      job = this.map(inserted.rows[0]);
      await tx.query(
        `INSERT INTO integration_backfill_chunks (id, job_id, org_id, seq, window_start, window_end)
         SELECT gen_random_uuid(), $1, $2, (c->>'seq')::int, (c->>'start')::timestamptz, (c->>'end')::timestamptz
         FROM jsonb_array_elements($3::jsonb) AS c`,
        [job.id, orgId, JSON.stringify(chunks.map((chunk) => ({
          seq: chunk.seq, start: chunk.windowStart.toISOString(), end: chunk.windowEnd.toISOString(),
        })))],
      );
      event = await this.outbox.enqueue(tx, {
        event_type: 'BackfillJobCreated',
        work_item_id: job.id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: { ...this.eventPayload(job), chunk_count: chunks.length },
      });
    });
    if (event) await this.outbox.dispatch(event);
    return this.withCounts(job);
  }

  public async start(orgId: string, id: string, actorId: string): Promise<BackfillJob> {
    return this.activate(orgId, id, actorId, ['pending'], 'BackfillJobStarted', 'Only a pending job can be started');
  }

  public async resume(orgId: string, id: string, actorId: string): Promise<BackfillJob> {
    return this.activate(orgId, id, actorId, ['paused'], 'BackfillJobResumed', 'Only a paused job can be resumed');
  }

  public async pause(orgId: string, id: string, actorId: string): Promise<BackfillJob> {
    return this.transition(orgId, id, actorId, ['running'], 'paused', 'BackfillJobPaused', 'Only a running job can be paused');
  }

  public async cancel(orgId: string, id: string, actorId: string): Promise<BackfillJob> {
    return this.transition(orgId, id, actorId, ['pending', 'running', 'paused'], 'cancelled', 'BackfillJobCancelled', 'Only an unfinished job can be cancelled');
  }

  /** Puts failed chunks back in the queue. Safe because every page is de-duplicated on enqueue. */
  public async retryFailed(orgId: string, id: string, actorId: string): Promise<BackfillJob> {
    const job = await this.get(orgId, id);
    if (!['completed_with_errors', 'running', 'paused'].includes(job.status)) {
      throw new BackfillConflictError('Only a job with failed chunks can retry them');
    }
    if ((job.counts?.chunks.failed ?? 0) === 0) throw new BackfillConflictError('This job has no failed chunks');
    if (job.status === 'completed_with_errors') await this.assertNoOtherActive(orgId, job.connector_id, job.id);
    let updated!: BackfillJob;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE integration_backfill_chunks
         SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE org_id = $1 AND job_id = $2 AND status = 'failed'`,
        [orgId, id],
      );
      const result = await tx.query<any>(
        `UPDATE integration_backfill_jobs
         SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'running' END, finished_at = NULL, last_error = NULL
         WHERE org_id = $1 AND id = $2 RETURNING *`,
        [orgId, id],
      );
      updated = this.map(result.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'BackfillFailedChunksRetried',
        work_item_id: id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: { ...this.eventPayload(updated), retried_chunks: job.counts?.chunks.failed },
      });
    });
    if (event) await this.outbox.dispatch(event);
    return this.withCounts(updated);
  }

  public async list(orgId: string): Promise<BackfillJob[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_backfill_jobs WHERE org_id = $1 ORDER BY created_at DESC, id`, [orgId],
    );
    return Promise.all(result.rows.map((row: any) => this.withCounts(this.map(row))));
  }

  public async get(orgId: string, id: string): Promise<BackfillJob> {
    return this.withCounts(await this.row(orgId, id));
  }

  public async chunks(orgId: string, id: string): Promise<BackfillChunk[]> {
    await this.row(orgId, id);
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_backfill_chunks WHERE org_id = $1 AND job_id = $2 ORDER BY seq ASC`, [orgId, id],
    );
    return result.rows.map((row: any) => ({
      seq: Number(row.seq),
      window_start: iso(row.window_start)!,
      window_end: iso(row.window_end)!,
      status: row.status,
      attempts: Number(row.attempts),
      pages: Number(row.pages),
      fetched: Number(row.fetched),
      enqueued: Number(row.enqueued),
      duplicates: Number(row.duplicates),
      last_error: row.last_error ?? null,
    }));
  }

  /**
   * Chunk, record and queue counts. The queue figures are read from the ingestion queue itself, so
   * they report what really happened to the job's rows (twins created, retrying, dead-lettered)
   * rather than a second tally that could drift from it.
   */
  public async counts(orgId: string, id: string): Promise<BackfillCounts> {
    const [chunks, queue] = await Promise.all([
      this.dbService.db.query<any>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'running')::int AS running,
                COUNT(*) FILTER (WHERE status = 'done')::int AS done,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COALESCE(SUM(fetched), 0)::int AS fetched,
                COALESCE(SUM(enqueued), 0)::int AS enqueued,
                COALESCE(SUM(duplicates), 0)::int AS duplicates
         FROM integration_backfill_chunks WHERE org_id = $1 AND job_id = $2`, [orgId, id],
      ),
      this.dbService.db.query<any>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'retry', 'processing'))::int AS queued,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS processed,
                COUNT(*) FILTER (WHERE status = 'dead')::int AS failed
         FROM integration_connector_ingestion_queue WHERE org_id = $1 AND backfill_job_id = $2`, [orgId, id],
      ),
    ]);
    const c = chunks.rows[0];
    const q = queue.rows[0];
    return {
      chunks: { total: Number(c.total), pending: Number(c.pending), running: Number(c.running), done: Number(c.done), failed: Number(c.failed) },
      records: { fetched: Number(c.fetched), enqueued: Number(c.enqueued), duplicates: Number(c.duplicates) },
      queue: { queued: Number(q.queued), processed: Number(q.processed), failed: Number(q.failed) },
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async activate(orgId: string, id: string, actorId: string, from: BackfillJobStatus[], eventType: string, refusal: string): Promise<BackfillJob> {
    const job = await this.row(orgId, id);
    if (!from.includes(job.status)) throw new BackfillConflictError(refusal);
    await this.assertNoOtherActive(orgId, job.connector_id, id);
    return this.transition(orgId, id, actorId, from, 'running', eventType, refusal);
  }

  private async assertNoOtherActive(orgId: string, connectorId: string, exceptId: string): Promise<void> {
    const other = await this.dbService.db.query<any>(
      `SELECT id, name FROM integration_backfill_jobs
       WHERE org_id = $1 AND connector_id = $2 AND status = 'running' AND id <> $3 LIMIT 1`,
      [orgId, connectorId, exceptId],
    );
    if (other.rows.length) {
      throw new BackfillConflictError(`Backfill job '${other.rows[0].name}' is already running on this connector; pause or finish it first so the provider is not loaded twice`);
    }
  }

  private async transition(
    orgId: string, id: string, actorId: string, from: BackfillJobStatus[], to: BackfillJobStatus, eventType: string, refusal: string,
  ): Promise<BackfillJob> {
    let updated!: BackfillJob;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const result = await tx.query<any>(
        `UPDATE integration_backfill_jobs
         SET status = $3,
             started_at = CASE WHEN $3 = 'running' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
             finished_at = CASE WHEN $3 = 'cancelled' THEN CURRENT_TIMESTAMP ELSE finished_at END,
             lease_owner = CASE WHEN $3 = 'running' THEN lease_owner ELSE NULL END,
             lease_expires_at = CASE WHEN $3 = 'running' THEN lease_expires_at ELSE NULL END
         WHERE org_id = $1 AND id = $2 AND status = ANY($4::text[])
         RETURNING *`,
        [orgId, id, to, from],
      );
      if (!result.rows.length) throw new BackfillConflictError(refusal);
      updated = this.map(result.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: eventType,
        work_item_id: id,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: this.eventPayload(updated),
      });
    });
    if (event) await this.outbox.dispatch(event);
    return this.withCounts(updated);
  }

  private async row(orgId: string, id: string): Promise<BackfillJob> {
    await this.dbService.initialize();
    if (!UUID.test(id)) throw new BackfillNotFoundError('Backfill job not found');
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_backfill_jobs WHERE org_id = $1 AND id = $2`, [orgId, id],
    );
    if (!result.rows.length) throw new BackfillNotFoundError('Backfill job not found');
    return this.map(result.rows[0]);
  }

  private async withCounts(job: BackfillJob): Promise<BackfillJob> {
    return { ...job, counts: await this.counts(job.org_id, job.id) };
  }

  private text(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new InvalidBackfillError(`${field} is required`);
    if (value.trim().length > max) throw new InvalidBackfillError(`${field} must be at most ${max} characters`);
    return value.trim();
  }

  private instant(value: unknown, field: string): Date {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isNaN(parsed)) throw new InvalidBackfillError(`${field} must be an ISO-8601 timestamp`);
    return new Date(parsed);
  }

  private bounded(value: unknown, fallback: number, min: number, max: number, field: string): number {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new InvalidBackfillError(`${field} must be a whole number between ${min} and ${max}`);
    }
    return value as number;
  }

  private eventPayload(job: BackfillJob) {
    return {
      job_id: job.id,
      connector_id: job.connector_id,
      name: job.name,
      entity_type: job.entity_type,
      from: job.from,
      to: job.to,
      chunk_seconds: job.chunk_seconds,
      status: job.status,
    };
  }

  private map(row: any): BackfillJob {
    return {
      id: row.id,
      org_id: row.org_id,
      connector_id: row.connector_id,
      name: row.name,
      entity_type: row.entity_type,
      language: row.language ?? null,
      query: row.query ?? null,
      from: iso(row.from_at)!,
      to: iso(row.to_at)!,
      chunk_seconds: Number(row.chunk_seconds),
      status: row.status,
      max_concurrency: Number(row.max_concurrency),
      max_requests_per_minute: Number(row.max_requests_per_minute),
      limiter: { concurrency: Number(row.concurrency), delay_ms: Number(row.delay_ms), throttle_events: Number(row.throttle_events) },
      last_error: row.last_error ?? null,
      created_by: row.created_by,
      created_at: iso(row.created_at)!,
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
    };
  }
}
