const MINUTE_MS = 60_000;

export const MIN_CHUNK_SECONDS = 60;
export const MAX_CHUNK_SECONDS = 31 * 86_400;
export const DEFAULT_CHUNK_SECONDS = 86_400;
/** More chunks than this means the range and window size disagree; the plan asks for a larger window. */
export const MAX_CHUNKS_PER_JOB = 5_000;
/** A backfill reaches further back than a scheduled query's 366 days, but not without limit. */
export const MAX_BACKFILL_SPAN_MS = 10 * 366 * 86_400_000;

export interface PlannedChunk {
  seq: number;
  windowStart: Date;
  windowEnd: Date;
}

export class BackfillPlanError extends Error {}

/** Truncates to a whole minute: JQL datetimes have minute precision, so windows must too. */
export function floorToMinute(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * Splits `[from, to)` into consecutive, non-overlapping half-open windows of `chunkSeconds` (the
 * last one may be shorter). Because the windows partition the range exactly, every record whose
 * last-update time falls inside it lands in exactly one chunk: nothing is read twice and nothing is
 * skipped, which is what lets chunks run in any order, concurrently, and be retried independently.
 */
export function planChunks(from: Date, to: Date, chunkSeconds: number): PlannedChunk[] {
  if (!Number.isInteger(chunkSeconds) || chunkSeconds < MIN_CHUNK_SECONDS || chunkSeconds > MAX_CHUNK_SECONDS) {
    throw new BackfillPlanError(`chunk_seconds must be a whole number between ${MIN_CHUNK_SECONDS} and ${MAX_CHUNK_SECONDS}`);
  }
  if (chunkSeconds % 60 !== 0) throw new BackfillPlanError('chunk_seconds must be a multiple of 60, because provider queries have minute precision');
  const start = floorToMinute(from).getTime();
  const end = floorToMinute(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) throw new BackfillPlanError('from and to must be valid timestamps');
  if (start >= end) throw new BackfillPlanError('from must be earlier than to, at whole-minute precision');
  if (end - start > MAX_BACKFILL_SPAN_MS) throw new BackfillPlanError('The range spans more than 10 years; split it into several jobs');

  const step = chunkSeconds * 1000;
  const count = Math.ceil((end - start) / step);
  if (count > MAX_CHUNKS_PER_JOB) {
    const suggested = Math.ceil((end - start) / MAX_CHUNKS_PER_JOB / 1000 / 60) * 60;
    throw new BackfillPlanError(
      `This range and window size make ${count} chunks; the limit is ${MAX_CHUNKS_PER_JOB}. Use chunk_seconds of at least ${suggested}, or a shorter range.`,
    );
  }
  const chunks: PlannedChunk[] = [];
  for (let seq = 0; seq < count; seq++) {
    const windowStart = start + seq * step;
    chunks.push({ seq, windowStart: new Date(windowStart), windowEnd: new Date(Math.min(windowStart + step, end)) });
  }
  return chunks;
}
