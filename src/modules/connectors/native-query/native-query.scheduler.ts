import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NativeQueryService } from './native-query.service';
import { NativeQueryRunResult } from './native-query.types';

const DEFAULT_TICK_MS = 30_000;
const MIN_TICK_MS = 1_000;

/**
 * In-process timer that runs due native queries (US17.3), in the style of the SLA aging engine.
 *
 * Correctness does not depend on there being exactly one instance: each due query is claimed with
 * a database lease before it runs, so extra instances simply find nothing to claim. Live provider
 * traffic is still gated by the connector transport: with `CADENA_CONNECTOR_LIVE_HTTP` unset a
 * scheduled run can only reach the local sandbox.
 *
 * `CADENA_NATIVE_QUERY_SCHEDULER=disabled` turns the timer off (tests drive `tick()` directly), and
 * `CADENA_NATIVE_QUERY_TICK_MS` changes the polling period (minimum one second).
 */
@Injectable()
export class NativeQueryScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(@Inject(NativeQueryService) private readonly queries: NativeQueryService) {}

  public onModuleInit(): void {
    if (process.env.CADENA_NATIVE_QUERY_SCHEDULER === 'disabled') return;
    const configured = Number(process.env.CADENA_NATIVE_QUERY_TICK_MS);
    const period = Number.isFinite(configured) && configured >= MIN_TICK_MS ? configured : DEFAULT_TICK_MS;
    this.timer = setInterval(() => { void this.tick(); }, period);
    this.timer.unref?.();
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs whatever is due. A tick that overlaps a still-running one is skipped rather than queued. */
  public async tick(): Promise<NativeQueryRunResult[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      return await this.queries.runDue();
    } catch (error) {
      console.error('Native query scheduler tick failed:', error);
      return [];
    } finally {
      this.ticking = false;
    }
  }
}
