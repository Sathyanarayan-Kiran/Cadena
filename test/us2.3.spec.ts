import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { InProcessEventBus } from '../src/modules/events/event-bus';

describe('US2.3 — Automatic transitions from external events', () => {
  let app: INestApplication;
  const orgId = '23000000-0000-0000-0000-000000000001';
  const teamId = '23000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .post('/workflows/definitions')
      .send({
        type: 'story',
        states: ['Proposed', 'In Progress', 'In Review', 'Closed'],
        initial_state: 'Proposed',
        terminal_states: ['Closed'],
        transitions: [
          { from: 'Proposed', to: 'In Progress' },
          { from: 'In Progress', to: 'In Review', guard: 'release_manager' },
          { from: 'In Review', to: 'Closed' },
        ],
      })
      .expect(201);
  });

  it('skips and records a PR-driven transition when its workflow guard rejects the integration actor', async () => {
    const created = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Guarded deployment story', team_id: teamId, org_id: orgId })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/workitems/${created.body.id}/transitions`)
      .set('x-org-id', orgId)
      .send({ to_state: 'In Progress' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', 'us2.3-guarded-pr')
      .send({
        provider: 'github',
        event_type: 'pull_request',
        repository: 'cadena/platform',
        action: 'merged',
        pull_request: {
          id: 2301,
          title: `Complete ${created.body.key}`,
          merged: true,
          state: 'closed',
        },
      })
      .expect(201);

    expect(response.body.transitions).toHaveLength(1);
    expect(response.body.transitions[0].outcome).toBe('skipped');
    expect(response.body.transitions[0].reason).toContain('release_manager');

    const item = await request(app.getHttpServer())
      .get(`/workitems/${created.body.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(item.body.status).toBe('In Progress');

    const skippedEvent = InProcessEventBus.getInstance().emittedEvents.find(
      (event) => event.event_type === 'IntegrationAutoTransitionSkipped'
        && event.work_item_id === created.body.id,
    );
    expect(skippedEvent?.payload.reason).toContain('release_manager');
  });
});
