import { NativeQueryLanguage, NativeQueryValidation } from '../native-query/native-query.types';

export type BackfillJobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'completed_with_errors' | 'cancelled';
export type BackfillChunkStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BackfillCounts {
  chunks: { total: number; pending: number; running: number; done: number; failed: number };
  /** Read from the provider: every record a page returned, including ones already known. */
  records: { fetched: number; enqueued: number; duplicates: number };
  /**
   * The state of this job's rows in the durable ingestion queue, so it matches what actually
   * happened to them: `queued` are waiting or in retry, `processed` became twins, `failed` are
   * dead-lettered and need operator review.
   */
  queue: { queued: number; processed: number; failed: number };
}

export interface BackfillJob {
  id: string;
  org_id: string;
  connector_id: string;
  name: string;
  entity_type: string;
  language: NativeQueryLanguage | null;
  query: string | null;
  from: string;
  to: string;
  chunk_seconds: number;
  status: BackfillJobStatus;
  max_concurrency: number;
  max_requests_per_minute: number;
  /** Current adaptive state: how many chunks run at once and the extra delay between requests. */
  limiter: { concurrency: number; delay_ms: number; throttle_events: number };
  last_error: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  counts?: BackfillCounts;
}

export interface BackfillChunk {
  seq: number;
  window_start: string;
  window_end: string;
  status: BackfillChunkStatus;
  attempts: number;
  pages: number;
  fetched: number;
  enqueued: number;
  duplicates: number;
  last_error: string | null;
}

export interface CreateBackfillJobDto {
  name: string;
  connector_id: string;
  entity_type: string;
  /** Inclusive start of the historical range (ISO-8601). */
  from: string;
  /** Exclusive end of the range (ISO-8601). Defaults to now. */
  to?: string;
  /** Window size per chunk, in seconds. Defaults to one day. */
  chunk_seconds?: number;
  /** Optional JQL / encoded query narrowing the range; validated exactly like a scheduled query. */
  query?: string;
  max_concurrency?: number;
  max_requests_per_minute?: number;
}

export interface BackfillRunResult {
  job_id: string;
  status: BackfillJobStatus | 'waiting' | 'busy';
  chunks_run: number;
  pages: number;
  enqueued: number;
  message?: string;
}

export class InvalidBackfillError extends Error {
  constructor(message: string, public readonly validation?: NativeQueryValidation) {
    super(message);
  }
}
export class BackfillNotFoundError extends Error {}
export class BackfillConflictError extends Error {}
