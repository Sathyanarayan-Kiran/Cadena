import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { buildIntervals, clipIntervals } from '../src/modules/flow/flow-profile';
import { parseWaitReason } from '../src/modules/flow/wait-reason';

const at = (value: string) => new Date(value);
const HOUR = 3_600_000;

describe('US21.2 — wait reasons: pure parts', () => {
  it('validates a supplied reason and treats absence as no reason', () => {
    expect(parseWaitReason(undefined)).toBeNull();
    expect(parseWaitReason({ category: 'customer', note: '  Awaiting logs ' })).toEqual({ category: 'customer', note: 'Awaiting logs' });
    expect(() => parseWaitReason({ category: 'unattributed' })).toThrow();
    expect(() => parseWaitReason({ category: 'other', note: 'x'.repeat(501) })).toThrow();
    expect(() => parseWaitReason('customer')).toThrow();
  });

  it('carries the reason of the transition that entered a state through building and clipping', () => {
    const built = buildIntervals({
      createdAt: at('2026-09-01T00:00:00Z'),
      currentState: 'Held',
      now: at('2026-09-02T00:00:00Z'),
      events: [
        { at: at('2026-09-01T06:00:00Z'), from: 'Doing', to: 'Held', reason: { category: 'approval', note: null } },
      ],
    });
    expect(built.intervals.map((i) => [i.state, i.reason?.category ?? null])).toEqual([['Doing', null], ['Held', 'approval']]);
    const [clipped] = clipIntervals([built.intervals[1]], at('2026-09-01T12:00:00Z'), null);
    expect(clipped.reason?.category).toBe('approval');
  });
});

describe('US21.2 — wait reasons: reports and attribution', () => {
  let app: INestApplication;
  const orgId = '21200000-0000-0000-0000-000000000001';
  const otherOrg = '21200000-0000-0000-0000-00000000000f';
  const alpha = '21200000-0000-0000-0000-000000000002';
  const beta = '21200000-0000-0000-0000-000000000003';
  const gamma = '21200000-0000-0000-0000-000000000004';
  const foreignTeam = '21200000-0000-0000-0000-0000000000ff';
  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;
  const h = { 'x-org-id': orgId, 'x-actor-id': 'flow-admin' };
  const T0 = at('2026-09-01T00:00:00Z');
  const at$ = (hours: number) => new Date(T0.getTime() + hours * HOUR);
  const range = 'from=2026-08-30T00:00:00Z&to=2026-09-05T00:00:00Z';

  async function item(team: string, created: Date, status: string, org = orgId, type = 'story') {
    const id = randomUUID();
    await db().query(
      `INSERT INTO work_items (id, item_key, type, title, status, priority, team_id, org_id, entered_state_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'medium', $6, $7, $8, $8, $8)`,
      [id, `W-${id.slice(0, 6)}`, type, `Item ${id.slice(0, 4)}`, status, team, org, created.toISOString()],
    );
    return id;
  }
  async function move(id: string, from: string, to: string, when: Date, reason?: { category: string; note?: string }) {
    await db().query(
      `INSERT INTO audit_events (id, event_type, work_item_id, actor_type, actor_id, payload, timestamp)
       VALUES ($1, 'WorkItemStateChanged', $2, 'user', 'tester', $3, $4)`,
      [randomUUID(), id, JSON.stringify({ from_state: from, to_state: to, ...(reason ? { wait_reason: reason } : {}) }), when.toISOString()],
    );
  }
  async function link(source: string, target: string, type: string, created: Date) {
    await db().query(
      `INSERT INTO work_item_links (id, source_id, target_id, link_type, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), source, target, type, created.toISOString()],
    );
  }
  const classify = (states: unknown[], team?: string) =>
    request(server()).put('/metrics/flow-classifications').set(h).send({ team_id: team, states });
  const reasons = (query = range) => request(server()).get(`/metrics/wait-reasons?${query}`).set(h);
  const drill = (query: string) => request(server()).get(`/metrics/wait-reasons/intervals?${range}&${query}`).set(h);

  let blk: string;
  let blk3: string;
  let w4: string;
  let w6: string;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    for (const id of [orgId, otherOrg]) await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Wait org') ON CONFLICT DO NOTHING`, [id]);
    for (const [id, name, org] of [[alpha, 'Alpha', orgId], [beta, 'Beta', orgId], [gamma, 'Gamma', orgId], [foreignTeam, 'Foreign', otherOrg]]) {
      await db().query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, org, name]);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await classify([
      { state: 'Doing', classification: 'active' },
      { state: 'Waiting for customer', classification: 'waiting', default_reason: 'customer' },
      { state: 'On Hold', classification: 'blocked' },
      { state: 'Blocked', classification: 'blocked' },
    ]);

    // Blockers: BLK stays open in beta; BLK3 is a second open blocker; BLK2 closed a day before any wait began.
    blk = await item(beta, at$(-5), 'Doing');
    blk3 = await item(alpha, at$(-5), 'Doing');
    const blk2 = await item(beta, at$(-48), 'Closed');
    await move(blk2, 'Doing', 'Closed', at$(-24));
    const foreign = await item(foreignTeam, at$(-5), 'Doing', otherOrg);

    // W1: 24h waiting for the customer, reason from the state's default.
    const w1 = await item(alpha, T0, 'Closed');
    await move(w1, 'Doing', 'Waiting for customer', at$(10));
    await move(w1, 'Waiting for customer', 'Closed', at$(34));
    // W2: 12h on hold, reason chosen on the transition.
    const w2 = await item(beta, T0, 'Closed');
    await move(w2, 'Doing', 'On Hold', at$(0.001), { category: 'capacity', note: 'No one free this sprint' });
    await move(w2, 'On Hold', 'Closed', at$(12));
    // W3: 6h on hold, nothing to explain it.
    const w3 = await item(alpha, T0, 'Closed');
    await move(w3, 'Doing', 'On Hold', at$(0.001));
    await move(w3, 'On Hold', 'Closed', at$(6));
    // W4: 8h on hold behind BLK (blocked_by), no explicit reason.
    w4 = await item(gamma, T0, 'Closed');
    await move(w4, 'Doing', 'On Hold', at$(0.001));
    await move(w4, 'On Hold', 'Closed', at$(8));
    await link(w4, blk, 'blocked_by', at$(-1));
    // W5: 4h on hold; its only link is to a blocker that had already closed.
    const w5 = await item(alpha, T0, 'Closed');
    await move(w5, 'Doing', 'On Hold', at$(0.001));
    await move(w5, 'On Hold', 'Closed', at$(4));
    await link(w5, blk2, 'blocked_by', at$(-30));
    // W6: 2h on hold with an explicit reason AND a link (BLK blocks W6): the reason wins, the blocker is still named.
    w6 = await item(alpha, T0, 'Closed');
    await move(w6, 'Doing', 'On Hold', at$(0.001), { category: 'approval' });
    await move(w6, 'On Hold', 'Closed', at$(2));
    await link(blk, w6, 'blocks', at$(-1));
    // W7: 1h on hold, caused_by BLK.
    const w7 = await item(alpha, T0, 'Closed');
    await move(w7, 'Doing', 'On Hold', at$(0.001));
    await move(w7, 'On Hold', 'Closed', at$(1));
    await link(w7, blk, 'caused_by', at$(-1));
    // W8: 1.5h on hold with two live blockers; the first-created link is used and the ambiguity flagged.
    const w8 = await item(alpha, T0, 'Closed');
    await move(w8, 'Doing', 'On Hold', at$(0.001));
    await move(w8, 'On Hold', 'Closed', at$(1.5));
    await link(w8, blk, 'blocked_by', at$(-3));
    await link(w8, blk3, 'blocked_by', at$(-2));
    // W9: 1h on hold linked to an item of another tenant, which must never be attributed.
    const w9 = await item(alpha, T0, 'Closed');
    await move(w9, 'Doing', 'On Hold', at$(0.001));
    await move(w9, 'On Hold', 'Closed', at$(1));
    await link(w9, foreign, 'blocked_by', at$(-1));
    // Triage is unclassified: its time must not appear as a wait.
    const w10 = await item(alpha, T0, 'Closed');
    await move(w10, 'Triage', 'Closed', at$(5));
  });

  afterAll(async () => {
    await app?.close();
  });

  // Each "On Hold" item enters the state 0.001h (3.6s) after creation; the ~0 minute Doing sliver is active, not a wait.
  const holdMinutes = (hours: number) => Math.round((hours - 0.001) * 60 * 100) / 100;

  it('groups waiting time by reason with shares, and labels a missing reason unattributed', async () => {
    const res = await reasons();
    expect(res.status).toBe(200);
    const byReason = Object.fromEntries(res.body.by_reason.map((row: any) => [row.reason, row]));
    expect(byReason.customer.minutes).toBe(1440);
    expect(byReason.capacity.minutes).toBe(holdMinutes(12));
    expect(byReason.approval.minutes).toBe(holdMinutes(2));
    expect(byReason.dependency.minutes).toBeCloseTo(holdMinutes(8) + holdMinutes(1) + holdMinutes(1.5), 1);
    // W3 (nothing), W5 (blocker already closed) and W9 (foreign blocker) are all honestly unattributed.
    expect(byReason.unattributed.minutes).toBeCloseTo(holdMinutes(6) + holdMinutes(4) + holdMinutes(1), 1);
    expect(byReason.unattributed.items).toBe(3);
    const shares = res.body.by_reason.reduce((sum: number, row: any) => sum + row.share, 0);
    expect(shares).toBeGreaterThan(0.999);
    expect(shares).toBeLessThan(1.001);
    expect(res.body.unattributed_share).toBeCloseTo(byReason.unattributed.minutes / res.body.total_wait_minutes, 3);
    // Triage is unclassified: excluded from waits and reported as excluded.
    expect(res.body.excluded_unclassified_minutes).toBeGreaterThanOrEqual(300);
    expect(res.body.by_reason.map((row: any) => row.reason)).not.toContain('other');
  });

  it('attributes a wait to the blocking item and its team, in every link direction, unless the blocker already closed', async () => {
    const res = await reasons();
    const rows = res.body.by_blocking_item;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ blocking_item_id: blk, blocking_team_id: beta, blocking_team_name: 'Beta', items: 4, intervals: 4 });
    expect(rows[0].minutes).toBeCloseTo(holdMinutes(8) + holdMinutes(2) + holdMinutes(1) + holdMinutes(1.5), 1);
    expect(res.body.by_blocking_team[0]).toMatchObject({ blocking_team_id: beta, intervals: 4 });
    expect(res.body.blocked_by_item_minutes).toBeCloseTo(rows[0].minutes, 1);
  });

  it('lets an explicit reason win the category while the blocking item is still named', async () => {
    const res = await drill(`reason=approval`);
    expect(res.body.intervals).toHaveLength(1);
    expect(res.body.intervals[0]).toMatchObject({
      work_item_id: w6, reason: 'approval', reason_source: 'transition', blocking_item: { id: blk, team_id: beta },
    });
    const dependency = await drill('reason=dependency');
    expect(dependency.body.intervals.every((row: any) => row.reason_source === 'blocking_link')).toBe(true);
    const ambiguous = dependency.body.intervals.filter((row: any) => row.ambiguous_blockers === 1);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].blocking_item.id).toBe(blk);
    const explicit = await drill('reason=capacity');
    expect(explicit.body.intervals[0]).toMatchObject({ reason_source: 'transition', note: 'No one free this sprint' });
    const defaulted = await drill('reason=customer');
    expect(defaulted.body.intervals[0]).toMatchObject({ reason_source: 'state_default', state: 'Waiting for customer' });
  });

  it('drills every figure down to intervals that add up to it', async () => {
    const res = await reasons();
    for (const row of res.body.by_reason) {
      const detail = await drill(`reason=${row.reason}`);
      expect(detail.body.total_minutes).toBeCloseTo(row.minutes, 1);
      expect(detail.body.total).toBe(row.intervals);
    }
    const byItem = res.body.by_blocking_item[0];
    const itemDetail = await drill(`blocking_item_id=${byItem.blocking_item_id}`);
    expect(itemDetail.body.total_minutes).toBeCloseTo(byItem.minutes, 1);
    const teamDetail = await drill(`blocking_team_id=${beta}`);
    expect(teamDetail.body.total).toBe(4);
    expect(itemDetail.body.intervals[0]).toMatchObject({ classification: 'blocked', state: 'On Hold' });
    expect((await drill('reason=nonsense')).status).toBe(422);
  });

  it('does not let a report window change how a wait is attributed', async () => {
    const res = await request(server())
      .get(`/metrics/wait-reasons/intervals?from=${at$(2).toISOString()}&to=${at$(6).toISOString()}&reason=dependency`).set(h);
    const w4Row = res.body.intervals.find((row: any) => row.work_item_id === w4);
    expect(w4Row).toMatchObject({ reason: 'dependency', reason_source: 'blocking_link' });
    expect(w4Row.minutes).toBe(240);
  });

  it('shows the reason and blocker on the item\'s own flow profile', async () => {
    const res = await request(server()).get(`/workitems/${w6}/flow-profile`).set(h);
    const hold = res.body.intervals.find((interval: any) => interval.state === 'On Hold');
    expect(hold.wait).toMatchObject({ reason: 'approval', reason_source: 'transition', blocking_item: { id: blk } });
    const active = res.body.intervals.find((interval: any) => interval.state === 'Doing');
    expect(active.wait).toBeUndefined();
  });

  it('versions a state\'s default reason with its classification and rejects an unknown one', async () => {
    const before = (await request(server()).get('/metrics/flow-classifications/history?state=On%20Hold').set(h)).body;
    const unchanged = await classify([{ state: 'On Hold', classification: 'blocked' }]);
    expect(unchanged.body).toMatchObject({ changed: [], unchanged: 1 });

    const set = await classify([{ state: 'On Hold', classification: 'blocked', default_reason: 'third_party' }]);
    expect(set.body.changed[0]).toMatchObject({ default_reason: 'third_party', version: before.length + 1 });
    const events = await db().query<any>(
      `SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'FlowClassificationChanged' AND payload->>'state' = 'On Hold' ORDER BY occurred_at DESC LIMIT 1`,
      [orgId],
    );
    expect(events.rows[0].payload).toMatchObject({ before: { default_reason: null }, after: { default_reason: 'third_party' } });

    // The default now explains the previously unattributed on-hold waits, but never overrides a transition reason or a link.
    const after = await reasons();
    const byReason = Object.fromEntries(after.body.by_reason.map((row: any) => [row.reason, row]));
    expect(byReason.third_party.items).toBe(3);
    expect(byReason.unattributed).toBeUndefined();
    expect(byReason.capacity.items).toBe(1);

    // Omitting default_reason keeps it; null clears it.
    expect((await classify([{ state: 'On Hold', classification: 'blocked' }])).body.changed).toHaveLength(0);
    const cleared = await classify([{ state: 'On Hold', classification: 'blocked', default_reason: null }]);
    expect(cleared.body.changed[0].default_reason).toBeNull();
    expect((await classify([{ state: 'On Hold', classification: 'blocked', default_reason: 'unattributed' }])).status).toBe(422);
  });

  it('captures a reason on a real transition, keeps it on the audit event and rejects an invalid one', async () => {
    const actor = { 'x-org-id': orgId, 'x-actor-id': '00000000-0000-0000-0000-000000000001' };
    const created = await request(server()).post('/workitems').set(actor)
      .send({ type: 'story', title: 'Reason via the API', team_id: alpha, org_id: orgId });
    expect(created.status).toBe(201);
    const id = created.body.id;
    for (const toState of ['Planned', 'In Progress', 'In Review']) {
      expect((await request(server()).post(`/workitems/${id}/transitions`).set(actor).send({ to_state: toState })).status).toBe(201);
    }

    const bad = await request(server()).post(`/workitems/${id}/transitions`).set(actor)
      .send({ to_state: 'Blocked', wait_reason: { category: 'because' } });
    expect(bad.status).toBe(422);
    const stillThere = await db().query<any>(`SELECT status FROM work_items WHERE id = $1`, [id]);
    expect(stillThere.rows[0].status).toBe('In Review');

    const ok = await request(server()).post(`/workitems/${id}/transitions`).set(actor)
      .send({ to_state: 'Blocked', wait_reason: { category: 'third_party', note: 'Vendor patch' } });
    expect(ok.status).toBe(201);
    const audit = await db().query<any>(
      `SELECT payload FROM audit_events WHERE work_item_id = $1 AND payload->>'to_state' = 'Blocked'`, [id],
    );
    expect(audit.rows[0].payload.wait_reason).toEqual({ category: 'third_party', note: 'Vendor patch' });
    const domain = await db().query<any>(
      `SELECT payload FROM domain_events WHERE work_item_id = $1 AND event_type = 'WorkItemStateChanged' ORDER BY occurred_at DESC LIMIT 1`, [id],
    );
    expect(domain.rows[0].payload.wait_reason.category).toBe('third_party');

    const profile = await request(server()).get(`/workitems/${id}/flow-profile`).set(actor);
    const blocked = profile.body.intervals.find((interval: any) => interval.state === 'Blocked');
    expect(blocked.wait).toMatchObject({ reason: 'third_party', reason_source: 'transition', note: 'Vendor patch' });
  });

  it('isolates tenants and validates the range', async () => {
    const foreign = await request(server()).get(`/metrics/wait-reasons?${range}`).set({ 'x-org-id': otherOrg });
    expect(foreign.body).toMatchObject({ total_wait_minutes: 0, by_reason: [], by_blocking_item: [] });
    expect((await request(server()).get('/metrics/wait-reasons?from=x').set(h)).status).toBe(422);
    expect((await request(server()).get(`/metrics/wait-reasons?${range}`)).status).toBe(400);
  });
});
