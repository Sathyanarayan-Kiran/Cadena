import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US6.3 — Deployment and release traceability', () => {
  let app: INestApplication;
  const orgId = '63000000-0000-0000-0000-000000000001';
  const teamId = '63000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('links a successful deployment to its Story and Release and advances the Release', async () => {
    const release = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'release', title: 'Release 2.3.1', team_id: teamId, org_id: orgId })
      .expect(201);
    const story = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Deployment traceability', team_id: teamId, org_id: orgId })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/workitems/${release.body.id}/transitions`)
      .set('x-org-id', orgId)
      .send({ to_state: 'Ready' })
      .expect(201);

    const payload = {
      provider: 'github',
      event_type: 'deployment',
      repository: 'cadena/platform',
      deployment: {
        id: 'deploy-2.3.1-production',
        environment: 'production',
        status: 'success',
        release_key: release.body.key,
        work_item_keys: [story.body.key],
        url: 'https://ci.example/deployments/2.3.1',
      },
    };

    const webhook = await request(app.getHttpServer())
      .post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', 'us6.3-deployment')
      .send(payload)
      .expect(201);

    expect(webhook.body.linked_work_item_keys).toEqual(
      expect.arrayContaining([release.body.key, story.body.key]),
    );
    expect(webhook.body.transitions[0]).toMatchObject({
      work_item_key: release.body.key,
      from_state: 'Ready',
      to_state: 'Deployed',
      outcome: 'applied',
    });

    const updatedRelease = await request(app.getHttpServer())
      .get(`/workitems/${release.body.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(updatedRelease.body.status).toBe('Deployed');

    for (const item of [release.body, story.body]) {
      const links = await request(app.getHttpServer())
        .get(`/workitems/${item.id}/external-links`)
        .set('x-org-id', orgId)
        .expect(200);
      expect(links.body).toHaveLength(1);
      expect(links.body[0]).toMatchObject({
        artifact_type: 'deployment',
        external_id: 'deploy-2.3.1-production',
        link_type: 'deployed_in',
      });
    }

    const duplicate = await request(app.getHttpServer())
      .post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', 'us6.3-deployment')
      .send(payload)
      .expect(201);
    expect(duplicate.body.duplicate).toBe(true);
    expect(duplicate.body.transitions[0].outcome).toBe('applied');
  });
});
