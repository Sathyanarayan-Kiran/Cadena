process.env.CADENA_FLOW_RISK_SCHEDULER = 'disabled';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { CostRule, intervalCost, matchRule, priorityScore, remainingMinutes } from '../src/modules/flow/cost-of-delay';

const HOUR = 3_600_000;

const rule = (over: Partial<CostRule>): CostRule => ({
  id: over.id ?? randomUUID(), team_id: null, item_type: null, priority: null, service_id: null,
  rate_per_day: 100, fixed_value_at_risk: null, label: null, ...over,
});

describe('US21.4 — cost of delay: pure calculation', () => {
  const scope = { team_id: 't1', item_type: 'story', priority: 'P1', service_ids: ['s1'] };

  it('picks the most specific applicable rule, then service over team over type over priority, and returns nothing when none applies', () => {
    const everything = rule({ id: 'a', rate_per_day: 1 });
    const priorityOnly = rule({ id: 'b', priority: 'P1', rate_per_day: 2 });
    const typeOnly = rule({ id: 'c', item_type: 'story', rate_per_day: 3 });
    const teamOnly = rule({ id: 'd', team_id: 't1', rate_per_day: 4 });
    const serviceOnly = rule({ id: 'e', service_id: 's1', rate_per_day: 5 });
    expect(matchRule([everything], scope)?.id).toBe('a');
    expect(matchRule([everything, priorityOnly], scope)?.id).toBe('b');
    expect(matchRule([priorityOnly, typeOnly, teamOnly], scope)?.id).toBe('d');
    expect(matchRule([priorityOnly, typeOnly, teamOnly, serviceOnly], scope)?.id).toBe('e');
    // Two dimensions beat one, whichever they are.
    expect(matchRule([serviceOnly, rule({ id: 'f', item_type: 'story', priority: 'P1' })], scope)?.id).toBe('f');
    // A rule that names a different team, type, priority or service does not apply.
    expect(matchRule([rule({ team_id: 't2' }), rule({ item_type: 'epic' }), rule({ priority: 'P0' }), rule({ service_id: 's2' })], scope)).toBeNull();
    expect(matchRule([], scope)).toBeNull();
  });

  it('prices a day of the interval\'s own calendar and never rounds a missing rate to zero', () => {
    const r = rule({ rate_per_day: 480 });
    expect(intervalCost(r, 24 * HOUR, '24x7')).toBe(480);
    expect(intervalCost(r, 8 * HOUR, '5x8')).toBe(480);
    expect(intervalCost(r, 12 * HOUR, '24x7')).toBe(240);
    expect(intervalCost(rule({ rate_per_day: 0 }), 5 * HOUR, '24x7')).toBe(0);
  });

  it('estimates remaining time from the visits still going and ranks by rate over remaining days', () => {
    const samples = [60, 120, 240, 360, 1440];
    expect(remainingMinutes(samples, 100)).toBe(200); // residuals 20, 140, 260, 1340 -> median (140 + 260) / 2
    expect(remainingMinutes(samples, 2000)).toBeNull();
    expect(priorityScore(1000, 300, '24x7')).toBe(4800);
    expect(priorityScore(1000, 0, '24x7')).toBeNull();
  });
});

describe('US21.4 — cost of delay: assumptions, costs and ranking', () => {
  let app: INestApplication;
  const orgId = '21400000-0000-0000-0000-000000000001';
  const otherOrg = '21400000-0000-0000-0000-00000000000f';
  const alpha = '21400000-0000-0000-0000-000000000002';
  const beta = '21400000-0000-0000-0000-000000000003';
  const gamma = '21400000-0000-0000-0000-000000000004';
  const foreignTeam = '21400000-0000-0000-0000-0000000000ff';
  const serviceId = '21400000-0000-0000-0000-0000000000c1';
  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;
  const h = { 'x-org-id': orgId, 'x-actor-id': 'finance-admin' };
  const NOW = Date.now();
  const ago = (hours: number) => new Date(NOW - hours * HOUR);
  const range = () => `from=${ago(250).toISOString()}&to=${ago(60).toISOString()}`;

  async function item(team: string, type: string, priority: string, created: Date, status: string) {
    const id = randomUUID();
    await db().query(
      `INSERT INTO work_items (id, item_key, type, title, status, priority, team_id, org_id, entered_state_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)`,
      [id, `C-${id.slice(0, 6)}`, type, `Cost item ${id.slice(0, 4)}`, status, priority, team, orgId, created.toISOString()],
    );
    return id;
  }
  async function move(id: string, from: string, to: string, when: Date, reason?: { category: string }) {
    await db().query(
      `INSERT INTO audit_events (id, event_type, work_item_id, actor_type, actor_id, payload, timestamp)
       VALUES ($1, 'WorkItemStateChanged', $2, 'user', 'tester', $3, $4)`,
      [randomUUID(), id, JSON.stringify({ from_state: from, to_state: to, ...(reason ? { wait_reason: reason } : {}) }), when.toISOString()],
    );
  }
  /** A completed visit to `state` lasting `hours`, ending `endedAgo` hours ago. */
  async function visit(team: string, type: string, priority: string, state: string, hours: number, endedAgo: number, reason?: { category: string }) {
    const entered = ago(endedAgo + hours);
    const id = await item(team, type, priority, new Date(entered.getTime() - HOUR), 'Closed');
    await move(id, 'Doing', state, entered, reason);
    await move(id, state, 'Closed', ago(endedAgo));
    return id;
  }
  /** An item currently in `state`, having entered it `hours` ago. */
  async function waiting(team: string, type: string, priority: string, state: string, hours: number) {
    const id = await item(team, type, priority, ago(hours + 5), state);
    await move(id, 'Doing', state, ago(hours));
    return id;
  }
  const put = (body: unknown) => request(server()).put('/metrics/cost-assumptions').set(h).send(body as object);
  const report = (extra = '') => request(server()).get(`/metrics/cost-of-delay?${range()}${extra}`).set(h);
  const cost = (id: string, extra = '', headers: Record<string, string> = h) =>
    request(server()).get(`/workitems/${id}/cost-of-delay?${range()}${extra}`).set(headers);

  let a1: string;
  let a2: string;
  let b1: string;
  let c1: string;
  let o1: string;
  let o2: string;
  let o3: string;
  let o4: string;
  let o5: string;
  let assumptions: any[];

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    for (const id of [orgId, otherOrg]) await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Cost org') ON CONFLICT DO NOTHING`, [id]);
    for (const [id, name, org] of [[alpha, 'Alpha', orgId], [beta, 'Beta', orgId], [gamma, 'Gamma', orgId], [foreignTeam, 'Foreign', otherOrg]]) {
      await db().query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, org, name]);
    }
    await db().query(`INSERT INTO services (id, org_id, service_key, name) VALUES ($1, $2, 'checkout', 'Checkout')`, [serviceId, orgId]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await request(server()).put('/metrics/flow-classifications').set(h).send({
      states: [
        { state: 'Waiting for customer', classification: 'waiting', default_reason: 'customer' },
        { state: 'On Hold', classification: 'blocked' },
        { state: 'Doing', classification: 'active' },
      ],
    });
    await request(server()).put('/metrics/flow-risk/settings').set(h).send({ min_sample: 3 });

    // The reported window (250h to 60h ago) holds four closed items.
    a1 = await visit(alpha, 'story', 'P1', 'Waiting for customer', 24, 150);
    a2 = await visit(alpha, 'story', 'P3', 'On Hold', 12, 140, { category: 'capacity' });
    await db().query(`INSERT INTO work_item_service_links (id, org_id, work_item_id, service_id) VALUES ($1, $2, $3, $4)`, [randomUUID(), orgId, a2, serviceId]);
    b1 = await visit(beta, 'incident', 'P0', 'On Hold', 6, 130);
    c1 = await visit(gamma, 'story', 'P2', 'Waiting for customer', 10, 120);

    // History older than the window, for remaining-duration estimates.
    for (const hours of [2, 4, 6, 8, 10]) await visit(alpha, 'story', 'P2', 'Waiting for customer', hours, 300 + hours);
    for (const hours of [6, 18]) await visit(alpha, 'story', 'P2', 'On Hold', hours, 320 + hours);

    // Waiting now, all after the reported window.
    o1 = await waiting(alpha, 'story', 'P1', 'Waiting for customer', 3);
    o2 = await waiting(alpha, 'story', 'P1', 'On Hold', 1);
    o3 = await waiting(beta, 'incident', 'P0', 'On Hold', 1);
    o4 = await waiting(gamma, 'story', 'P2', 'On Hold', 2);
    o5 = await waiting(alpha, 'story', 'P1', 'On Hold', 30);

    assumptions = [
      { team_id: alpha, rate_per_day: 1000, label: 'Alpha standard' },
      { team_id: beta, item_type: 'incident', rate_per_day: 5000, fixed_value_at_risk: 20000, label: 'Beta incidents' },
      { priority: 'P0', rate_per_day: 9000, label: 'Any P0' },
      { service_id: serviceId, rate_per_day: 3000, label: 'Checkout service' },
    ];
  });

  afterAll(async () => {
    await app?.close();
  });

  it('gives no cost, not zero, while no assumption exists', async () => {
    expect((await request(server()).get('/metrics/cost-assumptions').set(h)).body).toMatchObject({ version: null, rules: [] });
    const res = await report();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ estimate: true, assumptions: null, total_estimated_cost: null, costed_minutes: 0 });
    expect(res.body.message).toContain('No cost assumptions');
    expect(res.body.by_state).toEqual([]);
    expect(res.body.uncosted_minutes).toBeGreaterThan(0);
    const one = await cost(a1);
    expect(one.body.total_estimated_cost).toBeNull();
    expect(one.body.intervals[0]).toMatchObject({ estimated_cost: null, assumption: null });
    expect(one.body.label).toContain('not an accounting figure');
  });

  it('validates assumptions', async () => {
    const good = { rate_per_day: 100 };
    for (const bad of [
      {}, { assumptions: 'x' },
      { assumptions: [{ team_id: foreignTeam, rate_per_day: 1 }] },
      { assumptions: [{ team_id: 'nope', rate_per_day: 1 }] },
      { assumptions: [{ item_type: 'task', rate_per_day: 1 }] },
      { assumptions: [{ priority: 'P9', rate_per_day: 1 }] },
      { assumptions: [{ service_id: randomUUID(), rate_per_day: 1 }] },
      { assumptions: [{ rate_per_day: -1 }] },
      { assumptions: [{ rate_per_day: '5' }] },
      { assumptions: [{ rate_per_day: 1, fixed_value_at_risk: -5 }] },
      { assumptions: [good, good] },
      { currency: 'usd', assumptions: [good] },
    ]) {
      expect((await put(bad)).status).toBe(422);
    }
  });

  it('saves a versioned set, audits it, and leaves an unchanged save alone', async () => {
    const first = await put({ currency: 'EUR', note: 'FY26 plan', assumptions });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ changed: true, set: { version: 1, currency: 'EUR', note: 'FY26 plan', created_by: 'finance-admin' } });
    expect(first.body.set.rules).toHaveLength(4);
    expect((await put({ currency: 'EUR', note: 'ignored note change', assumptions })).body.changed).toBe(false);

    const events = await db().query<any>(`SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'CostAssumptionsChanged' ORDER BY occurred_at`, [orgId]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({ before_version: null, after_version: 1, currency: 'EUR', rule_count: 4, added: 4, removed: 0, changed: 0 });
    expect((await request(server()).get('/metrics/cost-assumptions/history').set(h)).body).toHaveLength(1);
  });

  it('prices each waiting interval and the total, with the assumptions and version used, labelled an estimate', async () => {
    const res = await cost(a1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ estimate: true, total_estimated_cost: 1000, uncosted_minutes: 0, assumptions: { version: 1, currency: 'EUR', rule_count: 4 } });
    expect(res.body.label).toContain('estimate');
    expect(res.body.intervals).toHaveLength(1);
    expect(res.body.intervals[0]).toMatchObject({
      state: 'Waiting for customer', minutes: 1440, estimated_cost: 1000, reason: 'customer',
      assumption: { label: 'Alpha standard', rate_per_day: 1000 },
    });
    // A service rule outranks the team rule: 12h at 3000/day.
    expect((await cost(a2)).body).toMatchObject({ total_estimated_cost: 1500, intervals: [{ assumption: { label: 'Checkout service' }, reason: 'capacity' }] });
    // The two-dimension rule outranks the P0 rule, and its fixed value at risk is reported: 6h at 5000/day.
    expect((await cost(b1)).body).toMatchObject({ total_estimated_cost: 1250, value_at_risk: 20000, intervals: [{ assumption: { label: 'Beta incidents' } }] });
  });

  it('reports no cost, not zero, for a wait no assumption covers', async () => {
    const res = await cost(c1);
    expect(res.body.total_estimated_cost).toBeNull();
    expect(res.body.costed_minutes).toBe(0);
    expect(res.body.uncosted_minutes).toBe(600);
    expect(res.body.intervals[0]).toMatchObject({ estimated_cost: null, assumption: null });
    expect(res.body.intervals[0].note).toContain('No assumption applies');
  });

  it('ranks states, reasons, teams and items by estimated cost and keeps uncosted time out of the total', async () => {
    const res = await report();
    expect(res.body).toMatchObject({ estimate: true, total_estimated_cost: 3750, costed_minutes: 2520, uncosted_minutes: 600, uncosted_intervals: 1, assumptions: { version: 1 } });
    expect(res.body.by_state.map((row: any) => [row.state, row.cost])).toEqual([['On Hold', 2750], ['Waiting for customer', 1000]]);
    expect(res.body.by_reason.map((row: any) => [row.reason, row.cost])).toEqual([['capacity', 1500], ['unattributed', 1250], ['customer', 1000]]);
    expect(res.body.by_team.map((row: any) => [row.team_name, row.cost])).toEqual([['Alpha', 2500], ['Beta', 1250]]);
    expect(res.body.by_item.map((row: any) => [row.work_item_id, row.cost])).toEqual([[a2, 1500], [b1, 1250], [a1, 1000]]);
    expect(res.body.by_item[1].value_at_risk).toBe(20000);
    const shares = res.body.by_state.reduce((sum: number, row: any) => sum + row.share, 0);
    expect(shares).toBeGreaterThan(0.999);
    expect(shares).toBeLessThan(1.001);
    const filtered = await report(`&team_id=${alpha}`);
    expect(filtered.body.total_estimated_cost).toBe(2500);
  });

  it('orders open waiting items by cost of delay over remaining duration, and says why an item cannot be ranked', async () => {
    const res = await request(server()).get('/metrics/cost-of-delay/open-items').set(h);
    expect(res.status).toBe(200);
    expect(res.body.estimate).toBe(true);
    expect(res.body.ranked.map((row: any) => row.work_item_id)).toEqual([o1, o2]);
    // o1 waited 3h; comparable visits longer than that: 4,6,8,10,24h -> median remaining 5h = 300 min -> 1000 / (300/1440).
    expect(res.body.ranked[0]).toMatchObject({ remaining_basis: 'historical_median_remaining', rate_per_day: 1000 });
    // The wait has run a few seconds past 3h by now, so the remaining time is just under 300 minutes.
    expect(res.body.ranked[0].priority_score).toBeGreaterThanOrEqual(4800);
    expect(res.body.ranked[0].priority_score).toBeLessThan(4900);
    expect(res.body.ranked[0].remaining_minutes).toBeGreaterThan(299);
    expect(res.body.ranked[0].remaining_minutes).toBeLessThanOrEqual(300);
    expect(res.body.ranked[0].cost_so_far).toBeCloseTo(125, 0);
    expect(res.body.ranked[1].priority_score).toBeGreaterThanOrEqual(2181);
    expect(res.body.ranked[1].priority_score).toBeLessThan(2200);

    const unranked = Object.fromEntries(res.body.unranked.map((row: any) => [row.work_item_id, row]));
    expect(unranked[o3]).toMatchObject({ remaining_basis: 'insufficient_history', priority_score: null, rate_per_day: 5000, value_at_risk: 20000 });
    expect(unranked[o5]).toMatchObject({ remaining_basis: 'beyond_history', priority_score: null });
    expect(res.body.without_assumption.map((row: any) => row.work_item_id)).toEqual([o4]);
    expect(res.body.method).toContain('remaining duration');
  });

  it('records the version each calculation used and can recalculate under an older one', async () => {
    const changed = await put({ currency: 'EUR', assumptions: assumptions.map((a) => (a.label === 'Alpha standard' ? { ...a, rate_per_day: 2000 } : a)) });
    expect(changed.body.set.version).toBe(2);
    const events = await db().query<any>(`SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'CostAssumptionsChanged' ORDER BY occurred_at`, [orgId]);
    expect(events.rows[1].payload).toMatchObject({ before_version: 1, after_version: 2, added: 0, removed: 0, changed: 1 });
    const now = await cost(a1);
    expect(now.body).toMatchObject({ total_estimated_cost: 2000, assumptions: { version: 2 } });
    const old = await cost(a1, '&version=1');
    expect(old.body).toMatchObject({ total_estimated_cost: 1000, assumptions: { version: 1 } });
    expect((await report('&version=1')).body.total_estimated_cost).toBe(3750);
    expect((await report()).body).toMatchObject({ total_estimated_cost: 4750, assumptions: { version: 2 } });
    expect((await request(server()).get('/metrics/cost-assumptions?version=1').set(h)).body.version).toBe(1);
    expect((await request(server()).get('/metrics/cost-assumptions/history').set(h)).body.map((row: any) => row.version)).toEqual([2, 1]);
    expect((await request(server()).get('/metrics/cost-assumptions?version=9').set(h)).status).toBe(404);
    expect((await report('&version=0')).status).toBe(422);
  });

  it('isolates tenants and validates the range and item', async () => {
    const foreign = await request(server()).get(`/metrics/cost-of-delay?${range()}`).set({ 'x-org-id': otherOrg });
    expect(foreign.body).toMatchObject({ assumptions: null, total_estimated_cost: null, by_item: [] });
    expect((await cost(a1, '', { 'x-org-id': otherOrg })).status).toBe(404);
    expect((await cost(randomUUID())).status).toBe(404);
    expect((await request(server()).get('/metrics/cost-of-delay?from=x').set(h)).status).toBe(422);
    expect((await request(server()).get(`/metrics/cost-of-delay?${range()}`)).status).toBe(400);
    expect((await request(server()).get('/metrics/cost-assumptions').set({ 'x-org-id': otherOrg })).body).toMatchObject({ version: null, rules: [] });
  });
});
