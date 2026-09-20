import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { DomainEventEnvelope, InProcessEventBus } from './event-bus';

export interface ConsumerDefinition {
  /** Stable name. Idempotency and the dead-letter queue are keyed on it, so it must not drift. */
  name: string;
  eventTypes: string[];
  handle: (event: DomainEventEnvelope) => Promise<void> | void;
  maxAttempts?: number;
  /** Backoff base in ms; attempt n waits n * this. Kept small so the pilot stays responsive. */
  retryDelayMs?: number;
}

export type DispatchOutcome = 'processed' | 'skipped_duplicate' | 'dead_lettered';

export interface DispatchResult {
  consumer: string;
  event_id: string;
  outcome: DispatchOutcome;
  attempts: number;
  error?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Epic 5 — reliable event consumption.
 *
 * Wraps every registered consumer with the three guarantees the backlog asks for:
 *
 *   US5.2  a given event is processed once per consumer; a redelivery is a no-op
 *   US5.3  a handler that keeps failing is retried, then dead-lettered rather than lost
 *   US5.5  a dead-lettered event can be corrected and replayed
 *
 * Consumers stay ordinary async functions. They neither know about retries nor carry their
 * own idempotency, which is what makes this worth having: before it, each consumer either
 * reinvented that logic or quietly swallowed its own failures.
 */
@Injectable()
export class EventConsumerRegistry {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();

  // Static so a controller instantiated outside Nest's container still sees registrations.
  private static consumers = new Map<string, ConsumerDefinition>();
  private static wired = new Map<InProcessEventBus, Set<string>>();

  public register(definition: ConsumerDefinition): void {
    EventConsumerRegistry.consumers.set(definition.name, definition);

    let wiredNames = EventConsumerRegistry.wired.get(this.eventBus);
    if (!wiredNames) {
      wiredNames = new Set();
      EventConsumerRegistry.wired.set(this.eventBus, wiredNames);
    }
    if (wiredNames.has(definition.name)) return;
    wiredNames.add(definition.name);

    for (const eventType of definition.eventTypes) {
      this.eventBus.subscribe(eventType, async (event) => {
        // A consumer failure must never propagate into the publisher's call stack; the
        // dead-letter queue is how failures surface, not a thrown error at the source.
        await this.dispatch(definition.name, event).catch((error) => {
          console.error(`Dispatch to '${definition.name}' failed irrecoverably:`, error);
        });
      });
    }
  }

  public static registered(): string[] {
    return Array.from(EventConsumerRegistry.consumers.keys());
  }

  public static get(name: string): ConsumerDefinition | undefined {
    return EventConsumerRegistry.consumers.get(name);
  }

  /** Clears registrations. Tests only — the registry is process-wide. */
  public static reset(): void {
    EventConsumerRegistry.consumers.clear();
    EventConsumerRegistry.wired = new Map();
  }

  /**
   * Runs one consumer against one event, applying idempotency, retry and dead-lettering.
   * `force` bypasses the duplicate check, which is what a replay needs.
   */
  public async dispatch(
    consumerName: string,
    event: DomainEventEnvelope,
    options: { force?: boolean } = {},
  ): Promise<DispatchResult> {
    await this.dbService.initialize();
    const definition = EventConsumerRegistry.consumers.get(consumerName);
    if (!definition) {
      throw new Error(`No consumer registered under '${consumerName}'`);
    }

    if (!options.force && await this.alreadyProcessed(consumerName, event.event_id)) {
      return { consumer: consumerName, event_id: event.event_id, outcome: 'skipped_duplicate', attempts: 0 };
    }

    const maxAttempts = definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const delay = definition.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await definition.handle(event);
        await this.markProcessed(consumerName, event.event_id, attempt);
        await this.clearDeadLetter(consumerName, event.event_id);
        return { consumer: consumerName, event_id: event.event_id, outcome: 'processed', attempts: attempt };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts) await wait(delay * attempt);
      }
    }

    await this.markFailed(consumerName, event.event_id, maxAttempts);
    await this.deadLetter(consumerName, event, maxAttempts, lastError);
    return {
      consumer: consumerName,
      event_id: event.event_id,
      outcome: 'dead_lettered',
      attempts: maxAttempts,
      error: lastError,
    };
  }

  private async alreadyProcessed(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.dbService.db.query<any>(
      `SELECT status FROM event_consumptions WHERE consumer = $1 AND event_id = $2`,
      [consumer, eventId],
    );
    return result.rows.length > 0 && result.rows[0].status === 'processed';
  }

  private async markProcessed(consumer: string, eventId: string, attempts: number): Promise<void> {
    await this.dbService.db.query(
      `INSERT INTO event_consumptions (consumer, event_id, status, attempts, first_attempt_at, last_attempt_at)
       VALUES ($1, $2, 'processed', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (consumer, event_id) DO UPDATE SET
         status = 'processed', attempts = EXCLUDED.attempts, last_attempt_at = CURRENT_TIMESTAMP`,
      [consumer, eventId, attempts],
    );
  }

  private async markFailed(consumer: string, eventId: string, attempts: number): Promise<void> {
    await this.dbService.db.query(
      `INSERT INTO event_consumptions (consumer, event_id, status, attempts, first_attempt_at, last_attempt_at)
       VALUES ($1, $2, 'failed', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (consumer, event_id) DO UPDATE SET
         status = 'failed', attempts = EXCLUDED.attempts, last_attempt_at = CURRENT_TIMESTAMP`,
      [consumer, eventId, attempts],
    );
  }

  private async clearDeadLetter(consumer: string, eventId: string): Promise<void> {
    await this.dbService.db.query(
      `UPDATE dead_letter_events
       SET status = 'replayed', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE consumer = $1 AND event_id = $2 AND status = 'dead'`,
      [consumer, eventId],
    );
  }

  /**
   * Records the exhausted event and raises a depth alert. US5.3 asks for an alert whenever
   * depth exceeds zero, so every dead-letter emits one carrying the current depth.
   */
  private async deadLetter(
    consumer: string,
    event: DomainEventEnvelope,
    attempts: number,
    error: string,
  ): Promise<void> {
    const orgId = (event.payload as any)?.org_id ?? null;
    await this.dbService.db.query(
      `INSERT INTO dead_letter_events
       (id, consumer, event_id, org_id, event_type, envelope, attempts, last_error, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dead', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (consumer, event_id) DO UPDATE SET
         attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error,
         status = 'dead', resolved_at = NULL, updated_at = CURRENT_TIMESTAMP`,
      [
        randomUUID(), consumer, event.event_id, typeof orgId === 'string' ? orgId : null,
        event.event_type, JSON.stringify(event), attempts, error,
      ],
    );

    const depth = await this.dbService.db.query<any>(
      `SELECT COUNT(*)::int AS n FROM dead_letter_events WHERE consumer = $1 AND status = 'dead'`,
      [consumer],
    );
    const depthValue = depth.rows?.[0]?.n ?? 0;

    await this.eventBus.publish(
      'DeadLetterQueueAlert',
      event.work_item_id,
      { type: 'system', id: 'event-consumer-registry' },
      {
        org_id: typeof orgId === 'string' ? orgId : null,
        consumer,
        depth: depthValue,
        event_id: event.event_id,
        event_type: event.event_type,
        attempts,
        last_error: error,
      },
    );
  }
}
