import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US4.2 — Upstream Lineage Traversal Query', () => {
  let app: INestApplication;

  const orgId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const teamId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('US4.2: queries full upstream lineage chain in order', async () => {
    // 1. Create Epic (Top ancestor)
    const epicRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Epic: Authentication Redesign',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);
    const epicId = epicRes.body.id;

    // 2. Create Story linked child_of Epic
    const storyRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story: Implement OAuth Tokens',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);
    const storyId = storyRes.body.id;

    await request(app.getHttpServer())
      .post(`/workitems/${storyId}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: epicId, link_type: 'child_of' })
      .expect(201);

    // 3. Create Bug/Task (Fix) linked child_of Story
    const fixRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Bug Fix PR: Token Expiration Fix',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);
    const fixId = fixRes.body.id;

    await request(app.getHttpServer())
      .post(`/workitems/${fixId}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: storyId, link_type: 'child_of' })
      .expect(201);

    // 4. Create Incident linked fixed_by to Fix
    const incidentRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Incident: Token Validation Failure',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);
    const incidentId = incidentRes.body.id;

    await request(app.getHttpServer())
      .post(`/workitems/${incidentId}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: fixId, link_type: 'fixed_by' })
      .expect(201);

    // 5. Query upstream lineage GET /workitems/{incidentId}/lineage?direction=up
    const lineageRes = await request(app.getHttpServer())
      .get(`/workitems/${incidentId}/lineage?direction=up`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(lineageRes.body.root_id).toBe(incidentId);
    expect(lineageRes.body.direction).toBe('up');

    const chainTitles = lineageRes.body.chain.map((node: any) => node.title);
    expect(chainTitles).toEqual([
      'Incident: Token Validation Failure',
      'Bug Fix PR: Token Expiration Fix',
      'Story: Implement OAuth Tokens',
      'Epic: Authentication Redesign',
    ]);

    // Downstream traversal follows the inverse semantic direction.
    const downstreamRes = await request(app.getHttpServer())
      .get(`/workitems/${epicId}/lineage?direction=down`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(downstreamRes.body.chain.map((node: any) => node.title)).toEqual([
      'Epic: Authentication Redesign',
      'Story: Implement OAuth Tokens',
      'Bug Fix PR: Token Expiration Fix',
      'Incident: Token Validation Failure',
    ]);
  });
});
