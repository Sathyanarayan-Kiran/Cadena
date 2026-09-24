/**
 * Adaptive throttling for a backfill job (US17.4).
 *
 * The limiter is AIMD, as TCP congestion control is: it grows concurrency slowly while the
 * provider keeps answering, and cuts it sharply the moment the provider signals overload. A backfill
 * is exactly the workload that can hurt a shared production system, so it must back off faster
 * than it speeds up, and it must honour an explicit `Retry-After`.
 *
 * Everything here is pure and clock-free so its behaviour can be tested exactly.
 */

/** Successes required before concurrency grows by one and the extra delay halves. */
export const SUCCESSES_PER_INCREASE = 3;
export const THROTTLE_BASE_DELAY_MS = 250;
export const MAX_DELAY_MS = 60_000;

export interface LimiterState {
  concurrency: number;
  delayMs: number;
  throttleEvents: number;
}

export interface LimiterOptions {
  maxConcurrency: number;
  /** Hard ceiling on request starts per minute, applied on top of any adaptive delay. */
  maxRequestsPerMinute: number;
  initial?: Partial<LimiterState>;
}

export class AdaptiveLimiter {
  private concurrencyNow: number;
  private delay: number;
  private throttles: number;
  private streak = 0;
  private readonly maxConcurrency: number;
  private readonly floorIntervalMs: number;

  constructor(options: LimiterOptions) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency);
    this.floorIntervalMs = Math.ceil(60_000 / Math.max(1, options.maxRequestsPerMinute));
    this.concurrencyNow = Math.min(this.maxConcurrency, Math.max(1, options.initial?.concurrency ?? 1));
    this.delay = Math.min(MAX_DELAY_MS, Math.max(0, options.initial?.delayMs ?? 0));
    this.throttles = options.initial?.throttleEvents ?? 0;
  }

  /** A page came back fine: after a run of successes, run one more chunk at once and relax the delay. */
  public onSuccess(): void {
    this.streak += 1;
    if (this.streak < SUCCESSES_PER_INCREASE) return;
    this.streak = 0;
    this.concurrencyNow = Math.min(this.maxConcurrency, this.concurrencyNow + 1);
    this.delay = this.delay <= THROTTLE_BASE_DELAY_MS / 2 ? 0 : Math.floor(this.delay / 2);
  }

  /** The provider throttled or failed transiently: halve concurrency and back off, honouring Retry-After. */
  public onThrottle(retryAfterSeconds?: number): void {
    this.throttles += 1;
    this.streak = 0;
    this.concurrencyNow = Math.max(1, Math.floor(this.concurrencyNow / 2));
    const requested = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
    this.delay = Math.min(MAX_DELAY_MS, Math.max(requested, this.delay > 0 ? this.delay * 2 : THROTTLE_BASE_DELAY_MS));
  }

  /** Minimum spacing between request starts: the larger of the adaptive delay and the per-minute ceiling. */
  public get intervalMs(): number {
    return Math.max(this.delay, this.floorIntervalMs);
  }

  public get concurrency(): number {
    return this.concurrencyNow;
  }

  public snapshot(): LimiterState {
    return { concurrency: this.concurrencyNow, delayMs: this.delay, throttleEvents: this.throttles };
  }
}

/**
 * Spaces request starts by reserving time slots, so several concurrent workers share one rate
 * limit instead of each applying it separately. `now` and `sleep` are injectable for tests.
 */
export class RequestPacer {
  private nextSlot = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Waits until this caller's slot, then returns. Slots are `intervalMs` apart. */
  public async acquire(intervalMs: number): Promise<void> {
    const current = this.now();
    const slot = Math.max(current, this.nextSlot);
    this.nextSlot = slot + intervalMs;
    if (slot > current) await this.sleep(slot - current);
  }
}
