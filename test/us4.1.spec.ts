import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US4.1 — Typed Links Between Work Items', () => {
  let app: INestApplication;

  const orgId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const teamId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('US4.1: creates valid typed link and exposes in both items relationship lists', async () => {
    // 1. Create a Story (Item A) and an Incident (Item B)
    const storyRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Feature Story A',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    const incidentRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Production Outage B',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    const storyId = storyRes.body.id;
    const incidentId = incidentRes.body.id;

    // 2. Create typed link: Incident B was `caused_by` Story A
    const linkRes = await request(app.getHttpServer())
      .post(`/workitems/${incidentId}/links`)
      .set('x-org-id', orgId)
      .send({
        target_id: storyId,
        link_type: 'caused_by',
      })
      .expect(201);

    expect(linkRes.body.source_id).toBe(incidentId);
    expect(linkRes.body.target_id).toBe(storyId);
    expect(linkRes.body.link_type).toBe('caused_by');

    // 3. Verify link appears in Incident B relationship list (as outgoing link)
    const relB = await request(app.getHttpServer())
      .get(`/workitems/${incidentId}/links`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(relB.body.outgoing.some((l: any) => l.target_id === storyId && l.link_type === 'caused_by')).toBe(true);

    // 4. Verify link appears in Story A relationship list (as incoming link)
    const relA = await request(app.getHttpServer())
      .get(`/workitems/${storyId}/links`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(relA.body.incoming.some((l: any) => l.source_id === incidentId && l.link_type === 'caused_by')).toBe(true);
  });

  it('US4.1: rejects invalid edge type for item pair with allowed edge types', async () => {
    // 1. Create two Incidents
    const inc1 = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Incident 1',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    const inc2 = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Incident 2',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    // 2. Attempt invalid edge `deployed_in` between two Incidents
    const res = await request(app.getHttpServer())
      .post(`/workitems/${inc1.body.id}/links`)
      .set('x-org-id', orgId)
      .send({
        target_id: inc2.body.id,
        link_type: 'deployed_in',
      })
      .expect(422);

    expect(res.body.error).toBe('invalid_edge_type');
    expect(res.body.message).toContain("Edge type 'deployed_in' is not allowed between 'incident' and 'incident'");
    expect(res.body.allowed_edge_types).toBeDefined();
    expect(res.body.allowed_edge_types).not.toContain('deployed_in');
  });
});
