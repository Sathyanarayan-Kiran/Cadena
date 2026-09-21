import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { AgingEngineService } from '../src/modules/sla/aging-engine.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';
import { WorkflowService } from '../src/modules/workflow/workflow.service';

describe('US3.4 — SLA clock suspension on hold', () => {
  let app: INestApplication;
  const orgId = '34000000-0000-0000-0000-000000000001';
  const teamId = '34000000-0000-0000-0000-000000000002';
  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    await db().query(
      `INSERT INTO orgs (id, name) VALUES ($1, 'SLA hold org') ON CONFLICT DO NOTHING`,
      [orgId],
    );
    await db().query(
      `INSERT INTO teams (id, org_id, name, business_unit)
       VALUES ($1, $2, 'Support', 'Customer Operations') ON CONFLICT DO NOTHING`,
      [teamId, orgId],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function policy(state: string, suspend_sla: boolean) {
    return request(server())
      .post('/sla-policies')
      .set('x-org-id', orgId)
      .send({ item_type: 'story', state, threshold_minutes: 100, calendar: '24x7', suspend_sla })
      .expect(201);
  }

  it('stores a state-level suspension flag through the policy API', async () => {
    const response = await policy('Blocked', true);
    expect(response.body).toMatchObject({
      org_id: orgId,
      item_type: 'story',
      state: 'Blocked',
      threshold_minutes: 100,
      calendar: '24x7',
      suspend_sla: true,
    });

    const listed = await request(server()).get('/sla-policies').set('x-org-id', orgId).expect(200);
    expect(listed.body.find((entry: any) => entry.state === 'Blocked')?.suspend_sla).toBe(true);
  });

  it('preserves accrued time on hold and resumes without back-filling the paused interval', async () => {
    await policy('In Review', false);
    await policy('Blocked', true);
    await policy('In Progress', false);

    const id = randomUUID();
    const enteredAt = new Date(Date.now() - 40 * 60_000);
    await db().query(
      `INSERT INTO work_items
         (id, item_key, type, title, status, workflow_version, priority, team_id, org_id,
          entered_state_at, sla_clock_started_at, created_at, updated_at)
       VALUES ($1, $2, 'story', 'Customer confirmation required', 'In Review', 1, 'P1', $3, $4,
               $5, $5, $5, $5)`,
      [id, `STORY-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`, teamId, orgId, enteredAt.toISOString()],
    );

    const workflow = new WorkflowService();
    await workflow.transitionWorkItem({
      workItemId: id,
      orgId,
      toState: 'Blocked',
      actorId: 'support-agent',
      actorRole: 'developer',
    });

    const held = await db().query<any>(`SELECT * FROM work_items WHERE id = $1`, [id]);
    expect(held.rows[0].sla_suspended).toBe(true);
    expect(Number(held.rows[0].sla_elapsed_minutes)).toBeGreaterThanOrEqual(39);
    expect(Number(held.rows[0].sla_elapsed_minutes)).toBeLessThanOrEqual(40);

    // A separate engine instance proves the suspended clock is durable, not process memory.
    const aging = new AgingEngineService(new SlaCalculatorService());
    const pausedNow = new Date(Date.now() + 120 * 60_000);
    await aging.recomputeAgingForOrg(orgId, pausedNow);
    const afterPause = await db().query<any>(`SELECT * FROM work_items WHERE id = $1`, [id]);
    expect(afterPause.rows[0].sla_suspended).toBe(true);
    expect(Number(afterPause.rows[0].aging_score)).toBe(Number(held.rows[0].sla_elapsed_minutes));

    await workflow.transitionWorkItem({
      workItemId: id,
      orgId,
      toState: 'In Progress',
      actorId: 'support-agent',
      actorRole: 'developer',
    });
    const resumed = await db().query<any>(`SELECT * FROM work_items WHERE id = $1`, [id]);
    expect(resumed.rows[0].sla_suspended).toBe(false);
    expect(Number(resumed.rows[0].sla_elapsed_minutes)).toBe(Number(held.rows[0].sla_elapsed_minutes));

    const resumeAt = new Date(resumed.rows[0].sla_clock_started_at || resumed.rows[0].entered_state_at);
    await aging.recomputeAgingForOrg(orgId, new Date(resumeAt.getTime() + 20 * 60_000));
    const final = await db().query<any>(`SELECT * FROM work_items WHERE id = $1`, [id]);
    expect(Number(final.rows[0].aging_score)).toBe(Number(held.rows[0].sla_elapsed_minutes) + 20);
    expect(Number(final.rows[0].aging_score)).toBeLessThan(100);
  });
});
