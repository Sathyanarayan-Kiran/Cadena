import { Injectable, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { DomainEventEnvelope, InProcessEventBus } from './event-bus';
import { resolveEventOrgId } from './tenant-resolution';

export interface StoredEvent {
  event_id: string;
  org_id: string | null;
  event_type: string;
  schema_version: number;
  work_item_id: string | null;
  actor: { type: string; id: string };
  payload: Record<string, unknown>;
  occurred_at: string;
}

export interface EventQuery {
  org_id?: string;
  event_type?: string;
  work_item_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * Durable history for every domain event the platform publishes.
 *
 * `InProcessEventBus` kept events in a memory array that grew forever and died with the
 * process, so nothing downstream could be computed from history. This subscribes to every
 * event and writes it to `domain_events`, which gives the flow metrics (US9.4) a real
 * substrate and gives US5.2 a durable basis for "have I seen this event id before".
 *
 * Boundary: this is durable history, not yet the transactional outbox US5.1 asks for. The
 * write happens immediately after the mutation rather than inside its transaction, so a
 * crash in the gap would still lose an event. Closing that needs the mutation paths to
 * share a transaction with the event insert.
 */
@Injectable()
export class EventStoreService implements OnModuleInit {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();
  private static attached = new WeakSet<InProcessEventBus>();

  onModuleInit(): void {
    this.attach();
  }

  public attach(): void {
    if (EventStoreService.attached.has(this.eventBus)) return;
    EventStoreService.attached.add(this.eventBus);
    this.eventBus.subscribeAll(async (event) => {
      try {
        await this.record(event);
      } catch (error) {
        // Losing history must never break the mutation that produced the event.
        console.error(`Event store write failed for ${event.event_type}:`, error);
      }
    });
  }

  public async record(event: DomainEventEnvelope): Promise<void> {
    await this.dbService.initialize();
    const orgId = await resolveEventOrgId(event);
    await this.dbService.db.query(
      `INSERT INTO domain_events
       (event_id, org_id, event_type, schema_version, work_item_id, actor_type, actor_id, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        orgId,
        event.event_type,
        event.schema_version,
        event.work_item_id || null,
        event.actor.type,
        event.actor.id,
        JSON.stringify(event.payload || {}),
        event.timestamp,
      ],
    );
  }

  public async query(filter: EventQuery): Promise<StoredEvent[]> {
    await this.dbService.initialize();
    const params: any[] = [];
    const where: string[] = [];

    if (filter.org_id) { params.push(filter.org_id); where.push(`org_id = $${params.length}`); }
    if (filter.event_type) { params.push(filter.event_type); where.push(`event_type = $${params.length}`); }
    if (filter.work_item_id) { params.push(filter.work_item_id); where.push(`work_item_id = $${params.length}`); }
    if (filter.from) { params.push(filter.from); where.push(`occurred_at >= $${params.length}`); }
    if (filter.to) { params.push(filter.to); where.push(`occurred_at <= $${params.length}`); }

    params.push(Math.min(Math.max(filter.limit || 200, 1), 1000));
    const sql = `SELECT * FROM domain_events
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY occurred_at DESC LIMIT $${params.length}`;

    const result = await this.dbService.db.query<any>(sql, params);
    return result.rows.map((row) => this.map(row));
  }

  private map(row: any): StoredEvent {
    return {
      event_id: row.event_id,
      org_id: row.org_id,
      event_type: row.event_type,
      schema_version: Number(row.schema_version),
      work_item_id: row.work_item_id,
      actor: { type: row.actor_type, id: row.actor_id },
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}),
      occurred_at: typeof row.occurred_at === 'string' ? row.occurred_at : new Date(row.occurred_at).toISOString(),
    };
  }
}
