import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../src/database/database.service';

/**
 * Proves the datastore survives a restart, which the pilot's headline metrics depend on:
 * a 30-day DORA window means nothing if the database dies with the process.
 *
 * These tests use `createIsolated` so they open and close real directories without
 * touching the process singleton every other suite shares.
 */
describe('Datastore persistence', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cadena-persist-'));
    dirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('defaults to in-memory so nothing inherits a durable database by accident', () => {
    const ephemeral = DatabaseService.createIsolated();
    expect(ephemeral.isPersistent()).toBe(false);
    expect(ephemeral.dataDir).toBeNull();
  });

  it('keeps written work items across a close and reopen', async () => {
    const dir = tempDir();
    const orgId = randomUUID();
    const teamId = randomUUID();
    const itemId = randomUUID();

    const first = DatabaseService.createIsolated(dir);
    expect(first.isPersistent()).toBe(true);
    await first.initialize();
    await first.db.query(
      `INSERT INTO work_items (id, item_key, type, title, status, priority, team_id, org_id)
       VALUES ($1, 'STORY-PERSIST', 'story', 'Survives a restart', 'Proposed', 'P2', $2, $3)`,
      [itemId, teamId, orgId],
    );
    await first.close();

    // A second process opening the same directory must see the committed row.
    const second = DatabaseService.createIsolated(dir);
    await second.initialize();
    const result = await second.db.query<any>(
      `SELECT item_key, title, status FROM work_items WHERE id = $1`,
      [itemId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      item_key: 'STORY-PERSIST',
      title: 'Survives a restart',
      status: 'Proposed',
    });
    await second.close();

    expect(existsSync(dir)).toBe(true);
  });

  it('re-initialises an existing directory without destroying or duplicating anything', async () => {
    const dir = tempDir();
    const orgId = randomUUID();

    const first = DatabaseService.createIsolated(dir);
    await first.initialize();
    await first.db.query(
      `INSERT INTO services (id, org_id, service_key, name)
       VALUES ($1, $2, 'SVC-PERSIST', 'Persistent Service')`,
      [randomUUID(), orgId],
    );
    await first.close();

    // Schema creation is additive (CREATE TABLE IF NOT EXISTS / ALTER ... IF NOT EXISTS),
    // so running it again over a populated directory is a no-op rather than a reset.
    const second = DatabaseService.createIsolated(dir);
    await second.initialize();
    await second.initialize(); // idempotent within a process too

    const services = await second.db.query<any>(
      `SELECT service_key FROM services WHERE org_id = $1`,
      [orgId],
    );
    expect(services.rows).toHaveLength(1);
    expect(services.rows[0].service_key).toBe('SVC-PERSIST');
    await second.close();
  });

  it('retains domain event history, which is what the flow metrics read', async () => {
    const dir = tempDir();
    const orgId = randomUUID();
    const eventId = randomUUID();

    const first = DatabaseService.createIsolated(dir);
    await first.initialize();
    await first.db.query(
      `INSERT INTO domain_events
       (event_id, org_id, event_type, schema_version, work_item_id, actor_type, actor_id, payload, occurred_at)
       VALUES ($1, $2, 'WorkItemStateChanged', 1, $3, 'user', 'tester', $4, $5)`,
      [eventId, orgId, randomUUID(), JSON.stringify({ to_state: 'Done' }), new Date().toISOString()],
    );
    await first.close();

    const second = DatabaseService.createIsolated(dir);
    await second.initialize();
    const events = await second.db.query<any>(
      `SELECT event_type, payload FROM domain_events WHERE event_id = $1`,
      [eventId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].event_type).toBe('WorkItemStateChanged');
    await second.close();
  });

  it('keeps separate directories isolated from one another', async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const orgId = randomUUID();

    const a = DatabaseService.createIsolated(dirA);
    await a.initialize();
    await a.db.query(
      `INSERT INTO work_items (id, item_key, type, title, status, priority, team_id, org_id)
       VALUES ($1, 'STORY-ONLY-A', 'story', 'Only in A', 'Proposed', 'P2', $2, $3)`,
      [randomUUID(), randomUUID(), orgId],
    );
    await a.close();

    const b = DatabaseService.createIsolated(dirB);
    await b.initialize();
    const leaked = await b.db.query<any>(`SELECT id FROM work_items WHERE item_key = 'STORY-ONLY-A'`);
    expect(leaked.rows).toHaveLength(0);
    await b.close();
  });
});
