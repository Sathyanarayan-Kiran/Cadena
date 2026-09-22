import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Transaction } from '@electric-sql/pglite';
import { DatabaseService } from '../../database/database.service';
import { DomainEventEnvelope, InProcessEventBus } from './event-bus';
import { appendAuditIntegrityEntry } from '../audit/audit-integrity';

export interface OutboxEventInput {
  event_type: string;
  work_item_id: string;
  org_id: string;
  actor: DomainEventEnvelope['actor'];
  payload: Record<string, any>;
  schema_version?: number;
  event_id?: string;
  timestamp?: string;
}

/**
 * Transactional outbox for canonical work-item mutations (US5.1).
 *
 * The business write, immutable `domain_events` row and pending outbox marker are inserted
 * through the same PGlite transaction supplied by the caller. Publication happens only after
 * commit. A process that stops in that gap leaves a pending row which is delivered on the next
 * application bootstrap with the original event id; US5.2 then makes redelivery harmless.
 */
@Injectable()
export class EventOutboxService implements OnApplicationBootstrap {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();

  public async onApplicationBootstrap(): Promise<void> {
    await this.recoverPending();
  }

  public async enqueue(tx: Transaction, input: OutboxEventInput): Promise<DomainEventEnvelope> {
    const event: DomainEventEnvelope = {
      event_id: input.event_id || randomUUID(),
      event_type: input.event_type,
      schema_version: input.schema_version || 1,
      timestamp: input.timestamp || new Date().toISOString(),
      actor: input.actor,
      work_item_id: input.work_item_id,
      payload: input.payload,
    };

    await tx.query(
      `INSERT INTO domain_events
       (event_id, org_id, event_type, schema_version, work_item_id, actor_type, actor_id, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.event_id,
        input.org_id,
        event.event_type,
        event.schema_version,
        event.work_item_id,
        event.actor.type,
        event.actor.id,
        JSON.stringify(event.payload || {}),
        event.timestamp,
      ],
    );
    await appendAuditIntegrityEntry(tx, {
      source: 'domain_events',
      event_id: event.event_id,
      org_id: input.org_id,
      work_item_id: event.work_item_id,
      event_type: event.event_type,
      actor_type: event.actor.type,
      actor_id: event.actor.id,
      payload: event.payload || {},
      occurred_at: event.timestamp,
    });
    await tx.query(
      `INSERT INTO event_outbox (event_id, status, attempts, created_at)
       VALUES ($1, 'pending', 0, $2)`,
      [event.event_id, event.timestamp],
    );
    return event;
  }

  /**
   * Publishes one committed event and settles its outbox marker. Publication failures cannot
   * undo an already committed mutation; the row deliberately remains pending for recovery.
   */
  public async dispatch(event: DomainEventEnvelope): Promise<boolean> {
    await this.dbService.initialize();
    try {
      await this.eventBus.publishEnvelope(event);
      await this.dbService.db.query(
        `UPDATE event_outbox
         SET status = 'dispatched', attempts = attempts + 1,
             last_error = NULL, last_attempt_at = CURRENT_TIMESTAMP,
             dispatched_at = CURRENT_TIMESTAMP
         WHERE event_id = $1`,
        [event.event_id],
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.dbService.db.query(
        `UPDATE event_outbox
         SET status = 'pending', attempts = attempts + 1,
             last_error = $2, last_attempt_at = CURRENT_TIMESTAMP
         WHERE event_id = $1`,
        [event.event_id, message],
      );
      console.error(`Outbox dispatch failed for ${event.event_type} (${event.event_id}):`, error);
      return false;
    }
  }

  /** Delivers committed rows left pending by a stopped process. */
  public async recoverPending(limit = 1000): Promise<number> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT event.event_id, event.event_type, event.schema_version, event.work_item_id,
              event.actor_type, event.actor_id, event.payload, event.occurred_at
       FROM event_outbox outbox
       JOIN domain_events event ON event.event_id = outbox.event_id
       WHERE outbox.status = 'pending'
       ORDER BY outbox.created_at ASC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 10000)],
    );

    let dispatched = 0;
    for (const row of result.rows || []) {
      if (await this.dispatch(this.mapEnvelope(row))) dispatched += 1;
    }
    return dispatched;
  }

  private mapEnvelope(row: any): DomainEventEnvelope {
    return {
      event_id: row.event_id,
      event_type: row.event_type,
      schema_version: Number(row.schema_version),
      timestamp: typeof row.occurred_at === 'string'
        ? row.occurred_at
        : new Date(row.occurred_at).toISOString(),
      actor: { type: row.actor_type, id: row.actor_id },
      work_item_id: row.work_item_id,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}),
    };
  }
}
