process.env.CADENA_FLOW_RISK_SCHEDULER = 'disabled';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { assessRisk } from '../src/modules/flow/flow-risk';
import { FlowRiskScheduler } from '../src/modules/flow/flow-risk.service';

const HOUR = 3_600_000;

describe('US21.3 — risk of waiting: pure calculation', () => {
  const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((hours) => hours * 60);

  it('produces no score below the minimum number of comparable items', () => {
    const result = assessRisk({ samples: [60, 120, 180], sampleItems: 3, currentMinutes: 100, targetMinutes: 600, minSample: 10 });
    expect(result.status).toBe('insufficient_history');
    expect(result).not.toHaveProperty('percentile');
    expect((result as any).message).toContain('insufficient');
  });

  it('uses a mid-rank percentile, so ties and extremes are handled honestly', () => {
    const base = { samples, sampleItems: 12, targetMinutes: null, minSample: 10 };
    expect((assessRisk({ ...base, currentMinutes: 570 }) as any).percentile).toBe(0.75);
    expect((assessRisk({ ...base, currentMinutes: 300 }) as any).percentile).toBe(0.375); // 4 below, 1 equal
    expect((assessRisk({ ...base, currentMinutes: 5000 }) as any).percentile).toBe(1);
    expect((assessRisk({ ...base, currentMinutes: 10 }) as any).percentile).toBe(0);
  });

  it('estimates the chance of overrunning the target from the visits still going, and says when it cannot', () => {
    const base = { samples, sampleItems: 12, minSample: 10 };
    const conditional: any = assessRisk({ ...base, currentMinutes: 570, targetMinutes: 660 });
    expect(conditional).toMatchObject({ probability_exceed_target: 0.3333, probability_basis: 'conditional_empirical' });
    expect(assessRisk({ ...base, currentMinutes: 700, targetMinutes: 660 })).toMatchObject({ probability_exceed_target: 1, probability_basis: 'already_past_target' });
    expect(assessRisk({ ...base, currentMinutes: 570, targetMinutes: null })).toMatchObject({ probability_exceed_target: null, probability_basis: 'no_sla_target' });
    expect(assessRisk({ ...base, currentMinutes: 800, targetMinutes: 900 })).toMatchObject({ probability_exceed_target: null, probability_basis: 'beyond_history' });
  });
});

describe('US21.3 — risk of waiting: evaluation, notification and visibility', () => {
  let app: INestApplication;
  const orgId = '21300000-0000-0000-0000-000000000001';
  const otherOrg = '21300000-0000-0000-0000-00000000000f';
  const alpha = '21300000-0000-0000-0000-000000000002';
  const beta = '21300000-0000-0000-0000-000000000003';
  const foreignTeam = '21300000-0000-0000-0000-0000000000ff';
  const onCall = '21300000-0000-0000-0000-0000000000a1';
  const ownerPerson = '21300000-0000-0000-0000-0000000000a2';
  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;
  const h = { 'x-org-id': orgId, 'x-actor-id': 'flow-admin' };
  const NOW = Date.now();
  const ago = (hours: number) => new Date(NOW - hours * HOUR);

  async function item(team: string, created: Date, status: string, owner: string | null = null, org = orgId) {
    const id = randomUUID();
    await db().query(
      `INSERT INTO work_items (id, item_key, type, title, status, priority, team_id, org_id, owner_id, entered_state_at, created_at, updated_at)
       VALUES ($1, $2, 'story', $3, $4, 'medium', $5, $6, $7, $8, $8, $8)`,
      [id, `R-${id.slice(0, 6)}`, `Risk item ${id.slice(0, 4)}`, status, team, org, owner, created.toISOString()],
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
  /** A completed visit to "Waiting for customer" that lasted `hours`, ending well in the past. */
  async function completedVisit(team: string, hours: number, endedHoursAgo: number) {
    const entered = ago(endedHoursAgo + hours);
    const id = await item(team, new Date(entered.getTime() - HOUR), 'Closed');
    await move(id, 'Doing', 'Waiting for customer', entered);
    await move(id, 'Waiting for customer', 'Closed', ago(endedHoursAgo));
    return id;
  }
  const classify = (states: unknown[]) => request(server()).put('/metrics/flow-classifications').set(h).send({ states });
  const risk = (id: string, headers: Record<string, string> = h) => request(server()).get(`/workitems/${id}/flow-risk`).set(headers);
  const evaluate = () => request(server()).post('/metrics/flow-risk/evaluate').set(h);
  const notificationsFor = async (id: string) =>
    (await db().query<any>(
      `SELECT recipient_id, recipient_role, subject, body, event_type FROM notifications WHERE work_item_id = $1 AND event_type = 'FlowWaitRiskCrossed'`, [id],
    )).rows;

  let wa: string;
  let wb: string;
  let wc: string;
  let wd: string;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    for (const id of [orgId, otherOrg]) await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Risk org') ON CONFLICT DO NOTHING`, [id]);
    for (const [id, name, org] of [[alpha, 'Alpha', orgId], [beta, 'Beta', orgId], [foreignTeam, 'Foreign', otherOrg]]) {
      await db().query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, org, name]);
    }
    await db().query(`INSERT INTO people (id, org_id, team_id, name, email, role) VALUES ($1, $2, $3, 'Olive On-call', 'olive@example.test', 'on_call') ON CONFLICT DO NOTHING`, [onCall, orgId, alpha]);
    await db().query(`INSERT INTO people (id, org_id, team_id, name, email, role) VALUES ($1, $2, $3, 'Otto Owner', 'otto@example.test', 'developer') ON CONFLICT DO NOTHING`, [ownerPerson, orgId, alpha]);
    await db().query(
      `INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar) VALUES ($1, $2, 'story', 'Waiting for customer', 660, '24x7')`,
      [randomUUID(), orgId],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await classify([{ state: 'Waiting for customer', classification: 'waiting' }, { state: 'Doing', classification: 'active' }]);

    // Twelve completed comparable visits of 1..12 hours for alpha, three of 1..3 hours for beta.
    for (let hours = 1; hours <= 12; hours++) await completedVisit(alpha, hours, 300 + hours);
    for (let hours = 1; hours <= 3; hours++) await completedVisit(beta, hours, 300 + hours);

    wa = await item(alpha, ago(20), 'Waiting for customer', ownerPerson);
    await move(wa, 'Doing', 'Waiting for customer', ago(9.5));
    wb = await item(alpha, ago(20), 'Waiting for customer', ownerPerson);
    await move(wb, 'Doing', 'Waiting for customer', ago(11.5));
    wc = await item(beta, ago(20), 'Waiting for customer');
    await move(wc, 'Doing', 'Waiting for customer', ago(2.5));
    wd = await item(alpha, ago(20), 'Doing');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('scores a waiting item from comparable completed visits and shows the sample and method', async () => {
    const res = await risk(wa);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'scored',
      state: 'Waiting for customer',
      percentile: 0.75,
      probability_exceed_target: 0.3333,
      probability_basis: 'conditional_empirical',
      sample_size: 12,
      sample_items: 12,
      min_sample: 10,
      target_minutes: 660,
      threshold: 0.9,
      at_risk: false,
    });
    expect(res.body.current_wait_minutes).toBeCloseTo(570, 0);
    expect(res.body.method).toContain('Empirical distribution');
    const past = await risk(wb);
    expect(past.body).toMatchObject({ status: 'scored', at_risk: true, probability_exceed_target: 1, probability_basis: 'already_past_target' });
    expect(past.body.percentile).toBeCloseTo(0.9167, 3);
  });

  it('gives no score when there is too little comparable history, never falling back to another team\'s', async () => {
    const res = await risk(wc);
    expect(res.body).toMatchObject({ status: 'insufficient_history', sample_size: 3, sample_items: 3, min_sample: 10 });
    expect(res.body).not.toHaveProperty('percentile');
    expect(res.body.message).toContain('insufficient');
    expect(res.body.at_risk).toBe(false);
  });

  it('reports an item that is not waiting, an unknown item, and another tenant\'s item', async () => {
    expect((await risk(wd)).body).toMatchObject({ status: 'not_waiting', state: 'Doing' });
    expect((await risk(randomUUID())).status).toBe(404);
    expect((await risk(wa, { 'x-org-id': otherOrg })).status).toBe(404);
  });

  it('validates, audits and applies a configurable minimum sample and threshold', async () => {
    const defaults = await request(server()).get('/metrics/flow-risk/settings').set(h);
    expect(defaults.body).toMatchObject({ min_sample: 10, percentile_threshold: 0.9, lookback_days: 180, is_default: true });
    for (const bad of [{ min_sample: 2 }, { min_sample: 2.5 }, { percentile_threshold: 0.2 }, { percentile_threshold: 1 }, { lookback_days: 3 }]) {
      expect((await request(server()).put('/metrics/flow-risk/settings').set(h).send(bad)).status).toBe(422);
    }

    const changed = await request(server()).put('/metrics/flow-risk/settings').set(h).send({ min_sample: 3 });
    expect(changed.body).toMatchObject({ min_sample: 3, percentile_threshold: 0.9, is_default: false });
    const scoredNow = await risk(wc);
    expect(scoredNow.body).toMatchObject({ status: 'scored', sample_size: 3 });
    expect(scoredNow.body.percentile).toBeCloseTo(0.6667, 3);

    const events = await db().query<any>(
      `SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'FlowRiskSettingsChanged'`, [orgId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({ before: null, after: { min_sample: 3 } });
    await request(server()).put('/metrics/flow-risk/settings').set(h).send({ min_sample: 3 });
    expect((await db().query<any>(`SELECT 1 FROM domain_events WHERE org_id = $1 AND event_type = 'FlowRiskSettingsChanged'`, [orgId])).rows).toHaveLength(1);

    await request(server()).put('/metrics/flow-risk/settings').set(h).send({ min_sample: 10 });
    expect((await risk(wc)).body.status).toBe('insufficient_history');
  });

  it('ignores history older than the lookback window', async () => {
    await request(server()).put('/metrics/flow-risk/settings').set(h).send({ lookback_days: 7 });
    expect((await risk(wa)).body).toMatchObject({ status: 'insufficient_history', sample_size: 0 });
    await request(server()).put('/metrics/flow-risk/settings').set(h).send({ lookback_days: 180 });
    expect((await risk(wa)).body.status).toBe('scored');
  });

  it('notifies through the escalation routing exactly once per crossing, without marking the item escalated', async () => {
    const first = await evaluate();
    expect(first.body).toMatchObject({ evaluated: 3, scored: 2, insufficient_history: 1, at_risk: 1, crossings_notified: 1 });

    const sent = await notificationsFor(wb);
    expect(sent.map((row: any) => row.recipient_role).sort()).toEqual(['escalation_target', 'owner']);
    expect(sent.find((row: any) => row.recipient_role === 'escalation_target').recipient_id).toBe(onCall);
    expect(sent[0].subject).toContain('[Waiting risk]');
    expect(sent[0].body).toContain('estimate from history');
    expect(await notificationsFor(wa)).toHaveLength(0);
    expect(await notificationsFor(wc)).toHaveLength(0);
    expect((await db().query<any>(`SELECT escalated_at FROM work_items WHERE id = $1`, [wb])).rows[0].escalated_at).toBeNull();

    const again = await evaluate();
    expect(again.body).toMatchObject({ at_risk: 1, crossings_notified: 0 });
    expect(await notificationsFor(wb)).toHaveLength(2);
  });

  it('exposes the latest evaluation for the board and lets the at-risk list be filtered', async () => {
    const all = await request(server()).get('/metrics/flow-risk').set(h);
    expect(all.body.map((row: any) => row.work_item_id).sort()).toEqual([wa, wb, wc].sort());
    const atRisk = await request(server()).get('/metrics/flow-risk?at_risk=true').set(h);
    expect(atRisk.body).toHaveLength(1);
    expect(atRisk.body[0]).toMatchObject({ work_item_id: wb, at_risk: true, notified_count: 1, status: 'scored', sample_size: 12 });
    const insufficient = all.body.find((row: any) => row.work_item_id === wc);
    expect(insufficient).toMatchObject({ status: 'insufficient_history', percentile: null, at_risk: false });
    expect((await request(server()).get('/metrics/flow-risk').set({ 'x-org-id': otherOrg })).body).toEqual([]);
    expect((await request(server()).get(`/metrics/flow-risk?team_id=${beta}`).set(h)).body).toHaveLength(1);
  });

  it('re-arms when risk falls below the threshold and notifies again on the next crossing', async () => {
    const longVisits: string[] = [];
    for (let i = 0; i < 6; i++) longVisits.push(await completedVisit(alpha, 40, 250));
    const dropped = await evaluate();
    expect(dropped.body).toMatchObject({ at_risk: 0, crossings_notified: 0 });
    expect((await db().query<any>(`SELECT above FROM flow_wait_risk WHERE work_item_id = $1`, [wb])).rows[0].above).toBe(false);
    expect(await notificationsFor(wb)).toHaveLength(2);

    await db().query(`DELETE FROM audit_events WHERE work_item_id = ANY($1::uuid[])`, [longVisits]);
    const crossed = await evaluate();
    expect(crossed.body).toMatchObject({ at_risk: 1, crossings_notified: 1 });
    expect(await notificationsFor(wb)).toHaveLength(4);
    expect((await db().query<any>(`SELECT notified_count FROM flow_wait_risk WHERE work_item_id = $1`, [wb])).rows[0].notified_count).toBe(2);
  });

  it('drops an item from the current list once it stops waiting', async () => {
    await move(wb, 'Waiting for customer', 'Closed', new Date());
    await db().query(`UPDATE work_items SET status = 'Closed' WHERE id = $1`, [wb]);
    const summary = await evaluate();
    expect(summary.body.evaluated).toBe(2);
    const current = await request(server()).get('/metrics/flow-risk').set(h);
    expect(current.body.map((row: any) => row.work_item_id)).not.toContain(wb);
    expect((await risk(wb)).body.status).toBe('not_waiting');
  });

  it('runs on the scheduler tick for every tenant without crossing into another', async () => {
    const results = await app.get(FlowRiskScheduler).tick();
    expect(results[orgId]).toMatchObject({ evaluated: 2 });
    expect(results[otherOrg]).toMatchObject({ evaluated: 0 });
  });
});
