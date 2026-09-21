import { DatabaseService } from '../../database/database.service';
import { DomainEventEnvelope } from './event-bus';

/**
 * Works out which tenant an event belongs to.
 *
 * The spec §8.2 envelope has no org field, so the tenant travels in the payload, and
 * different event types put it in different places. Anything that stores an event —
 * the event store, the dead-letter queue — needs the same answer, so the logic lives
 * here rather than being reimplemented per consumer with slightly different coverage.
 */
export function orgIdFromPayload(event: DomainEventEnvelope): string | null {
  const payload = (event.payload || {}) as Record<string, any>;
  const candidate = payload.org_id
    ?? payload.work_item?.org_id
    ?? payload.service?.org_id
    ?? payload.result?.org_id;
  return typeof candidate === 'string' ? candidate : null;
}

/**
 * Payload first, then the referenced work item. Without the fallback an event whose
 * payload omits its tenant becomes invisible to every tenant-scoped query, which hides
 * real failures rather than surfacing them.
 */
export async function resolveEventOrgId(event: DomainEventEnvelope): Promise<string | null> {
  const fromPayload = orgIdFromPayload(event);
  if (fromPayload) return fromPayload;

  if (!event.work_item_id || !/^[0-9a-f-]{36}$/i.test(event.work_item_id)) return null;
  const db = DatabaseService.getInstance();
  await db.initialize();
  const result = await db.db.query<any>(
    `SELECT org_id FROM work_items WHERE id = $1`,
    [event.work_item_id],
  );
  return result.rows?.[0]?.org_id ?? null;
}
