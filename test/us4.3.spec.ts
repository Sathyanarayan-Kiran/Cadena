import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US4.3 — Downstream impact analysis from a Service', () => {
  let app: INestApplication;
  const orgId = '43000000-0000-0000-0000-000000000001';
  const teamId = '43000000-0000-0000-0000-000000000002';
  const otherOrgId = '43000000-0000-0000-0000-00000000000f';

  const server = () => app.getHttpServer();

  let serviceId: string;
  let serviceKey: string;
  const items: Record<string, { id: string; key: string }> = {};

  async function createItem(alias: string, type: string, title: string, extra: object = {}) {
    const response = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type, title, team_id: teamId, org_id: orgId, ...extra })
      .expect(201);
    items[alias] = { id: response.body.id, key: response.body.key };
    return response.body;
  }

  async function link(sourceAlias: string, targetAlias: string, linkType: string) {
    await request(server())
      .post(`/workitems/${items[sourceAlias].id}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: items[targetAlias].id, link_type: linkType })
      .expect(201);
  }

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const service = await request(server())
      .post('/services')
      .set('x-org-id', orgId)
      .send({ name: 'Checkout API', service_key: 'checkout-api', owner_team_id: teamId, environment: 'production' })
      .expect(201);
    serviceId = service.body.id;
    serviceKey = service.body.service_key;

    // An outage on Checkout API, traced back to the release that caused it and the work
    // implicated by that release:  SVC <-affects- INC -caused_by-> REL <-deployed_in- STORY -child_of-> EPIC
    await createItem('incident', 'incident', 'Checkout API returning 503s', { severity: 'SEV1', priority: 'P0' });
    await createItem('release', 'release', 'Release 4.2.0');
    await createItem('story', 'story', 'Swap checkout connection pool');
    await createItem('epic', 'epic', 'Checkout resilience');
    await createItem('unrelated', 'story', 'Unrelated reporting work');

    await request(server())
      .post(`/services/${serviceId}/work-items`)
      .set('x-org-id', orgId)
      .send({ work_item_id: items.incident.id })
      .expect(201);

    await link('incident', 'release', 'caused_by');
    await link('story', 'release', 'deployed_in');
    await link('story', 'epic', 'child_of');
  });

  it('returns every work item implicated by the Service within the requested depth', async () => {
    const response = await request(server())
      .get(`/services/${serviceId}/impact?depth=4`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(response.body.service.service_key).toBe(serviceKey);
    expect(response.body.depth).toBe(4);

    const byKey = Object.fromEntries(
      response.body.impacted.map((node: any) => [node.work_item.key, node]),
    );
    expect(Object.keys(byKey).sort()).toEqual(
      [items.incident.key, items.release.key, items.story.key, items.epic.key].sort(),
    );
    expect(byKey[items.unrelated.key]).toBeUndefined();

    expect(byKey[items.incident.key].distance).toBe(1);
    expect(byKey[items.release.key].distance).toBe(2);
    expect(byKey[items.story.key].distance).toBe(3);
    expect(byKey[items.epic.key].distance).toBe(4);

    expect(response.body.summary).toMatchObject({
      total: 4,
      by_type: { incident: 1, release: 1, story: 1, epic: 1 },
      open_incidents: 1,
      highest_severity: 'SEV1',
    });
  });

  it('explains why each item is implicated through its edge chain', async () => {
    const response = await request(server())
      .get(`/services/${serviceId}/impact?depth=3`)
      .set('x-org-id', orgId)
      .expect(200);

    const story = response.body.impacted.find((node: any) => node.work_item.key === items.story.key);
    expect(story.via).toEqual([
      { link_type: 'affects', from_key: serviceKey, to_key: items.incident.key },
      { link_type: 'caused_by', from_key: items.incident.key, to_key: items.release.key },
      { link_type: 'deployed_in', from_key: items.story.key, to_key: items.release.key },
    ]);
  });

  it('honours the depth bound so a query can stay close to the outage', async () => {
    const shallow = await request(server())
      .get(`/services/${serviceId}/impact?depth=1`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(shallow.body.impacted.map((node: any) => node.work_item.key)).toEqual([items.incident.key]);
    expect(shallow.body.summary.by_type).toEqual({ incident: 1 });

    const twoHops = await request(server())
      .get(`/services/${serviceId}/impact?depth=2`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(twoHops.body.impacted.map((node: any) => node.work_item.key).sort())
      .toEqual([items.incident.key, items.release.key].sort());

    // Depth defaults to 3 and is clamped to the documented maximum.
    const defaulted = await request(server())
      .get(`/services/${serviceId}/impact`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(defaulted.body.depth).toBe(3);

    const clamped = await request(server())
      .get(`/services/${serviceId}/impact?depth=99`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(clamped.body.depth).toBe(10);

    const invalid = await request(server())
      .get(`/services/${serviceId}/impact?depth=deep`)
      .set('x-org-id', orgId)
      .expect(422);
    expect(invalid.body.message).toContain('depth must be a whole number');
  });

  it('filters the traversal to named edge types', async () => {
    const response = await request(server())
      .get(`/services/${serviceId}/impact?depth=4&edge_types=caused_by`)
      .set('x-org-id', orgId)
      .expect(200);

    // The release is still reachable, but the story hangs off a deployed_in edge that is excluded.
    expect(response.body.impacted.map((node: any) => node.work_item.key).sort())
      .toEqual([items.incident.key, items.release.key].sort());
  });

  it('scopes impact analysis to the owning tenant', async () => {
    await request(server())
      .get(`/services/${serviceId}/impact`)
      .set('x-org-id', otherOrgId)
      .expect(404);

    await request(server()).get(`/services/${serviceId}/impact`).expect(400);

    await request(server())
      .post(`/services/${serviceId}/work-items`)
      .set('x-org-id', otherOrgId)
      .send({ work_item_id: items.incident.id })
      .expect(404);

    const missingBody = await request(server())
      .post(`/services/${serviceId}/work-items`)
      .set('x-org-id', orgId)
      .send({})
      .expect(422);
    expect(missingBody.body.message).toContain('work_item_id is required');
  });

  it('reflects incident resolution in the impact summary', async () => {
    for (const [state, role] of [['Investigating', 'on_call'], ['Mitigated', 'on_call'], ['Resolved', 'incident_commander']]) {
      await request(server())
        .post(`/workitems/${items.incident.id}/transitions`)
        .set('x-org-id', orgId)
        .set('x-actor-role', role)
        .send({ to_state: state, fields: { mitigation_summary: 'Connection pool resized.' } })
        .expect(201);
    }

    const response = await request(server())
      .get(`/services/${serviceId}/impact?depth=4`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(response.body.summary.total).toBe(4);
    expect(response.body.summary.open_incidents).toBe(0);
  });
});
