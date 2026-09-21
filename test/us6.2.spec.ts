import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { postGitAndWait } from './integration-webhook-helpers';

describe('US6.2 — Pull-request merge auto-transition', () => {
  let app: INestApplication;
  const orgId = '62000000-0000-0000-0000-000000000001';
  const teamId = '62000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('moves a linked Story from In Progress to In Review when its PR is merged', async () => {
    const story = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'PR automation story', team_id: teamId, org_id: orgId })
      .expect(201);

    for (const toState of ['Planned', 'In Progress']) {
      await request(app.getHttpServer())
        .post(`/workitems/${story.body.id}/transitions`)
        .set('x-org-id', orgId)
        .send({ to_state: toState })
        .expect(201);
    }

    const webhook = await postGitAndWait(
      app.getHttpServer(), orgId, 'us6.2-merged-pr', {
        provider: 'github',
        event_type: 'pull_request',
        repository: 'cadena/platform',
        action: 'merged',
        pull_request: {
          id: 6201,
          title: `Ship ${story.body.key}`,
          url: 'https://github.example/cadena/platform/pull/6201',
          merged: true,
          state: 'closed',
        },
      },
    );

    expect(webhook.body.transitions).toEqual([
      expect.objectContaining({
        work_item_key: story.body.key,
        from_state: 'In Progress',
        to_state: 'In Review',
        outcome: 'applied',
      }),
    ]);

    const updated = await request(app.getHttpServer())
      .get(`/workitems/${story.body.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(updated.body.status).toBe('In Review');
  });
});
