import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { DomainEventEnvelope } from './event-bus';
import { EventConsumerRegistry } from './consumer-registry.service';

export interface DeadLetterEntry {
  id: string;
  consumer: string;
  event_id: string;
  org_id: string | null;
  event_type: string;
  envelope: DomainEventEnvelope;
  attempts: number;
  last_error: string | null;
  status: 'dead' | 'replayed' | 'discarded';
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export class DeadLetterNotFoundError extends Error {
  constructor(id: string) {
    super(`Dead-letter entry '${id}' not found`);
    this.name = 'DeadLetterNotFoundError';
  }
}

export class InvalidReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReplayError';
  }
}

/**
 * US5.3 and US5.5 — operator surface for the dead-letter queue.
 *
 * Lets an operator see what failed and why, correct a malformed payload inline, and
 * re-inject it without asking the source system to resend. Replay keeps the original
 * `event_id` so the audit trail stays continuous, and re-dispatches only to the consumer
 * that failed rather than replaying the event to everyone.
 */
@Injectable()
export class DeadLetterService {
  private dbService = DatabaseService.getInstance();
  private registry = new EventConsumerRegistry();

  /**
   * The tenant is a required argument rather than an optional filter.
   *
   * It was optional, which meant a caller that simply forgot it received every tenant's
   * failures. That is the same shape as the defect already fixed on `get`, `replay` and
   * `discard`, so the guarantee is made structural here: there is no way to express an
   * unscoped query, and the compiler rejects an attempt to omit it.
   */
  public async list(
    orgId: string,
    filter: { consumer?: string; status?: string; limit?: number } = {},
  ): Promise<DeadLetterEntry[]> {
    await this.dbService.initialize();
    const params: any[] = [orgId];
    const where: string[] = ['org_id = $1'];

    if (filter.consumer) { params.push(filter.consumer); where.push(`consumer = $${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }

    params.push(Math.min(Math.max(filter.limit || 100, 1), 500));
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM dead_letter_events
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => this.map(row));
  }

  /** Depth per consumer for one tenant. US5.3 treats any depth above zero as alertable. */
  public async depth(orgId: string): Promise<{
    total: number;
    by_consumer: Record<string, number>;
    alerting: boolean;
  }> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT consumer, COUNT(*)::int AS n FROM dead_letter_events
       WHERE status = 'dead' AND org_id = $1 GROUP BY consumer`,
      [orgId],
    );

    const byConsumer: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows || []) {
      byConsumer[row.consumer] = row.n;
      total += row.n;
    }
    return { total, by_consumer: byConsumer, alerting: total > 0 };
  }

  /**
   * Tenant-scoped by id. An entry belonging to another tenant reports as not found rather
   * than forbidden, so a caller cannot probe for the existence of other tenants' failures.
   */
  public async get(id: string, orgId: string): Promise<DeadLetterEntry> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM dead_letter_events WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (result.rows.length === 0) throw new DeadLetterNotFoundError(id);
    return this.map(result.rows[0]);
  }

  /**
   * Re-dispatches a dead-lettered event to the consumer that failed on it.
   *
   * `payload` replaces the event's payload so a validation error can be corrected before
   * re-injection. The envelope identity — event id, type, actor, timestamp — is preserved,
   * because a replay is the same event being tried again, not a new one.
   */
  public async replay(id: string, orgId: string, payload?: Record<string, unknown>): Promise<{
    entry: DeadLetterEntry;
    outcome: string;
    attempts: number;
    error?: string;
  }> {
    const entry = await this.get(id, orgId);
    if (entry.status === 'discarded') {
      throw new InvalidReplayError(`Entry '${id}' was discarded and cannot be replayed`);
    }
    if (!EventConsumerRegistry.get(entry.consumer)) {
      throw new InvalidReplayError(
        `Consumer '${entry.consumer}' is not registered in this process, so its events cannot be replayed here`,
      );
    }
    if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
      throw new InvalidReplayError('payload must be a JSON object when supplied');
    }

    const envelope: DomainEventEnvelope = payload
      ? { ...entry.envelope, payload: payload as Record<string, any> }
      : entry.envelope;

    if (payload) {
      await this.dbService.db.query(
        `UPDATE dead_letter_events SET envelope = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(envelope), id],
      );
    }

    // force: the consumption record says 'failed', but an operator asking for a replay is
    // explicitly asking us to try again rather than treat it as already seen.
    const result = await this.registry.dispatch(entry.consumer, envelope, { force: true });

    if (result.outcome === 'processed') {
      await this.dbService.db.query(
        `UPDATE dead_letter_events
         SET status = 'replayed', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, last_error = NULL
         WHERE id = $1`,
        [id],
      );
    } else {
      await this.dbService.db.query(
        `UPDATE dead_letter_events
         SET attempts = $1, last_error = $2, status = 'dead', resolved_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [result.attempts, result.error || 'Replay failed', id],
      );
    }

    return {
      entry: await this.get(id, orgId),
      outcome: result.outcome,
      attempts: result.attempts,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  /** Marks an entry as deliberately abandoned, so it stops counting toward depth. */
  public async discard(id: string, orgId: string, reason?: string): Promise<DeadLetterEntry> {
    const entry = await this.get(id, orgId);
    await this.dbService.db.query(
      `UPDATE dead_letter_events
       SET status = 'discarded', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
           last_error = COALESCE($1, last_error)
       WHERE id = $2`,
      [reason ? `discarded: ${reason}` : null, entry.id],
    );
    return this.get(id, orgId);
  }

  private map(row: any): DeadLetterEntry {
    return {
      id: row.id,
      consumer: row.consumer,
      event_id: row.event_id,
      org_id: row.org_id,
      event_type: row.event_type,
      envelope: typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope,
      attempts: Number(row.attempts),
      last_error: row.last_error,
      status: row.status,
      created_at: this.iso(row.created_at),
      updated_at: this.iso(row.updated_at),
      resolved_at: row.resolved_at ? this.iso(row.resolved_at) : null,
    };
  }

  private iso(value: any): string {
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}
