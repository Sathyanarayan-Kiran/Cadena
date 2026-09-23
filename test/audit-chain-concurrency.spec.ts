import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../src/database/database.service';
import { DatabaseQueryable } from '../src/database/database-adapter';
import { appendAuditIntegrityEntry, calculateAuditHash } from '../src/modules/audit/audit-integrity';

/**
 * Closes the audit-chain single-writer gap recorded against US10.7/US16.4-16.5/US20.2: two API
 * replicas racing to extend the same tenant's chain could both read the same head and each
 * commit an entry pointing at it, silently forking the chain. `appendAuditIntegrityEntry` now
 * relies on a database constraint (`audit_integrity_chain_link`/`_genesis`) that makes a second
 * entry citing an already-taken head impossible, and retries against whichever entry actually
 * won. These tests force the exact race deterministically, since the embedded test database
 * (PGlite) fully serializes its own `transaction()` calls and cannot reproduce it by running two
 * calls concurrently — confirmed empirically: PGlite serializes overlapping `transaction()`
 * bodies statement-by-statement rather than truly interleaving them, and it surfaces the same
 * `23505`/`constraint` shape as `pg` on a unique-violation, so the same fix and the same
 * assertions apply unchanged against pooled managed Postgres.
 *
 * These tests check the link structure directly (previous_hash/event_hash walk, self-consistent
 * against each row's own stored canonical_event) rather than `verifyTenantAuditChain`, which also
 * cross-checks against `domain_events`/`audit_events` rows these synthetic probes never write;
 * that broader tamper-detection path is already covered by `test/us10.7.spec.ts`.
 */
describe('Audit integrity chain — concurrent-writer safety', () => {
  const database = DatabaseService.getInstance();

  const entryInput = (orgId: string, eventId: string) => ({
    source: 'domain_events' as const,
    event_id: eventId,
    org_id: orgId,
    work_item_id: randomUUID(),
    event_type: 'ConcurrencyProbe',
    actor_type: 'system',
    actor_id: 'test-harness',
    payload: { probe: eventId },
    occurred_at: new Date().toISOString(),
  });

  /** Walks the persisted chain for one tenant, failing on any fork or hash inconsistency. */
  async function readVerifiedChain(orgId: string): Promise<{ order: string[]; finalHead: string | null }> {
    const rows = (await database.db.query<any>(
      `SELECT event_id, previous_hash, event_hash, canonical_event
       FROM audit_integrity_entries WHERE org_id = $1 ORDER BY sequence ASC`,
      [orgId],
    )).rows;
    let previous: string | null = null;
    for (const row of rows) {
      expect(row.previous_hash).toBe(previous); // exactly one link to the true prior head; never a fork
      const canonical = typeof row.canonical_event === 'string' ? JSON.parse(row.canonical_event) : row.canonical_event;
      expect(calculateAuditHash(previous, canonical)).toBe(row.event_hash); // hash genuinely derives from that link
      previous = row.event_hash;
    }
    return { order: rows.map((row: any) => row.event_id), finalHead: previous };
  }

  it('makes a forked chain physically impossible at the database level', async () => {
    await database.initialize();
    const orgId = randomUUID();
    const eventA = randomUUID();
    const eventB = randomUUID();
    await appendAuditIntegrityEntry(database.db, entryInput(orgId, eventA));
    await appendAuditIntegrityEntry(database.db, entryInput(orgId, eventB)); // previous_hash = A's hash
    const takenLink = (await database.db.query<any>(
      `SELECT previous_hash FROM audit_integrity_entries WHERE org_id = $1 AND event_id = $2`,
      [orgId, eventB],
    )).rows[0].previous_hash;

    // A second entry cannot also claim A's hash as its previous_hash: that would be a fork.
    await expect(database.db.query(
      `INSERT INTO audit_integrity_entries
       (org_id, source, event_id, work_item_id, event_type, occurred_at, previous_hash, event_hash, canonical_event, proof_version)
       VALUES ($1, 'domain_events', $2, $3, 'ForkAttempt', CURRENT_TIMESTAMP, $4, $5, '{}', 1)`,
      [orgId, randomUUID(), randomUUID(), takenLink, 'a'.repeat(64)],
    )).rejects.toMatchObject({ code: '23505' });

    // Two genesis entries (previous_hash IS NULL) for the same org can never both commit either.
    const freshOrg = randomUUID();
    await database.db.query(
      `INSERT INTO audit_integrity_entries
       (org_id, source, event_id, work_item_id, event_type, occurred_at, previous_hash, event_hash, canonical_event, proof_version)
       VALUES ($1, 'domain_events', $2, $3, 'Genesis', CURRENT_TIMESTAMP, NULL, $4, '{}', 1)`,
      [freshOrg, randomUUID(), randomUUID(), 'b'.repeat(64)],
    );
    await expect(database.db.query(
      `INSERT INTO audit_integrity_entries
       (org_id, source, event_id, work_item_id, event_type, occurred_at, previous_hash, event_hash, canonical_event, proof_version)
       VALUES ($1, 'domain_events', $2, $3, 'SecondGenesis', CURRENT_TIMESTAMP, NULL, $4, '{}', 1)`,
      [freshOrg, randomUUID(), randomUUID(), 'c'.repeat(64)],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('recovers when it loses the race for the current head, relinking to whoever actually won', async () => {
    await database.initialize();
    const orgId = randomUUID();
    const eventA = randomUUID();
    const eventB = randomUUID();
    const eventC = randomUUID();
    await appendAuditIntegrityEntry(database.db, entryInput(orgId, eventA));
    await appendAuditIntegrityEntry(database.db, entryInput(orgId, eventB));
    const staleHead = (await database.db.query<any>( // A's hash: already superseded by B
      `SELECT event_hash FROM audit_integrity_entries WHERE org_id = $1 AND event_id = $2`,
      [orgId, eventA],
    )).rows[0].event_hash;
    const realHead = (await database.db.query<any>( // B's hash: the true current head
      `SELECT event_hash FROM audit_integrity_entries WHERE org_id = $1 AND event_id = $2`,
      [orgId, eventB],
    )).rows[0].event_hash;

    // A wrapped queryable that answers event C's very first head-read with A's now-stale hash,
    // as if C had read the chain before B's commit landed. Every other call reaches the real DB.
    let servedStaleOnce = false;
    const racyQueryable: DatabaseQueryable = {
      query: (sql: string, params?: any[]) => {
        if (!servedStaleOnce && /ORDER BY sequence DESC LIMIT 1/.test(sql)) {
          servedStaleOnce = true;
          return Promise.resolve({ rows: [{ event_hash: staleHead }] });
        }
        return database.db.query(sql, params);
      },
    };

    await appendAuditIntegrityEntry(racyQueryable, entryInput(orgId, eventC));
    expect(servedStaleOnce).toBe(true); // the race was actually exercised, not skipped

    const persisted = (await database.db.query<any>(
      `SELECT previous_hash FROM audit_integrity_entries WHERE org_id = $1 AND event_id = $2`,
      [orgId, eventC],
    )).rows[0];
    expect(persisted.previous_hash).toBe(realHead); // relinked to B's real head...
    expect(persisted.previous_hash).not.toBe(staleHead); // ...not the stale head it first read

    const chain = await readVerifiedChain(orgId);
    expect(chain.order).toEqual([eventA, eventB, eventC]);
  });

  it('fails loudly instead of looping forever or silently duplicating a link when every retry collides', async () => {
    await database.initialize();
    const orgId = randomUUID();
    const eventA = randomUUID();
    const eventB = randomUUID();
    await appendAuditIntegrityEntry(database.db, entryInput(orgId, eventA));
    await appendAuditIntegrityEntry(database.db, entryInput(orgId, eventB));
    const permanentlyTakenLink = (await database.db.query<any>( // A's hash: already claimed by B
      `SELECT event_hash FROM audit_integrity_entries WHERE org_id = $1 AND event_id = $2`,
      [orgId, eventA],
    )).rows[0].event_hash;

    // Every head-read (not just the first) returns the same already-claimed link, so every
    // attempt — including every retry — collides with B's existing row.
    const alwaysStaleQueryable: DatabaseQueryable = {
      query: (sql: string, params?: any[]) => {
        if (/ORDER BY sequence DESC LIMIT 1/.test(sql)) {
          return Promise.resolve({ rows: [{ event_hash: permanentlyTakenLink }] });
        }
        return database.db.query(sql, params);
      },
    };

    const doomedEventId = randomUUID();
    await expect(appendAuditIntegrityEntry(alwaysStaleQueryable, entryInput(orgId, doomedEventId)))
      .rejects.toMatchObject({ code: '23505' });

    // Nothing was left behind: the chain is exactly what it was before the doomed attempt.
    const chain = await readVerifiedChain(orgId);
    expect(chain.order).toEqual([eventA, eventB]);
  });

  it('keeps each tenant chain independently valid under a burst of interleaved appends', async () => {
    await database.initialize();
    const orgs = [randomUUID(), randomUUID(), randomUUID()];
    const perOrgEvents = new Map(orgs.map((orgId) => [orgId, Array.from({ length: 6 }, () => randomUUID())]));

    // Fired without awaiting between them so their DB calls interleave at the JS level, even
    // though the shared PGlite connection ultimately executes them one statement at a time.
    await Promise.all(
      orgs.flatMap((orgId) => perOrgEvents.get(orgId)!.map((eventId) =>
        appendAuditIntegrityEntry(database.db, entryInput(orgId, eventId)))),
    );

    for (const orgId of orgs) {
      const chain = await readVerifiedChain(orgId); // throws/fails on any fork or bad hash
      expect(new Set(chain.order)).toEqual(new Set(perOrgEvents.get(orgId)));
      expect(chain.order).toHaveLength(6);
    }
  });
});
