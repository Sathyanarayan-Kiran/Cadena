import { beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US10.4 — complete work-item audit export', () => {
  let app: INestApplication;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const teamId = randomUUID();
  const creatorId = randomUUID();
  const editorId = randomUUID();

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('exports creation, field edits, links and state changes with actors and before/after values', async () => {
    const item = (await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .set('x-actor-id', creatorId)
      .send({ type: 'story', title: 'Original title', priority: 'P2', team_id: teamId, org_id: orgId })
      .expect(201)).body;
    const epic = (await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'epic', title: 'Parent epic', team_id: teamId, org_id: orgId })
      .expect(201)).body;

    await request(app.getHttpServer())
      .patch(`/workitems/${item.id}`)
      .set('x-org-id', orgId)
      .set('x-actor-id', editorId)
      .send({ title: 'Auditable title', priority: 'P1', custom_fields: { risk: 'high' } })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ title: 'Auditable title', priority: 'P1', custom_fields: { risk: 'high' } });
      });

    await request(app.getHttpServer())
      .post(`/workitems/${item.id}/links`)
      .set('x-org-id', orgId)
      .set('x-actor-id', editorId)
      .send({ target_id: epic.id, link_type: 'child_of' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/workitems/${item.id}/transitions`)
      .set('x-org-id', orgId)
      .set('x-actor-id', editorId)
      .set('x-actor-role', 'Developer')
      .send({ to_state: 'Planned' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/audit/export?work_item_id=${item.id}`)
      .set('x-org-id', orgId)
      .set('x-actor-id', editorId)
      .expect(200);

    expect(response.headers['content-disposition']).toContain(`${item.key}-audit-trail.json`);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      schema: 'cadena.audit-trail.v1',
      org_id: orgId,
      generated_by: editorId,
      work_item: { id: item.id, key: item.key, title: 'Auditable title', status: 'Planned' },
      event_count: 4,
    });
    expect(response.body.events.map((event: any) => event.event_type)).toEqual([
      'WorkItemCreated', 'WorkItemFieldsChanged', 'LinkCreated', 'WorkItemStateChanged',
    ]);

    const created = response.body.events[0];
    expect(created.actor).toEqual({ type: 'user', id: creatorId });
    expect(created.before).toBeNull();
    expect(created.after).toMatchObject({ id: item.id, title: 'Original title', priority: 'P2' });
    const edited = response.body.events[1];
    expect(edited.actor.id).toBe(editorId);
    expect(edited.before).toMatchObject({ title: 'Original title', priority: 'P2', custom_fields: {} });
    expect(edited.after).toMatchObject({ title: 'Auditable title', priority: 'P1', custom_fields: { risk: 'high' } });
    const linked = response.body.events[2];
    expect(linked.before).toBeNull();
    expect(linked.after).toMatchObject({ source_id: item.id, target_id: epic.id, link_type: 'child_of' });
    const transitioned = response.body.events[3];
    expect(transitioned.before).toEqual({ status: 'Proposed' });
    expect(transitioned.after).toEqual({ status: 'Planned' });
    expect(transitioned.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const incoming = await request(app.getHttpServer())
      .get(`/audit/workitems/${epic.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(incoming.body.events.map((event: any) => event.event_type)).toEqual(['WorkItemCreated', 'LinkCreated']);
  });

  it('enforces tenant and mutation boundaries without revealing cross-tenant items', async () => {
    const item = (await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Tenant private', team_id: teamId, org_id: orgId })
      .expect(201)).body;

    await request(app.getHttpServer())
      .get(`/audit/export?work_item_id=${item.id}`)
      .set('x-org-id', otherOrgId)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/workitems/${item.id}`)
      .set('x-org-id', otherOrgId)
      .send({ title: 'Should not change' })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/workitems/${item.id}`)
      .set('x-org-id', orgId)
      .send({ status: 'Done' })
      .expect(422);
    await request(app.getHttpServer())
      .get('/audit/export')
      .set('x-org-id', orgId)
      .expect(400);
  });
});
