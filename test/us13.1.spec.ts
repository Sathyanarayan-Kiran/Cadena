import { beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US13.1 — configurable ITIL/Agile state translation', () => {
  let app: INestApplication;
  const database = DatabaseService.getInstance();

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  const headers = (orgId: string, actor = 'mapping-admin') => ({
    'x-org-id': orgId,
    'x-actor-id': actor,
  });

  const snow = (suffix: string) => ({
    system: 'servicenow', entity_type: 'incident', immutable_id: `snow-${suffix}`,
  });

  const jira = (suffix: string) => ({
    system: 'jira', entity_type: 'issue', immutable_id: `jira-${suffix}`,
  });

  const createPair = async (orgId: string, suffix: string) => {
    const response = await request(app.getHttpServer())
      .post('/integrations/correlations')
      .set(headers(orgId))
      .send({ source: snow(suffix), target: jira(suffix), relationship: 'counterpart' })
      .expect(201);
    return response.body;
  };

  const createDraft = (orgId: string, rules: Record<string, unknown>[], name = 'Incident delivery lifecycle') =>
    request(app.getHttpServer())
      .post('/integrations/state-mappings')
      .set(headers(orgId))
      .send({
        name,
        source: { system: 'ServiceNow', entity_type: 'Incident' },
        target: { system: 'Jira', entity_type: 'Issue' },
        rules,
      });

  const publish = (orgId: string, id: string) => request(app.getHttpServer())
    .post(`/integrations/state-mappings/${id}/publish`)
    .set(headers(orgId));

  const translate = (orgId: string, body: Record<string, unknown>) => request(app.getHttpServer())
    .post('/integrations/state-mappings/translate')
    .set(headers(orgId, 'integration:state-sync'))
    .send(body);

  it('versions and publishes a bidirectional matrix, then previews both directions without a write', async () => {
    const orgId = randomUUID();
    await createPair(orgId, 'bidirectional');
    const rules = [
      {
        direction: 'source_to_target',
        from_state: 'New',
        to_state: 'To Do',
        required_target_fields: ['priority'],
        allowed_target_from_states: ['Backlog', 'To Do'],
      },
      {
        direction: 'target_to_source',
        from_state: 'Done',
        to_state: 'Resolved',
        required_target_fields: ['resolution.code'],
        allowed_target_from_states: ['In Progress'],
      },
    ];
    const draft = await createDraft(orgId, rules).expect(201);
    expect(draft.body).toMatchObject({
      version: 1,
      status: 'draft',
      source: { system: 'servicenow', entity_type: 'incident' },
      target: { system: 'jira', entity_type: 'issue' },
    });
    expect(draft.body.rules).toHaveLength(2);

    const active = await publish(orgId, draft.body.id).expect(201);
    expect(active.body).toMatchObject({ version: 1, status: 'published', published_by: 'mapping-admin' });

    const forward = await translate(orgId, {
      source_identity: snow('bidirectional'),
      target_identity: jira('bidirectional'),
      source_state: 'new',
      current_target_state: 'Backlog',
      target_fields: { priority: 'High' },
      dry_run: true,
    }).expect(201);
    expect(forward.body).toMatchObject({
      transaction_id: null,
      dry_run: true,
      action: 'enqueue_connector_write',
      status: 'ready',
      reason: 'mapped',
      direction: 'source_to_target',
      mapped_target_state: 'To Do',
      mapping: { id: draft.body.id, version: 1 },
    });

    const reverse = await translate(orgId, {
      source_identity: jira('bidirectional'),
      target_identity: snow('bidirectional'),
      source_state: 'DONE',
      current_target_state: 'In Progress',
      target_fields: { resolution: { code: 'Solved (Permanently)' } },
    }).expect(201);
    expect(reverse.body).toMatchObject({
      transaction_id: null,
      dry_run: true,
      direction: 'target_to_source',
      mapped_target_state: 'Resolved',
      status: 'ready',
    });

    const noPreviewWrites = await request(app.getHttpServer())
      .get('/integrations/state-mappings/transactions')
      .set(headers(orgId))
      .expect(200);
    expect(noPreviewWrites.body).toEqual([]);

    const secondDraft = await createDraft(orgId, [
      { direction: 'source_to_target', from_state: 'New', to_state: 'Selected for Development' },
      { direction: 'target_to_source', from_state: 'Done', to_state: 'Resolved' },
    ], 'Incident delivery lifecycle revised').expect(201);
    expect(secondDraft.body.version).toBe(2);
    await publish(orgId, secondDraft.body.id).expect(201);

    const definitions = await request(app.getHttpServer())
      .get('/integrations/state-mappings')
      .set(headers(orgId))
      .expect(200);
    expect(definitions.body.map((row: any) => [row.version, row.status])).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
    await publish(orgId, draft.body.id)
      .expect(409)
      .expect((response) => expect(response.body.message).toContain('superseded'));

    const otherTenant = await request(app.getHttpServer())
      .get('/integrations/state-mappings')
      .set(headers(randomUUID()))
      .expect(200);
    expect(otherTenant.body).toEqual([]);
  });

  it('holds missing fields, unmapped states and invalid jumps, while persisting the valid connector work order', async () => {
    const orgId = randomUUID();
    await createPair(orgId, 'decisions');
    const draft = await createDraft(orgId, [
      {
        direction: 'source_to_target',
        from_state: 'Resolved',
        to_state: 'Done',
        required_target_fields: ['resolution.code', 'resolution.notes'],
        allowed_target_from_states: ['In Progress'],
      },
    ]).expect(201);
    await publish(orgId, draft.body.id).expect(201);

    const base = {
      source_identity: snow('decisions'),
      target_identity: jira('decisions'),
      source_state: 'Resolved',
      current_target_state: 'In Progress',
      dry_run: false,
    };
    const missing = await translate(orgId, {
      ...base,
      target_fields: { resolution: { code: 'Solved' } },
    }).expect(201);
    expect(missing.body).toMatchObject({
      action: 'hold_for_review',
      status: 'held',
      reason: 'missing_required_fields',
      mapped_target_state: 'Done',
      missing_target_fields: ['resolution.notes'],
    });
    expect(missing.body.transaction_id).toMatch(/^[0-9a-f-]{36}$/);

    const invalidJump = await translate(orgId, {
      ...base,
      current_target_state: 'Closed',
      target_fields: { resolution: { code: 'Solved', notes: 'Verified in production' } },
    }).expect(201);
    expect(invalidJump.body).toMatchObject({
      status: 'held', reason: 'invalid_target_transition', mapped_target_state: 'Done',
    });
    expect(invalidJump.body.message).toContain("Target is in 'Closed'");

    const unmapped = await translate(orgId, {
      ...base,
      source_state: 'Awaiting Vendor',
      target_fields: {},
    }).expect(201);
    expect(unmapped.body).toMatchObject({ status: 'held', reason: 'unmapped_state' });
    expect(unmapped.body.message).toContain("Awaiting Vendor");

    const ready = await translate(orgId, {
      ...base,
      target_fields: { resolution: { code: 'Solved', notes: 'Verified in production' } },
    }).expect(201);
    expect(ready.body).toMatchObject({
      action: 'enqueue_connector_write',
      status: 'ready',
      reason: 'mapped',
      direction: 'source_to_target',
      mapped_target_state: 'Done',
      mapping: { id: draft.body.id, version: 1 },
    });

    const transactions = await request(app.getHttpServer())
      .get('/integrations/state-mappings/transactions?limit=10')
      .set(headers(orgId))
      .expect(200);
    expect(transactions.body).toHaveLength(4);
    expect(transactions.body.map((row: any) => row.reason).sort()).toEqual([
      'invalid_target_transition', 'mapped', 'missing_required_fields', 'unmapped_state',
    ]);
    expect(transactions.body.find((row: any) => row.reason === 'mapped')).toMatchObject({
      mapping_definition_id: draft.body.id,
      mapping_version: 1,
      required_target_fields: ['resolution.code', 'resolution.notes'],
      status: 'ready',
    });

    const events = await database.db.query<any>(
      `SELECT event_type, actor_id, payload FROM domain_events
       WHERE org_id = $1 AND event_type LIKE 'IntegrationStateChange%'
       ORDER BY occurred_at ASC, event_id ASC`,
      [orgId],
    );
    expect(events.rows.map((row) => row.event_type).sort()).toEqual([
      'IntegrationStateChangeHeld',
      'IntegrationStateChangeHeld',
      'IntegrationStateChangeHeld',
      'IntegrationStateChangePrepared',
    ].sort());
    expect(events.rows.find((row) => row.event_type === 'IntegrationStateChangePrepared')).toMatchObject({
      actor_id: 'integration:state-sync',
      payload: expect.objectContaining({
        mapping_id: draft.body.id,
        mapping_version: 1,
        decision: 'enqueue_connector_write',
        mapped_target_state: 'Done',
      }),
    });
  });

  it('records an actionable hold without a matrix and rejects uncorrelated or invalid configuration', async () => {
    const orgId = randomUUID();
    const first = await createPair(orgId, 'missing-map-a');
    await createPair(orgId, 'missing-map-b');

    const missingMapping = await translate(orgId, {
      source_identity: snow('missing-map-a'),
      target_identity: jira('missing-map-a'),
      source_state: 'Assigned',
      dry_run: false,
    }).expect(201);
    expect(missingMapping.body).toMatchObject({
      mapping: null,
      status: 'held',
      reason: 'mapping_not_found',
      action: 'hold_for_review',
    });
    expect(missingMapping.body.message).toContain('No published state mapping');

    await translate(orgId, {
      source_identity: snow('missing-map-a'),
      target_identity: jira('missing-map-b'),
      source_state: 'Assigned',
    }).expect(409)
      .expect((response) => expect(response.body.message).toContain('not linked as immutable counterparts'));

    await translate(randomUUID(), {
      source_identity: snow('missing-map-a'),
      target_identity: jira('missing-map-a'),
      source_state: 'Assigned',
    }).expect(404);

    await createDraft(orgId, [
      { direction: 'source_to_target', from_state: 'New', to_state: 'To Do' },
      { direction: 'source_to_target', from_state: 'new', to_state: 'Backlog' },
    ]).expect(422)
      .expect((response) => expect(response.body.message).toContain('duplicate source_to_target'));

    // The immutable nodes remain distinct and tenant-scoped; the API never falls back to keys.
    expect(first.source.immutable_id).toBe('snow-missing-map-a');
  });
});

