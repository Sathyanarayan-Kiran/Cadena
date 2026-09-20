import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { AgingEngineService } from '../src/modules/sla/aging-engine.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';

describe('US8.3 — Per-user notification channel with email fallback', () => {
  let app: INestApplication;
  let aging: AgingEngineService;

  const orgId = '83000000-0000-0000-0000-000000000001';
  const teamId = '83000000-0000-0000-0000-000000000002';
  const slackUserId = '83000000-0000-0000-0000-000000000003';
  const teamsUserId = '83000000-0000-0000-0000-000000000004';
  const noAddressUserId = '83000000-0000-0000-0000-000000000005';

  const server = () => app.getHttpServer();

  async function warnFor(title: string, ownerId: string) {
    const story = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title, team_id: teamId, org_id: orgId, owner_id: ownerId })
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
      [new Date(Date.now() - 48 * 60 * 1000).toISOString(), story.body.id],
    );
    await aging.recomputeAgingForOrg(orgId);

    const notifications = await request(server())
      .get(`/notifications?work_item_id=${story.body.id}&event_type=SLAWarning`)
      .set('x-org-id', orgId)
      .expect(200);
    return notifications.body[0];
  }

  beforeAll(async () => {
    const db = DatabaseService.getInstance();
    await db.initialize();
    await db.db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'US8.3 Org') ON CONFLICT DO NOTHING`, [orgId]);
    await db.db.query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Delivery') ON CONFLICT DO NOTHING`,
      [teamId, orgId],
    );
    for (const [id, name, email] of [
      [slackUserId, 'Sam Slack', 'sam@example.test'],
      [teamsUserId, 'Tess Teams', 'tess@example.test'],
      [noAddressUserId, 'Nadia NoAddress', 'nadia@example.test'],
    ]) {
      await db.db.query(
        `INSERT INTO people (id, org_id, team_id, name, email, role)
         VALUES ($1, $2, $3, $4, $5, 'developer') ON CONFLICT DO NOTHING`,
        [id, orgId, teamId, name, email],
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

  it('delivers on the channel the user chose', async () => {
    await request(server())
      .post('/notifications/preferences')
      .set('x-org-id', orgId)
      .send({ person_id: slackUserId, channel: 'slack', address: '@sam' })
      .expect(201);
    await request(server())
      .post('/notifications/preferences')
      .set('x-org-id', orgId)
      .send({ person_id: teamsUserId, channel: 'teams', address: 'tess@teams' })
      .expect(201);

    const slackNotification = await warnFor('Slack routed work', slackUserId);
    expect(slackNotification).toMatchObject({ requested_channel: 'slack', channel: 'slack', status: 'sent' });

    const teamsNotification = await warnFor('Teams routed work', teamsUserId);
    expect(teamsNotification).toMatchObject({ requested_channel: 'teams', channel: 'teams', status: 'sent' });

    const preference = await request(server())
      .get(`/notifications/preferences/${slackUserId}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(preference.body).toMatchObject({ channel: 'slack', address: '@sam' });
  });

  it('falls back to email when the preferred channel has no address', async () => {
    await request(server())
      .post('/notifications/preferences')
      .set('x-org-id', orgId)
      .send({ person_id: noAddressUserId, channel: 'slack' })
      .expect(201);

    const notification = await warnFor('Unreachable on slack', noAddressUserId);

    expect(notification).toMatchObject({
      requested_channel: 'slack',
      channel: 'email',
      status: 'fallback_sent',
    });
    expect(notification.attempts).toHaveLength(2);
    expect(notification.attempts[0]).toMatchObject({ channel: 'slack', delivered: false });
    expect(notification.attempts[0].error).toContain('no slack address is configured');
    expect(notification.attempts[1]).toMatchObject({ channel: 'email', delivered: true });
    expect(notification.delivered_at).toBeTruthy();
  });

  it('falls back to email when the preferred channel is unavailable', async () => {
    await request(server())
      .post('/notifications/settings')
      .set('x-org-id', orgId)
      .send({ unavailable_channels: ['slack'] })
      .expect(201);

    const notification = await warnFor('Slack outage during warning', slackUserId);

    expect(notification).toMatchObject({
      requested_channel: 'slack',
      channel: 'email',
      status: 'fallback_sent',
    });
    expect(notification.attempts[0].error).toContain('slack is currently unavailable');

    await request(server())
      .post('/notifications/settings')
      .set('x-org-id', orgId)
      .send({ unavailable_channels: [] })
      .expect(201);
  });

  it('records a failure when the fallback channel is also unavailable', async () => {
    await request(server())
      .post('/notifications/settings')
      .set('x-org-id', orgId)
      .send({ unavailable_channels: ['slack', 'email'] })
      .expect(201);

    const notification = await warnFor('Total delivery outage', slackUserId);

    expect(notification.status).toBe('failed');
    expect(notification.delivered_at).toBeNull();
    expect(notification.error).toContain('email is currently unavailable');
    expect(notification.attempts.every((attempt: any) => attempt.delivered === false)).toBe(true);

    await request(server())
      .post('/notifications/settings')
      .set('x-org-id', orgId)
      .send({ unavailable_channels: [] })
      .expect(201);
  });

  it('defaults to email and rejects an unknown channel', async () => {
    const defaulted = await request(server())
      .get(`/notifications/preferences/83000000-0000-0000-0000-0000000000ff`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(defaulted.body).toMatchObject({ channel: 'email', address: null });

    const badChannel = await request(server())
      .post('/notifications/preferences')
      .set('x-org-id', orgId)
      .send({ person_id: slackUserId, channel: 'carrier-pigeon' })
      .expect(422);
    expect(badChannel.body.message).toContain('email, slack, teams');

    const unknownPerson = await request(server())
      .post('/notifications/preferences')
      .set('x-org-id', orgId)
      .send({ person_id: '83000000-0000-0000-0000-0000000000fe', channel: 'email' })
      .expect(422);
    expect(unknownPerson.body.message).toContain('not found in this tenant');
  });
});
