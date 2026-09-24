import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../../database/database.service';
import { EventOutboxService } from '../../events/event-outbox.service';
import { ConnectorService } from '../connector.service';
import { ConnectorLoadShedError, ConnectorRemoteError } from '../connector-http';
import { ConnectorRecord } from '../connector.types';
import { AdaptiveLimiter, RequestPacer } from './adaptive-limiter';
import { BackfillService } from './backfill.service';
import { BackfillConflictError, BackfillJob, BackfillRunResult } from './backfill.types';

/** A run holds a job for this long; a crashed worker's lease simply expires and the job resumes. */
const JOB_LEASE_MS = 2 * 60_000;
/** A scheduler tick works on a job for at most this long, then yields so other jobs get a turn. */
const DEFAULT_SLICE_MS = 20_000;
/** A chunk that keeps failing transiently is given up on, not retried forever. */
const MAX_CHUNK_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;

class LeaseLostError extends Error {}

type ClaimedJob = BackfillJob & { leaseOwner: string };

interface ChunkRow {
  id: string;
  seq: number;
  window_start: Date;
  window_end: Date;
  attempts: number;
  page_token: string | null;
}

interface StepResult {
  pages: number;
  enqueued: number;
}

/**
 * Executes backfill jobs (US17.4).
 *
 * A job is worked in rounds. Each round takes up to `limiter.concurrency` chunks, reads one page of
 * each (every request paced by one shared rate limit), and commits each page atomically with the
 * chunk's progress, so a crash, a pause or a lost lease never leaves a page half-recorded: the chunk
 * simply resumes from its saved page token, and anything read twice is dropped by the ingestion
 * queue's dedupe key. Throttling responses shrink concurrency and add delay; sustained success grows
 * it again.
 */
@Injectable()
export class BackfillRunnerService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private readonly workerId = randomUUID();

  constructor(
    @Inject(ConnectorService) private readonly connectors: ConnectorService,
    @Inject(BackfillService) private readonly jobs: BackfillService,
  ) {}

  /** Operator action: works one running job now, for at most `maxMs`. */
  public async runJob(orgId: string, id: string, maxMs = DEFAULT_SLICE_MS): Promise<BackfillRunResult> {
    const job = await this.jobs.get(orgId, id);
    if (job.status !== 'running') {
      throw new BackfillConflictError(`Only a running job can be worked; this one is ${job.status}. Start or resume it first.`);
    }
    const claimed = await this.claim('org_id = $2 AND id = $3', [orgId, id], 1);
    if (!claimed.length) return { job_id: id, status: 'busy', chunks_run: 0, pages: 0, enqueued: 0, message: 'Another worker is already running this job' };
    return this.execute(claimed[0], maxMs);
  }

  /** Scheduler entry point: works every running job whose lease is free, one slice each. */
  public async runDue(limit = 3, maxMs = DEFAULT_SLICE_MS): Promise<BackfillRunResult[]> {
    await this.dbService.initialize();
    const claimed = await this.claim('TRUE', [], limit);
    const results: BackfillRunResult[] = [];
    for (const job of claimed) results.push(await this.execute(job, maxMs));
    return results;
  }

  private async claim(condition: string, params: unknown[], limit: number): Promise<ClaimedJob[]> {
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    const result = await this.dbService.db.query<any>(
      `UPDATE integration_backfill_jobs SET lease_owner = $1, lease_expires_at = $${params.length + 3}
       WHERE id IN (
         SELECT id FROM integration_backfill_jobs
         WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
           AND ${condition}
         ORDER BY created_at ASC LIMIT $${params.length + 2}
       ) RETURNING id, org_id`,
      [leaseOwner, ...params, limit, new Date(Date.now() + JOB_LEASE_MS).toISOString()],
    );
    const claimed: ClaimedJob[] = [];
    for (const row of result.rows) claimed.push({ ...(await this.jobs.get(row.org_id, row.id)), leaseOwner });
    return claimed;
  }

  private async execute(job: ClaimedJob, maxMs: number): Promise<BackfillRunResult> {
    const summary: BackfillRunResult = { job_id: job.id, status: 'running', chunks_run: 0, pages: 0, enqueued: 0 };
    const deadline = Date.now() + maxMs;
    try {
      let connector: ConnectorRecord;
      try {
        connector = await this.connectors.getConnector(job.org_id, job.connector_id);
      } catch (error) {
        return { ...summary, status: 'waiting', message: `Connector unavailable: ${this.message(error)}` };
      }
      if (!connector.activatedAt || connector.status === 'paused') {
        return { ...summary, status: 'waiting', message: connector.status === 'paused' ? 'The connector is paused' : 'The connector is not activated' };
      }

      // This worker holds the lease, so a chunk still marked running belongs to a worker that died.
      await this.dbService.db.query(
        `UPDATE integration_backfill_chunks SET status = 'pending', updated_at = CURRENT_TIMESTAMP
         WHERE job_id = $1 AND status = 'running'`, [job.id],
      );

      const limiter = new AdaptiveLimiter({
        maxConcurrency: job.max_concurrency,
        maxRequestsPerMinute: job.max_requests_per_minute,
        initial: { concurrency: job.limiter.concurrency, delayMs: job.limiter.delay_ms, throttleEvents: job.limiter.throttle_events },
      });
      const pacer = new RequestPacer();

      while (true) {
        const state = await this.dbService.db.query<any>(
          `SELECT status FROM integration_backfill_jobs WHERE id = $1 AND lease_owner = $2`, [job.id, job.leaseOwner],
        );
        if (!state.rows.length || state.rows[0].status !== 'running') break;
        await this.dbService.db.query(
          `UPDATE integration_backfill_jobs SET lease_expires_at = $2 WHERE id = $1 AND lease_owner = $3`,
          [job.id, new Date(Date.now() + JOB_LEASE_MS).toISOString(), job.leaseOwner],
        );

        const due = await this.dbService.db.query<ChunkRow>(
          `SELECT id, seq, window_start, window_end, attempts, page_token FROM integration_backfill_chunks
           WHERE job_id = $1 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
           ORDER BY (pages > 0) DESC, seq ASC LIMIT $2`,
          [job.id, limiter.concurrency],
        );
        if (!due.rows.length) {
          const waiting = await this.dbService.db.query<any>(
            `SELECT MIN(next_attempt_at) AS soonest, COUNT(*)::int AS pending FROM integration_backfill_chunks
             WHERE job_id = $1 AND status = 'pending'`, [job.id],
          );
          if (!Number(waiting.rows[0].pending)) break;
          // Everything left is backing off: wait for the earliest retry if it fits this slice.
          const wakeAt = new Date(waiting.rows[0].soonest).getTime();
          if (wakeAt >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(20, wakeAt - Date.now()))));
          continue;
        }

        await this.dbService.db.query(
          `UPDATE integration_backfill_chunks SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`,
          [due.rows.map((row) => row.id)],
        );
        const steps = await Promise.all(due.rows.map((chunk) => this.step(job, connector, chunk, limiter, pacer)));
        summary.chunks_run += due.rows.length;
        for (const step of steps) {
          summary.pages += step.pages;
          summary.enqueued += step.enqueued;
        }
        const snapshot = limiter.snapshot();
        await this.dbService.db.query(
          `UPDATE integration_backfill_jobs SET concurrency = $2, delay_ms = $3, throttle_events = $4
           WHERE id = $1 AND lease_owner = $5`,
          [job.id, snapshot.concurrency, snapshot.delayMs, snapshot.throttleEvents, job.leaseOwner],
        );
        if (steps.some((step) => step.enqueued > 0)) {
          // Best effort: rows are durably queued either way, and a running sync drains them itself.
          await this.connectors.drainIngestionQueue(job.org_id, job.connector_id).catch(() => false);
        }
        if (Date.now() >= deadline) break;
      }
      return { ...summary, ...(await this.finish(job, summary)) };
    } finally {
      await this.dbService.db.query(
        `UPDATE integration_backfill_jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2`,
        [job.id, job.leaseOwner],
      );
    }
  }

  /** Reads and commits ONE page of ONE chunk. Never throws: a failure is recorded on the chunk. */
  private async step(job: ClaimedJob, connector: ConnectorRecord, chunk: ChunkRow, limiter: AdaptiveLimiter, pacer: RequestPacer): Promise<StepResult> {
    await pacer.acquire(limiter.intervalMs);
    let page;
    try {
      page = await this.connectors.fetchBackfillPage(
        connector,
        job.entity_type,
        { from: new Date(chunk.window_start), to: new Date(chunk.window_end) },
        job.query ?? undefined,
        chunk.page_token ?? undefined,
      );
    } catch (error) {
      await this.recordChunkFailure(job, chunk, error, limiter);
      return { pages: 0, enqueued: 0 };
    }

    try {
      const { inserted } = await this.connectors.enqueueBackfillRecords(
        job.org_id, connector, job.entity_type, page.records, job.id,
        async (tx, insertedCount, outcomes) => {
          // Pause keeps the lease, so an in-flight page still commits; cancel or takeover does not.
          const held = await tx.query<any>(
            `SELECT 1 FROM integration_backfill_jobs WHERE id = $1 AND lease_owner = $2 AND status IN ('running', 'paused')`,
            [job.id, job.leaseOwner],
          );
          if (!held.rows.length) throw new LeaseLostError();
          if (outcomes.length) {
            await tx.query(
              `INSERT INTO integration_backfill_records (job_id, org_id, chunk_seq, external_id, record_updated_at, outcome, queue_entry_id)
               SELECT $1, $2, $3, r->>'external_id', (r->>'updated_at')::timestamptz, r->>'outcome', NULLIF(r->>'queue_entry_id', '')::uuid
               FROM jsonb_array_elements($4::jsonb) AS r`,
              [job.id, job.org_id, chunk.seq, JSON.stringify(outcomes.map((outcome) => ({
                external_id: outcome.externalId,
                updated_at: outcome.updatedAt,
                outcome: outcome.outcome,
                queue_entry_id: outcome.queueEntryId ?? '',
              })))],
            );
          }
          await tx.query(
            `UPDATE integration_backfill_chunks
             SET status = $2, page_token = $3, pages = pages + 1, fetched = fetched + $4,
                 enqueued = enqueued + $5, duplicates = duplicates + $6,
                 attempts = 0, last_error = NULL, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [chunk.id, page.nextPageToken ? 'pending' : 'done', page.nextPageToken ?? null, page.records.length, insertedCount, outcomes.length - insertedCount],
          );
        },
      );
      limiter.onSuccess();
      return { pages: 1, enqueued: inserted };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Stopped or taken over mid-page: nothing was committed, so the chunk resumes from its saved token.
        await this.dbService.db.query(`UPDATE integration_backfill_chunks SET status = 'pending' WHERE id = $1 AND status = 'running'`, [chunk.id]);
        return { pages: 0, enqueued: 0 };
      }
      await this.recordChunkFailure(job, chunk, error, limiter);
      return { pages: 0, enqueued: 0 };
    }
  }

  /**
   * Transient provider failures (throttling, outages, timeouts) shrink the limiter and retry the
   * chunk with backoff, honouring Retry-After; anything else, or too many attempts, fails just that
   * chunk so the rest of the job carries on.
   */
  private async recordChunkFailure(job: ClaimedJob, chunk: ChunkRow, error: unknown, limiter: AdaptiveLimiter): Promise<void> {
    const message = this.message(error).slice(0, 500);
    if (error instanceof ConnectorLoadShedError) {
      // Refused before any request (US16.2): wait out the window without spending an attempt or
      // shrinking the limiter, since the target never answered this chunk.
      await this.dbService.db.query(
        `UPDATE integration_backfill_chunks
         SET status = 'pending', last_error = $2, next_attempt_at = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [chunk.id, `Deferred: ${message}`.slice(0, 500), error.until.toISOString()],
      );
      return;
    }
    const transient = error instanceof ConnectorRemoteError && error.retryable;
    const attempts = chunk.attempts + 1;
    if (transient) limiter.onThrottle((error as ConnectorRemoteError).retryAfterSeconds);
    const giveUp = !transient || attempts >= MAX_CHUNK_ATTEMPTS;
    const retryAfterMs = transient ? ((error as ConnectorRemoteError).retryAfterSeconds ?? 0) * 1000 : 0;
    const backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs, 500 * 2 ** (attempts - 1)));
    await this.dbService.db.query(
      `UPDATE integration_backfill_chunks
       SET status = $2, attempts = $3, last_error = $4, next_attempt_at = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [chunk.id, giveUp ? 'failed' : 'pending', attempts, message, giveUp ? null : new Date(Date.now() + backoffMs).toISOString()],
    );
  }

  /** Marks the job finished once no chunk is pending or running. Otherwise it stays running for the next slice. */
  private async finish(job: ClaimedJob, summary: BackfillRunResult): Promise<Pick<BackfillRunResult, 'status' | 'message'>> {
    const counts = await this.jobs.counts(job.org_id, job.id);
    const current = await this.dbService.db.query<any>(`SELECT status FROM integration_backfill_jobs WHERE id = $1`, [job.id]);
    const status = current.rows[0]?.status;
    if (status !== 'running') return { status };
    if (counts.chunks.pending > 0 || counts.chunks.running > 0) return { status: 'running' };

    const final = counts.chunks.failed > 0 ? 'completed_with_errors' : 'completed';
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      const done = await tx.query<any>(
        `UPDATE integration_backfill_jobs
         SET status = $2, finished_at = CURRENT_TIMESTAMP,
             last_error = CASE WHEN $2 = 'completed_with_errors' THEN $3 ELSE NULL END
         WHERE id = $1 AND lease_owner = $4 AND status = 'running' RETURNING id`,
        [job.id, final, `${counts.chunks.failed} chunk(s) failed; review them and retry`, job.leaseOwner],
      );
      if (!done.rows.length) return;
      event = await this.outbox.enqueue(tx, {
        event_type: 'BackfillJobCompleted',
        work_item_id: job.id,
        org_id: job.org_id,
        actor: { type: 'system', id: 'backfill-runner' },
        payload: { job_id: job.id, connector_id: job.connector_id, name: job.name, status: final, counts },
      });
    });
    if (event) await this.outbox.dispatch(event);
    return { status: final, message: final === 'completed' ? undefined : `${counts.chunks.failed} chunk(s) failed` };
  }

  private message(error: unknown): string {
    const response = (error as any)?.getResponse?.();
    if (response) return typeof response === 'string' ? response : String(response?.message || (error as Error).message);
    return (error as Error)?.message || 'Backfill step failed';
  }
}
