import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US6.1 — Commit and pull-request linking', () => {
  let app: INestApplication;
  const orgId = '61000000-0000-0000-0000-000000000001';
  const teamId = '61000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('stores a commit and links it to the referenced work-item key', async () => {
    const story = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Webhook reference matching', team_id: teamId, org_id: orgId })
      .expect(201);

    const webhook = await request(app.getHttpServer())
      .post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', 'us6.1-linked-commit')
      .send({
        provider: 'github',
        event_type: 'push',
        repository: 'cadena/platform',
        commits: [{
          sha: 'abc123def456',
          message: `feat: implement gateway for ${story.body.key}`,
          url: 'https://github.example/cadena/platform/commit/abc123def456',
        }],
      })
      .expect(201);

    expect(webhook.body.linked_work_item_keys).toEqual([story.body.key]);
    expect(webhook.body.artifacts[0].artifact_type).toBe('commit');

    const links = await request(app.getHttpServer())
      .get(`/workitems/${story.body.id}/external-links`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(links.body).toHaveLength(1);
    expect(links.body[0]).toMatchObject({ external_id: 'abc123def456', link_type: 'fixed_by' });
  });

  it('stores an unreferenced commit without treating the missing key as an error', async () => {
    const webhook = await request(app.getHttpServer())
      .post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', 'us6.1-unlinked-commit')
      .send({
        provider: 'github',
        event_type: 'push',
        repository: 'cadena/platform',
        commit: { sha: 'no-reference-sha', message: 'docs: clarify local setup' },
      })
      .expect(201);

    expect(webhook.body.artifacts).toHaveLength(1);
    expect(webhook.body.linked_work_item_keys).toEqual([]);
    expect(webhook.body.unresolved_keys).toEqual([]);
  });
});
