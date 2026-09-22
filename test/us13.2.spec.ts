import { beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US13.2 — immutable correlation references', () => {
  let app: INestApplication;
  const database = DatabaseService.getInstance();

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  const pair = (orgId: string, body: Record<string, unknown>, actor = 'integration:jira-sync') =>
    request(app.getHttpServer())
      .post('/integrations/correlations')
      .set('x-org-id', orgId)
      .set('x-actor-id', actor)
      .send(body);

  const resolve = (orgId: string, system: string, entityType: string, immutableId: string, depth = 10) =>
    request(app.getHttpServer())
      .get('/integrations/correlations/resolve')
      .set('x-org-id', orgId)
      .query({ system, entity_type: entityType, immutable_id: immutableId, depth });

  it('stores both dedicated references and keeps resolving by immutable id after rename or move', async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const created = await pair(orgId, {
      source: {
        system: 'ServiceNow', entity_type: 'incident', immutable_id: '8b31-sys-id',
        display_key: 'INC0010042', url: 'https://snow.example/nav/old',
      },
      target: {
        system: 'Jira', entity_type: 'issue', immutable_id: '1004821',
        display_key: 'ENG-4821', url: 'https://jira.example/browse/ENG-4821',
      },
      relationship: 'counterpart',
    }).expect(201);

    expect(created.body).toMatchObject({
      created: true,
      source: { system: 'servicenow', immutable_id: '8b31-sys-id', display_key: 'INC0010042' },
      target: { system: 'jira', immutable_id: '1004821', display_key: 'ENG-4821' },
      link: {
        relationship: 'counterpart',
        references: {
          source: { field: 'cadena_counterpart_id', value: '1004821' },
          target: { field: 'cadena_counterpart_id', value: '8b31-sys-id' },
        },
      },
    });

    // A connector may send the pair in the opposite direction after a move. The immutable
    // identity finds the same nodes/link while mutable keys and deep links are refreshed.
    const moved = await pair(orgId, {
      source: {
        system: 'jira', entity_type: 'issue', immutable_id: '1004821',
        display_key: 'PLATFORM-77', url: 'https://jira.example/browse/PLATFORM-77',
      },
      target: {
        system: 'servicenow', entity_type: 'incident', immutable_id: '8b31-sys-id',
        display_key: 'INC0010042', url: 'https://snow.example/nav/new',
      },
      relationship: 'counterpart',
    }).expect(201);

    expect(moved.body.created).toBe(false);
    expect(moved.body.link.id).toBe(created.body.link.id);
    expect(moved.body.source).toMatchObject({ id: created.body.target.id, display_key: 'PLATFORM-77' });
    expect(moved.body.target).toMatchObject({ id: created.body.source.id, url: 'https://snow.example/nav/new' });

    const graph = await resolve(orgId, 'JIRA', 'ISSUE', '1004821').expect(200);
    expect(graph.body).toMatchObject({
      root: { id: created.body.target.id, immutable_id: '1004821', display_key: 'PLATFORM-77' },
      summary: { node_count: 2, link_count: 1, direct_counterparts: 1, max_distance: 1 },
    });
    expect(graph.body.nodes.find((node: any) => node.system === 'servicenow')).toMatchObject({
      immutable_id: '8b31-sys-id',
      url: 'https://snow.example/nav/new',
    });

    await request(app.getHttpServer())
      .patch(`/integrations/correlations/nodes/${created.body.target.id}`)
      .set('x-org-id', orgId)
      .send({ immutable_id: 'replacement', display_key: 'FORBIDDEN-1' })
      .expect(422)
      .expect((response) => expect(response.body.message).toContain('immutable_id is immutable'));

    const metadataOnly = await request(app.getHttpServer())
      .patch(`/integrations/correlations/nodes/${created.body.target.id}`)
      .set('x-org-id', orgId)
      .set('x-actor-id', 'integration:jira-sync')
      .send({ display_key: 'PLATFORM-78', url: 'https://jira.example/browse/PLATFORM-78' })
      .expect(200);
    expect(metadataOnly.body).toMatchObject({
      id: created.body.target.id,
      immutable_id: '1004821',
      display_key: 'PLATFORM-78',
    });

    await resolve(otherOrgId, 'jira', 'issue', '1004821').expect(404);

    const events = await database.db.query<any>(
      `SELECT event_type, actor_id, payload FROM domain_events
       WHERE org_id = $1 AND event_type LIKE 'Correlation%'
       ORDER BY occurred_at ASC`,
      [orgId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'CorrelationPairCreated',
      'CorrelationPairResolved',
      'CorrelationMetadataUpdated',
    ]);
    expect(events.rows[0].actor_id).toBe('integration:jira-sync');
  });

  it('resolves one-to-many and many-to-one trees without permitting orphaned dependencies', async () => {
    const orgId = randomUUID();
    const root = { system: 'servicenow', entity_type: 'problem', immutable_id: 'problem-root' };
    const jiraA = { system: 'jira', entity_type: 'issue', immutable_id: 'jira-a' };
    const jiraB = { system: 'jira', entity_type: 'issue', immutable_id: 'jira-b' };
    const adoTask = { system: 'azure-devops', entity_type: 'task', immutable_id: 'ado-task-9' };

    const first = await pair(orgId, { source: root, target: jiraA, relationship: 'parent_child' }).expect(201);
    await pair(orgId, { source: root, target: jiraB, relationship: 'parent_child' }).expect(201);
    await pair(orgId, { source: adoTask, target: jiraB, relationship: 'depends_on' }).expect(201);

    const direct = await resolve(orgId, 'servicenow', 'problem', 'problem-root', 1).expect(200);
    expect(direct.body.summary).toMatchObject({ node_count: 3, link_count: 2, max_distance: 1 });
    expect(direct.body.nodes.map((node: any) => node.immutable_id).sort()).toEqual([
      'jira-a', 'jira-b', 'problem-root',
    ]);

    const expanded = await resolve(orgId, 'servicenow', 'problem', 'problem-root', 2).expect(200);
    expect(expanded.body.summary).toMatchObject({ node_count: 4, link_count: 3, max_distance: 2 });
    expect(expanded.body.nodes.find((node: any) => node.immutable_id === 'ado-task-9')).toMatchObject({
      distance: 2,
    });

    // Tenant-qualified restrictive foreign keys are the last line of defence against a
    // dependency silently becoming an orphan even if a future connector bypasses the API.
    await expect(database.db.query(
      `DELETE FROM integration_correlation_nodes WHERE id = $1 AND org_id = $2`,
      [first.body.source.id, orgId],
    )).rejects.toThrow();
    await resolve(orgId, 'servicenow', 'problem', 'problem-root', 2).expect(200);

    await resolve(orgId, 'servicenow', 'problem', 'problem-root', 0)
      .expect(422)
      .expect((response) => expect(response.body.message).toContain('depth must be an integer'));
  });
});
