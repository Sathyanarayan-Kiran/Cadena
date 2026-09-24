import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';
import { WorkflowService } from '../src/modules/workflow/workflow.service';
import { FlowService } from '../src/modules/flow/flow.service';
import { buildIntervals, businessMs, clipIntervals, totalsFrom, emptyBucketMs } from '../src/modules/flow/flow-profile';

const at = (value: string) => new Date(value);
const HOUR = 3_600_000;

describe('US21.1 — flow-profile calculations', () => {
  it('measures business time exactly as the SLA calculator does', () => {
    const calc = new SlaCalculatorService();
    let seed = 42;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 60; i++) {
      const start = new Date(base + Math.floor(rand() * 200 * 24 * 60) * 60_000 + Math.floor(rand() * 60_000));
      const end = new Date(start.getTime() + Math.floor(rand() * 20 * 24 * 60) * 60_000);
      for (const calendar of ['5x8', '24x7'] as const) {
        expect(Math.floor(businessMs(start, end, calendar) / 60_000)).toBe(calc.calculateElapsedMinutes(start, end, calendar));
      }
    }
  });

  it('builds intervals from the first event, drops terminal time and counts contradictions instead of repairing them', () => {
    const built = buildIntervals({
      createdAt: at('2026-09-01T00:00:00Z'),
      currentState: 'Reopened',
      now: at('2026-09-10T00:00:00Z'),
      terminalStates: new Set(['Closed']),
      events: [
        { at: at('2026-09-03T00:00:00Z'), from: 'Ready', to: 'Doing' },
        { at: at('2026-09-04T00:00:00Z'), from: 'Doing', to: 'Closed' },
        { at: at('2026-09-06T00:00:00Z'), from: 'Closed', to: 'Reopened' },
        { at: at('2026-09-07T00:00:00Z'), from: 'Somewhere else', to: 'Reopened' },
      ],
    });
    expect(built.intervals.map((i) => [i.state, i.start.toISOString().slice(0, 10), i.open])).toEqual([
      ['Ready', '2026-09-01', false],
      ['Doing', '2026-09-03', false],
      ['Reopened', '2026-09-06', false],
      ['Reopened', '2026-09-07', true],
    ]);
    expect(built.anomalies).toBe(1);
  });

  it('never treats unclassified time as active and reports it in the efficiency denominator', () => {
    const ms = emptyBucketMs();
    ms.active = 10 * 60_000;
    ms.unclassified = 30 * 60_000;
    const totals = totalsFrom(ms);
    expect(totals.flow_efficiency).toBe(0.25);
    expect(totals.unclassified_share).toBe(0.75);
    expect(totalsFrom(emptyBucketMs()).flow_efficiency).toBeNull();
  });

  it('clips intervals to the window and closes the open flag when the window ends first', () => {
    const [clipped] = clipIntervals(
      [{ state: 'A', start: at('2026-09-01T00:00:00Z'), end: at('2026-09-10T00:00:00Z'), open: true }],
      at('2026-09-02T00:00:00Z'),
      at('2026-09-03T00:00:00Z'),
    );
    expect(clipped.end.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(clipped.open).toBe(false);
  });
});

describe('US21.1 — classification, profile and report', () => {
  let app: INestApplication;
  const orgId = '21100000-0000-0000-0000-000000000001';
  const otherOrg = '21100000-0000-0000-0000-00000000000f';
  const alpha = '21100000-0000-0000-0000-000000000002';
  const beta = '21100000-0000-0000-0000-000000000003';
  const gamma = '21100000-0000-0000-0000-000000000004';
  const otherTeam = '21100000-0000-0000-0000-0000000000ff';
  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;
  const h = { 'x-org-id': orgId, 'x-actor-id': 'flow-admin' };
  const T0 = at('2026-09-01T00:00:00Z');

  async function item(team: string, type: string, status: string, created: Date, extra: { origin?: string } = {}) {
    const id = randomUUID();
    await db().query(
      `INSERT INTO work_items (id, item_key, type, title, status, priority, team_id, org_id, entered_state_at, created_at, updated_at, origin)
       VALUES ($1, $2, $3, $4, $5, 'medium', $6, $7, $8, $8, $8, $9)`,
      [id, `K-${id.slice(0, 6)}`, type, `Item ${id.slice(0, 4)}`, status, team, orgId, created.toISOString(), extra.origin ?? 'local'],
    );
    return id;
  }
  async function move(id: string, from: string, to: string, when: Date) {
    await db().query(
      `INSERT INTO audit_events (id, event_type, work_item_id, actor_type, actor_id, payload, timestamp)
       VALUES ($1, 'WorkItemStateChanged', $2, 'user', 'tester', $3, $4)`,
      [randomUUID(), id, JSON.stringify({ from_state: from, to_state: to }), when.toISOString()],
    );
  }
  const classify = (states: Array<{ state: string; classification: string }>, team?: string) =>
    request(server()).put('/metrics/flow-classifications').set(h).send({ team_id: team, states });
  const profile = (id: string, query = '') => request(server()).get(`/workitems/${id}/flow-profile${query}`).set(h);

  let itemA: string;
  let itemB: string;
  let itemC: string;
  let itemD: string;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    for (const id of [orgId, otherOrg]) await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Flow org') ON CONFLICT DO NOTHING`, [id]);
    for (const [id, name, org] of [[alpha, 'Alpha', orgId], [beta, 'Beta', orgId], [gamma, 'Gamma', orgId], [otherTeam, 'Other', otherOrg]]) {
      await db().query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, org, name]);
    }
    await db().query(
      `INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar) VALUES ($1, $2, 'story', 'Review', 600, '5x8')`,
      [randomUUID(), orgId],
    );

    // A: Ready 24h, Doing 24h, Blocked 12h, Doing 24h, then closed (24x7 default calendar).
    itemA = await item(alpha, 'story', 'Closed', T0);
    await move(itemA, 'Ready', 'Doing', new Date(T0.getTime() + 24 * HOUR));
    await move(itemA, 'Doing', 'Blocked', new Date(T0.getTime() + 48 * HOUR));
    await move(itemA, 'Blocked', 'Doing', new Date(T0.getTime() + 60 * HOUR));
    await move(itemA, 'Doing', 'Closed', new Date(T0.getTime() + 84 * HOUR));
    // B (another team): 10h of a state nobody classified, then closed.
    itemB = await item(beta, 'story', 'Closed', T0);
    await move(itemB, 'Triage', 'Closed', new Date(T0.getTime() + 10 * HOUR));
    // C: waits in a 5x8 state from Friday 15:00 to Monday 11:00, four business hours.
    itemC = await item(gamma, 'story', 'Closed', at('2026-09-04T15:00:00Z'));
    await move(itemC, 'Review', 'Closed', at('2026-09-07T11:00:00Z'));
    // D: a different type, 6h in Doing.
    itemD = await item(alpha, 'incident', 'Closed', T0);
    await move(itemD, 'Doing', 'Closed', new Date(T0.getTime() + 6 * HOUR));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('versions and audits classification changes without touching item history', async () => {
    const auditBefore = (await db().query<any>(`SELECT COUNT(*)::int AS n FROM audit_events WHERE work_item_id = $1`, [itemA])).rows[0].n;

    const first = await classify([
      { state: 'Doing', classification: 'active' },
      { state: 'Ready', classification: 'waiting' },
      { state: 'Blocked', classification: 'blocked' },
      { state: 'Review', classification: 'waiting' },
    ]);
    expect(first.status).toBe(200);
    expect(first.body.changed).toHaveLength(4);
    expect(first.body.changed.every((row: any) => row.version === 1 && row.team_id === null && row.changed_by === 'flow-admin')).toBe(true);

    const repeat = await classify([{ state: 'Doing', classification: 'active' }]);
    expect(repeat.body).toMatchObject({ changed: [], unchanged: 1 });

    const change = await classify([{ state: 'Ready', classification: 'blocked' }]);
    expect(change.body.changed[0]).toMatchObject({ state: 'Ready', classification: 'blocked', version: 2 });

    const history = await request(server()).get('/metrics/flow-classifications/history?state=Ready').set(h);
    expect(history.body.map((row: any) => [row.version, row.classification])).toEqual([[2, 'blocked'], [1, 'waiting']]);

    const events = await db().query<any>(
      `SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'FlowClassificationChanged' AND payload->>'state' = 'Ready' ORDER BY occurred_at`,
      [orgId],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[1].payload).toMatchObject({ before: { classification: 'waiting', version: 1 }, after: { classification: 'blocked', version: 2 } });

    const auditAfter = (await db().query<any>(`SELECT COUNT(*)::int AS n FROM audit_events WHERE work_item_id = $1`, [itemA])).rows[0].n;
    expect(auditAfter).toBe(auditBefore);

    // Put it back so later expectations read naturally.
    await classify([{ state: 'Ready', classification: 'waiting' }]);
  });

  it('rejects malformed classifications, foreign teams and duplicate states', async () => {
    expect((await classify([{ state: 'Doing', classification: 'busy' }])).status).toBe(422);
    expect((await classify([{ state: ' ', classification: 'active' }])).status).toBe(422);
    expect((await classify([])).status).toBe(422);
    expect((await classify([{ state: 'X', classification: 'active' }, { state: 'X', classification: 'waiting' }])).status).toBe(422);
    expect((await classify([{ state: 'Doing', classification: 'active' }], otherTeam)).status).toBe(422);
    expect((await classify([{ state: 'Doing', classification: 'active' }], 'not-a-uuid')).status).toBe(422);
  });

  it('returns worked, waiting and blocked business time and flow efficiency from history', async () => {
    const res = await profile(itemA);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      active_minutes: 2880,
      waiting_minutes: 1440,
      blocked_minutes: 720,
      unclassified_minutes: 0,
      elapsed_minutes: 5040,
      flow_efficiency: 0.5714,
      current_state: 'Closed',
      history_anomalies: 0,
    });
    expect(res.body.intervals.map((i: any) => [i.state, i.classification, i.minutes, i.open])).toEqual([
      ['Ready', 'waiting', 1440, false],
      ['Doing', 'active', 1440, false],
      ['Blocked', 'blocked', 720, false],
      ['Doing', 'active', 1440, false],
    ]);
    expect(res.body.intervals[0].classification_version).toBeGreaterThan(0);
  });

  it('reports unclassified time separately and never assumes it is active', async () => {
    const res = await profile(itemB);
    expect(res.body).toMatchObject({
      active_minutes: 0,
      unclassified_minutes: 600,
      elapsed_minutes: 600,
      flow_efficiency: 0,
      unclassified_share: 1,
      unclassified_states: ['Triage'],
    });
  });

  it('applies a state classification retroactively, and a team override beats the org default', async () => {
    await classify([{ state: 'Triage', classification: 'active' }], beta);
    expect((await profile(itemB)).body).toMatchObject({ active_minutes: 600, unclassified_minutes: 0, flow_efficiency: 1 });
    // Alpha has no override, so the org default (still unclassified for Triage) applies to it.
    const other = await item(alpha, 'story', 'Closed', T0);
    await move(other, 'Triage', 'Closed', new Date(T0.getTime() + 2 * HOUR));
    expect((await profile(other)).body.unclassified_minutes).toBe(120);

    // Clearing the override with an explicit "unclassified" version restores the default lens.
    await classify([{ state: 'Triage', classification: 'unclassified' }], beta);
    expect((await profile(itemB)).body.unclassified_minutes).toBe(600);
    const teamRows = await request(server()).get(`/metrics/flow-classifications?team_id=${beta}`).set(h);
    expect(teamRows.body).toHaveLength(1);
    expect(teamRows.body[0]).toMatchObject({ state: 'Triage', classification: 'unclassified', version: 2 });
  });

  it('uses the state\'s SLA calendar for business time', async () => {
    const res = await profile(itemC);
    expect(res.body.waiting_minutes).toBe(240);
    expect(res.body.intervals[0].calendar).toBe('5x8');
  });

  it('breaks a date range down by team, item type and state, clipped to the window', async () => {
    const full = await request(server())
      .get('/metrics/flow-efficiency?from=2026-08-31T00:00:00Z&to=2026-09-20T00:00:00Z').set(h);
    expect(full.status).toBe(200);
    expect(full.body.by_team.find((t: any) => t.team_id === alpha)).toMatchObject({ team_name: 'Alpha', active_minutes: 2880 + 360 });
    expect(full.body.by_team.find((t: any) => t.team_id === gamma)).toMatchObject({ waiting_minutes: 240 });
    expect(full.body.by_item_type.map((t: any) => t.item_type).sort()).toEqual(['incident', 'story']);
    expect(full.body.by_state.find((s: any) => s.state === 'Blocked')).toMatchObject({ classification: 'blocked', minutes: 720, items: 1 });
    expect(full.body.unclassified_states).toContain('Triage');

    const clipped = await request(server())
      .get(`/metrics/flow-efficiency?from=${new Date(T0.getTime() + 36 * HOUR).toISOString()}&to=${new Date(T0.getTime() + 72 * HOUR).toISOString()}&team_id=${alpha}&item_type=story`)
      .set(h);
    expect(clipped.body).toMatchObject({ active_minutes: 1440, blocked_minutes: 720, waiting_minutes: 0 });
    // Item A only: the extra Alpha story from the retroactivity test was created at T0 and closed at 2h.
    expect(clipped.body.items_with_time).toBe(1);
  });

  it('validates the range and isolates tenants', async () => {
    expect((await request(server()).get('/metrics/flow-efficiency?from=nope').set(h)).status).toBe(422);
    expect((await request(server()).get('/metrics/flow-efficiency?from=2026-09-10&to=2026-09-01').set(h)).status).toBe(422);
    expect((await request(server()).get('/metrics/flow-efficiency')).status).toBe(400);
    const foreign = await request(server()).get(`/workitems/${itemA}/flow-profile`).set({ 'x-org-id': otherOrg });
    expect(foreign.status).toBe(404);
    const foreignReport = await request(server()).get('/metrics/flow-efficiency?from=2026-08-31&to=2026-09-20').set({ 'x-org-id': otherOrg });
    expect(foreignReport.body).toMatchObject({ items_considered: 0, elapsed_minutes: 0, flow_efficiency: null });
  });

  it('keeps an open interval running to "now" and flags it open', async () => {
    const open = await item(alpha, 'story', 'Doing', at('2026-09-10T00:00:00Z'));
    const result = await new FlowService().profile(orgId, open, {}, at('2026-09-10T05:00:00Z'));
    expect(result.active_minutes).toBe(300);
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0].open).toBe(true);
  });

  it('uses the source system\'s own timestamps for connector twins', async () => {
    const twin = await item(alpha, 'story', 'Ready', at('2026-09-12T00:00:00Z'), { origin: 'connector' });
    const workflow = new WorkflowService();
    await workflow.applySourceStateChange({
      workItemId: twin, orgId, toState: 'Doing', at: '2026-09-12T06:00:00.000Z', actorId: 'connector', source: { provider: 'jira' },
    });
    await workflow.applySourceStateChange({
      workItemId: twin, orgId, toState: 'Closed', at: '2026-09-12T09:00:00.000Z', actorId: 'connector', source: { provider: 'jira' },
    });
    const res = await profile(twin);
    expect(res.body.intervals.map((i: any) => [i.state, i.minutes])).toEqual([['Ready', 360], ['Doing', 180]]);
    expect(res.body.active_minutes).toBe(180);
    expect(res.body.waiting_minutes).toBe(360);
  });
});
