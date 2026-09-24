import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BackfillRunnerService } from './backfill-runner.service';
import { BackfillRunResult } from './backfill.types';

const DEFAULT_TICK_MS = 10_000;
const MIN_TICK_MS = 1_000;

/**
 * In-process timer that works running backfill jobs (US17.4), in the same style as the scheduled
 * native-query timer. Extra instances are harmless: each job is claimed with a database lease, so
 * only one worker ever runs a given job. Live provider traffic stays gated by
 * `CADENA_CONNECTOR_LIVE_HTTP`.
 *
 * `CADENA_BACKFILL_SCHEDULER=disabled` turns the timer off (tests and operators can still work a
 * job explicitly), and `CADENA_BACKFILL_TICK_MS` changes the period (minimum one second).
 */
@Injectable()
export class BackfillScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(@Inject(BackfillRunnerService) private readonly runner: BackfillRunnerService) {}

  public onModuleInit(): void {
    if (process.env.CADENA_BACKFILL_SCHEDULER === 'disabled') return;
    const configured = Number(process.env.CADENA_BACKFILL_TICK_MS);
    const period = Number.isFinite(configured) && configured >= MIN_TICK_MS ? configured : DEFAULT_TICK_MS;
    this.timer = setInterval(() => { void this.tick(); }, period);
    this.timer.unref?.();
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Works whatever is running. A tick that overlaps a still-running one is skipped, not queued. */
  public async tick(): Promise<BackfillRunResult[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      return await this.runner.runDue();
    } catch (error) {
      console.error('Backfill scheduler tick failed:', error);
      return [];
    } finally {
      this.ticking = false;
    }
  }
}
