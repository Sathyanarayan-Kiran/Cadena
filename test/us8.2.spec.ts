import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { AgingEngineService } from '../src/modules/sla/aging-engine.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';

describe('US8.2 — Breach and escalation routing beyond the owner', () => {
  let app: INestApplication;
  let aging: AgingEngineService;

  const orgId = '82000000-0000-0000-0000-000000000001';
  const teamId = '82000000-0000-0000-0000-000000000002';
  const ownerId = '82000000-0000-0000-0000-000000000003';
  const leadId = '82000000-0000-0000-0000-000000000004';
  const managerId = '82000000-0000-0000-0000-000000000005';

  const server = () => app.getHttpServer();

  async function ageIntoReview(title: string, minutesInState: number, owner = ownerId) {
    const story = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title, team_id: teamId, org_id: orgId, owner_id: owner })
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
      [new Date(Date.now() - minutesInState * 60 * 1000).toISOString(), story.body.id],
    );
    return story.body;
  }

  beforeAll(async () => {
    const db = DatabaseService.getInstance();
    await db.initialize();
    await db.db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'US8.2 Org') ON CONFLICT DO NOTHING`, [orgId]);
    await db.db.query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Delivery') ON CONFLICT DO NOTHING`,
      [teamId, orgId],
    );
    for (const [id, name, email, role] of [
      [ownerId, 'Owen Owner', 'owen@example.test', 'developer'],
      [leadId, 'Lena Lead', 'lena@example.test', 'team_lead'],
      [managerId, 'Mara Manager', 'mara@example.test', 'cab_approver'],
    ]) {
      await db.db.query(
        `INSERT INTO people (id, org_id, team_id, name, email, role)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [id, orgId, teamId, name, email, role],
      );
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    aging = new AgingEngineService(new SlaCalculatorService());

    await request(server())
      .post('/sla-policies')
      .set('x-org-id', orgId)
      .send({ item_type: 'story', state: 'In Review', threshold_minutes: 60, calendar: '24x7' })
      .expect(201);
  });

  it('notifies both the owner and the team lead when an item breaches', async () => {
    // 70 minutes against a 60 minute threshold is 117%: breached, but below escalation.
    const story = await ageIntoReview('Breaching review work', 70);
    const summary = await aging.recomputeAgingForOrg(orgId);
    expect(summary.breachCount).toBeGreaterThanOrEqual(1);

    const notifications = await request(server())
      .get(`/notifications?work_item_id=${story.id}&event_type=SLABreached`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(notifications.body).toHaveLength(2);
    const byRole = Object.fromEntries(notifications.body.map((n: any) => [n.recipient_role, n]));
    expect(byRole.owner.recipient_id).toBe(ownerId);
    expect(byRole.team_lead.recipient_id).toBe(leadId);
    expect(byRole.owner.subject).toContain('[SLA breached]');
    expect(byRole.team_lead.status).toBe('sent');

    // Below the 150% escalation threshold, nothing escalates.
    const escalations = await request(server())
      .get(`/notifications?work_item_id=${story.id}&event_type=SLAEscalated`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(escalations.body).toHaveLength(0);
  });

  it('escalates to the configured manager at 150% and flags the item as escalated', async () => {
    await request(server())
      .post(`/notifications/escalation-targets/${teamId}`)
      .set('x-org-id', orgId)
      .send({ person_id: managerId })
      .expect(201);

    // 100 minutes against a 60 minute threshold is 167%.
    const story = await ageIntoReview('Badly stalled review work', 100);
    const summary = await aging.recomputeAgingForOrg(orgId);
    expect(summary.escalationCount).toBeGreaterThanOrEqual(1);

    const escalations = await request(server())
      .get(`/notifications?work_item_id=${story.id}&event_type=SLAEscalated`)
      .set('x-org-id', orgId)
      .expect(200);

    const roles = escalations.body.map((n: any) => n.recipient_role).sort();
    expect(roles).toEqual(['escalation_target', 'owner']);
    const target = escalations.body.find((n: any) => n.recipient_role === 'escalation_target');
    expect(target.recipient_id).toBe(managerId);
    expect(target.subject).toContain('[Escalation]');

    // The item is flagged as escalated so it is queryable ahead of the Epic 9 dashboard.
    const escalated = await DatabaseService.getInstance().db.query<any>(
      `SELECT escalated_at FROM work_items WHERE id = $1`,
      [story.id],
    );
    expect(escalated.rows[0].escalated_at).toBeTruthy();
  });

  it('falls back to an on-call team member when no escalation target is configured', async () => {
    const otherTeamId = '82000000-0000-0000-0000-00000000000a';
    const onCallId = '82000000-0000-0000-0000-00000000000b';
    const db = DatabaseService.getInstance();
    await db.db.query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Platform') ON CONFLICT DO NOTHING`,
      [otherTeamId, orgId],
    );
    await db.db.query(
      `INSERT INTO people (id, org_id, team_id, name, email, role)
       VALUES ($1, $2, $3, 'Otto Oncall', 'otto@example.test', 'on_call') ON CONFLICT DO NOTHING`,
      [onCallId, orgId, otherTeamId],
    );

    const story = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Platform stall', team_id: otherTeamId, org_id: orgId })
      .expect(201);
    for (const state of ['Planned', 'In Progress', 'In Review']) {
      await request(server())
        .post(`/workitems/${story.body.id}/transitions`)
        .set('x-org-id', orgId)
        .send({ to_state: state })
        .expect(201);
    }
    await db.db.query(
      `UPDATE work_items SET entered_state_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 120 * 60 * 1000).toISOString(), story.body.id],
    );

    await aging.recomputeAgingForOrg(orgId);

    const escalations = await request(server())
      .get(`/notifications?work_item_id=${story.body.id}&event_type=SLAEscalated`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(escalations.body).toHaveLength(1);
    expect(escalations.body[0]).toMatchObject({
      recipient_id: onCallId,
      recipient_role: 'escalation_target',
    });
  });

  it('validates the escalation threshold and rejects an unknown escalation target', async () => {
    const tooLow = await request(server())
      .post('/notifications/settings')
      .set('x-org-id', orgId)
      .send({ escalation_threshold_percent: 90 })
      .expect(422);
    expect(tooLow.body.message).toContain('greater than 100');

    const unknownPerson = await request(server())
      .post(`/notifications/escalation-targets/${teamId}`)
      .set('x-org-id', orgId)
      .send({ person_id: '82000000-0000-0000-0000-0000000000ff' })
      .expect(422);
    expect(unknownPerson.body.message).toContain('not found in this tenant');

    const settings = await request(server())
      .post('/notifications/settings')
      .set('x-org-id', orgId)
      .send({ escalation_threshold_percent: 200 })
      .expect(201);
    expect(settings.body.escalation_threshold_percent).toBe(200);

    await request(server())
      .post('/notifications/settings')
      .set('x-org-id', orgId)
      .send({ escalation_threshold_percent: 150 })
      .expect(201);
  });
});
