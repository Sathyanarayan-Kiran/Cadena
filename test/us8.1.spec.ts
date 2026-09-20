import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { AgingEngineService } from '../src/modules/sla/aging-engine.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';

describe('US8.1 — SLA warning notifications reach the owner', () => {
  let app: INestApplication;
  let aging: AgingEngineService;

  const orgId = '81000000-0000-0000-0000-000000000001';
  const teamId = '81000000-0000-0000-0000-000000000002';
  const ownerId = '81000000-0000-0000-0000-000000000003';

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const db = DatabaseService.getInstance();
    await db.initialize();
    await db.db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'US8.1 Org') ON CONFLICT DO NOTHING`, [orgId]);
    await db.db.query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Delivery') ON CONFLICT DO NOTHING`,
      [teamId, orgId],
    );
    await db.db.query(
      `INSERT INTO people (id, org_id, team_id, name, email, role)
       VALUES ($1, $2, $3, 'Ada Owner', 'ada@example.test', 'developer') ON CONFLICT DO NOTHING`,
      [ownerId, orgId, teamId],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // Constructed directly: vitest's esbuild transform does not emit decorator metadata,
    // so Nest cannot inject by type in tests. Matches the existing Epic 3 specs.
    aging = new AgingEngineService(new SlaCalculatorService());

    await request(server())
      .post('/sla-policies')
      .set('x-org-id', orgId)
      .send({ item_type: 'story', state: 'In Review', threshold_minutes: 60, calendar: '24x7' })
      .expect(201);
  });

  it('notifies the owner on their preferred channel when an item crosses 75% of its SLA', async () => {
    const story = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Nearly breaching review', team_id: teamId, org_id: orgId, owner_id: ownerId })
      .expect(201);

    await request(server())
      .post(`/workitems/${story.body.id}/transitions`)
      .set('x-org-id', orgId)
      .send({ to_state: 'Planned' })
      .expect(201);
    await request(server())
      .post(`/workitems/${story.body.id}/transitions`)
      .set('x-org-id', orgId)
      .send({ to_state: 'In Progress' })
      .expect(201);
    await request(server())
      .post(`/workitems/${story.body.id}/transitions`)
      .set('x-org-id', orgId)
      .send({ to_state: 'In Review' })
      .expect(201);

    await request(server())
      .post('/notifications/preferences')
      .set('x-org-id', orgId)
      .send({ person_id: ownerId, channel: 'slack', address: '@ada' })
      .expect(201);

    // 48 minutes into a 60 minute threshold is 80% consumed.
    const enteredAt = new Date(Date.now() - 48 * 60 * 1000).toISOString();
    await DatabaseService.getInstance().db.query(
      `UPDATE work_items SET entered_state_at = $1 WHERE id = $2`,
      [enteredAt, story.body.id],
    );

    const startedAt = Date.now();
    const summary = await aging.recomputeAgingForOrg(orgId);
    const elapsedMs = Date.now() - startedAt;

    expect(summary.warningCount).toBeGreaterThanOrEqual(1);
    // US8.1 allows one minute; in-process dispatch runs inside the tick that emitted the event.
    expect(elapsedMs).toBeLessThan(60_000);

    const notifications = await request(server())
      .get(`/notifications?work_item_id=${story.body.id}&event_type=SLAWarning`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(notifications.body).toHaveLength(1);
    expect(notifications.body[0]).toMatchObject({
      event_type: 'SLAWarning',
      recipient_id: ownerId,
      recipient_role: 'owner',
      requested_channel: 'slack',
      channel: 'slack',
      status: 'sent',
      work_item_key: story.body.key,
    });
    expect(notifications.body[0].subject).toContain('[SLA warning]');
    expect(notifications.body[0].body).toContain('Ada Owner');
    expect(notifications.body[0].delivered_at).toBeTruthy();
  });

  it('does not notify the same recipient twice for one event', async () => {
    const story = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Repeat tick story', team_id: teamId, org_id: orgId, owner_id: ownerId })
      .expect(201);

    for (const state of ['Planned', 'In Progress', 'In Review']) {
      await request(server())
        .post(`/workitems/${story.body.id}/transitions`)
        .set('x-org-id', orgId)
        .send({ to_state: state })
        .expect(201);
    }

    await DatabaseService.getInstance().db.query(
      `UPDATE work_items SET entered_state_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 50 * 60 * 1000).toISOString(), story.body.id],
    );

    await aging.recomputeAgingForOrg(orgId);
    await aging.recomputeAgingForOrg(orgId);
    await aging.recomputeAgingForOrg(orgId);

    const notifications = await request(server())
      .get(`/notifications?work_item_id=${story.body.id}&event_type=SLAWarning`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(notifications.body).toHaveLength(1);
  });

  it('records no notification for an unowned item and keeps the log tenant-scoped', async () => {
    const story = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Unassigned review work', team_id: teamId, org_id: orgId })
      .expect(201);

    for (const state of ['Planned', 'In Progress', 'In Review']) {
      await request(server())
        .post(`/workitems/${story.body.id}/transitions`)
        .set('x-org-id', orgId)
        .send({ to_state: state })
        .expect(201);
    }
    await DatabaseService.getInstance().db.query(
      `UPDATE work_items SET entered_state_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 55 * 60 * 1000).toISOString(), story.body.id],
    );
    await aging.recomputeAgingForOrg(orgId);

    const notifications = await request(server())
      .get(`/notifications?work_item_id=${story.body.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(notifications.body).toHaveLength(0);

    const otherTenant = await request(server())
      .get('/notifications')
      .set('x-org-id', randomUUID())
      .expect(200);
    expect(otherTenant.body).toHaveLength(0);

    await request(server()).get('/notifications').expect(400);
  });
});
