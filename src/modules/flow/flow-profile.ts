import type { SlaCalendar } from '../sla/sla-calculator.service';
import type { WaitReason } from './wait-reason';

/**
 * Pure flow calculations (US21.1): no database, no clock. Everything here is derived from recorded
 * state-change events, so a profile can be recomputed at any time and never depends on manual entry.
 */

export type FlowClass = 'active' | 'waiting' | 'blocked';
export type FlowBucket = FlowClass | 'unclassified';
export const FLOW_BUCKETS: FlowBucket[] = ['active', 'waiting', 'blocked', 'unclassified'];

export interface StateChange {
  at: Date;
  from: string | null;
  to: string;
  /** The reason supplied with the transition that entered `to`, if any. */
  reason?: WaitReason | null;
}

export interface StateInterval {
  state: string;
  start: Date;
  end: Date;
  /** True for the interval still running at `now`; it grows until the item changes state. */
  open: boolean;
  /** The reason recorded on the transition that entered this state. */
  reason?: WaitReason | null;
}

export interface BuiltHistory {
  intervals: StateInterval[];
  /** Events whose `from` state did not match the state the item was in, or that predate creation. */
  anomalies: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Splits an item's life into state intervals. The first state is the first event's `from` (falling back to
 * the current state for an item that never moved). Time spent in a terminal state is dropped: a closed item
 * is not waiting. An event that contradicts the previous state is counted as an anomaly, never repaired.
 */
export function buildIntervals(input: {
  createdAt: Date;
  currentState: string;
  events: StateChange[];
  now: Date;
  terminalStates?: ReadonlySet<string>;
}): BuiltHistory {
  const terminal = input.terminalStates ?? new Set<string>();
  const events = input.events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at.getTime() - b.event.at.getTime() || a.index - b.index)
    .map(({ event }) => event);

  const intervals: StateInterval[] = [];
  let anomalies = 0;
  let cursor = input.createdAt;
  let state = events[0]?.from ?? input.currentState;
  let entryReason: WaitReason | null = null;

  const close = (end: Date, open: boolean) => {
    if (end.getTime() > cursor.getTime() && !terminal.has(state)) intervals.push({ state, start: cursor, end, open, reason: entryReason });
  };

  for (const event of events) {
    if (event.from !== null && event.from !== state) anomalies += 1;
    if (event.at.getTime() < cursor.getTime()) {
      // Predates creation (or a prior event): the state change still counts, with no time in the earlier state.
      anomalies += 1;
      state = event.to;
      entryReason = event.reason ?? null;
      continue;
    }
    close(event.at, false);
    cursor = event.at;
    state = event.to;
    entryReason = event.reason ?? null;
  }
  close(input.now, true);
  return { intervals, anomalies };
}

/** Restricts intervals to [from, to); intervals wholly outside disappear. */
export function clipIntervals(intervals: StateInterval[], from: Date | null, to: Date | null): StateInterval[] {
  const out: StateInterval[] = [];
  for (const interval of intervals) {
    const start = from && from.getTime() > interval.start.getTime() ? from : interval.start;
    const clippedEnd = to && to.getTime() < interval.end.getTime();
    const end = clippedEnd ? to! : interval.end;
    if (end.getTime() > start.getTime()) out.push({ ...interval, start, end, open: interval.open && !clippedEnd });
  }
  return out;
}

/**
 * Milliseconds of business time inside [start, end). `5x8` is Monday to Friday, 09:00 to 17:00 UTC, exactly
 * the calendar `SlaCalculatorService` applies (a test holds the two equal); `24x7` is wall-clock time.
 * Walks days rather than minutes, so a year-long interval costs about 365 steps.
 */
export function businessMs(start: Date, end: Date, calendar: SlaCalendar): number {
  const from = start.getTime();
  const to = end.getTime();
  if (to <= from) return 0;
  if (calendar === '24x7') return to - from;

  let total = 0;
  for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < to; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const opens = Math.max(day + 9 * 3_600_000, from);
    const closes = Math.min(day + 17 * 3_600_000, to);
    if (closes > opens) total += closes - opens;
  }
  return total;
}

export interface FlowTotals {
  active_minutes: number;
  waiting_minutes: number;
  blocked_minutes: number;
  unclassified_minutes: number;
  elapsed_minutes: number;
  /** Active time as a share of total elapsed time; null when nothing has elapsed. Unclassified time counts as elapsed. */
  flow_efficiency: number | null;
  /** Unclassified time as a share of elapsed, so a low efficiency caused by missing classification is visible. */
  unclassified_share: number | null;
}

export type BucketMs = Record<FlowBucket, number>;

export const emptyBucketMs = (): BucketMs => ({ active: 0, waiting: 0, blocked: 0, unclassified: 0 });

const minutes = (ms: number) => Math.round((ms / MINUTE_MS) * 100) / 100;
const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

export function totalsFrom(ms: BucketMs): FlowTotals {
  const elapsed = ms.active + ms.waiting + ms.blocked + ms.unclassified;
  return {
    active_minutes: minutes(ms.active),
    waiting_minutes: minutes(ms.waiting),
    blocked_minutes: minutes(ms.blocked),
    unclassified_minutes: minutes(ms.unclassified),
    elapsed_minutes: minutes(elapsed),
    flow_efficiency: ratio(ms.active, elapsed),
    unclassified_share: ratio(ms.unclassified, elapsed),
  };
}

export function addBucketMs(target: BucketMs, source: BucketMs): void {
  for (const bucket of FLOW_BUCKETS) target[bucket] += source[bucket];
}

export { minutes as toMinutes };
