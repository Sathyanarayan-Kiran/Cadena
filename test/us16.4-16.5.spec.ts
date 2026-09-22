import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { ConnectorService } from '../src/modules/connectors/connector.service';
import { JiraConnectorAdapter } from '../src/modules/connectors/jira-connector.adapter';
import { ServiceNowConnectorAdapter } from '../src/modules/connectors/servicenow-connector.adapter';
import { FakeJiraApi, FakeServiceNowApi } from '../src/modules/connectors/sandbox/provider-sandbox';
import { EventOutboxService } from '../src/modules/events/event-outbox.service';

process.env.US164_JIRA_TOKEN = 'jira-token-value';
process.env.US164_SNOW_PASSWORD = 'snow-password-value';

describe('US16.4/US16.5 — durable per-twin FIFO queues and failure isolation', () => {
  let app: INestApplication;
  let connectors: ConnectorService;
  const database = DatabaseService.getInstance();

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    connectors = app.get(ConnectorService);
  });

  afterAll(async () => {
    connectors.registerAdapter(new JiraConnectorAdapter());
    connectors.registerAdapter(new ServiceNowConnectorAdapter());
    if (app) await app.close();
  });

  const http = () => request(app.getHttpServer());
  const headers = (orgId: string, actor = 'queue-operator') => ({ 'x-org-id': orgId, 'x-actor-id': actor });
  const jiraConfig = (name = 'Jira Queue') => ({
    name,
    provider: 'jira',
    baseUrl: 'https://acme.atlassian.net',
    authType: 'basic',
    credentials: { apiToken: 'env:US164_JIRA_TOKEN' },
    options: { accountEmail: 'sync@acme.test' },
    projectKeys: ['CAD'],
    writeBack: { state: true },
  });
  const snowConfig = () => ({
    name: 'ServiceNow Queue',
    provider: 'servicenow',
    baseUrl: 'https://acme.service-now.com',
    authType: 'basic',
    credentials: { password: 'env:US164_SNOW_PASSWORD' },
    options: { username: 'svc.cadena' },
    tableNames: ['incident'],
  });

  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    await http().post(`/integrations/connectors/${created.body.id}/test`).set(headers(orgId)).expect(201);
    await http().post(`/integrations/connectors/${created.body.id}/discover`).set(headers(orgId)).expect(201);
    await http().post(`/integrations/connectors/${created.body.id}/activate`).set(headers(orgId)).expect(201);
    return created.body.id as string;
  };

  it('executes one twin strictly in source order while an unrelated twin proceeds, using an expiring database lease', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    const firstIssue = jira.addIssue({ key: 'CAD-1601', summary: 'Ordered twin', status: 'To Do' });
    const otherIssue = jira.addIssue({ key: 'CAD-1602', summary: 'Independent twin', status: 'To Do' });
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    const connectorId = await onboard(orgId, jiraConfig());
    await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
    const twins = (await http().get(`/integrations/connectors/${connectorId}/twins`).set(headers(orgId)).expect(200)).body;
    const orderedTwin = twins.find((twin: any) => twin.externalId === firstIssue.id);
    const independentTwin = twins.find((twin: any) => twin.externalId === otherIssue.id);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstWriteStarted = false;
    const selectiveTransport = async (url: string, init: any) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST' && path === `/rest/api/3/issue/${firstIssue.id}/transitions`) {
        firstWriteStarted = true;
        await firstGate;
      }
      return jira.fetch(url, init);
    };
    connectors.registerAdapter(new JiraConnectorAdapter(selectiveTransport));

    const first = http().post(`/workspace/twins/${orderedTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'state', value: 'In Progress' }).then((response) => response);
    await vi.waitFor(() => expect(firstWriteStarted).toBe(true));

    const later = await http().post(`/workspace/twins/${orderedTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'state', value: 'Done' }).expect(201);
    expect(later.body.workOrder).toMatchObject({ status: 'pending', attempts: 0 });
    expect(later.body.message).toMatch(/queued behind earlier work/);

    const independent = await http().post(`/workspace/twins/${independentTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'state', value: 'In Review' }).expect(201);
    expect(independent.body.workOrder.status).toBe('executed');
    expect(jira.issues.get(otherIssue.id)?.status).toBe('In Review');

    releaseFirst();
    expect((await first).body.workOrder.status).toBe('executed');
    // Simulate a process stopping after it claimed the queued successor. An already-running
    // replica must reclaim the expired row without needing another application bootstrap.
    await database.db.query(
      `UPDATE integration_connector_work_orders
       SET status = 'processing', claimed_by = 'stopped-replica',
           claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE id = $1`,
      [later.body.workOrder.id],
    );
    await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
    expect(jira.issues.get(firstIssue.id)?.status).toBe('Done');
    const orders = (await http().get(`/integrations/connectors/${connectorId}/work-orders`).set(headers(orgId)).expect(200)).body;
    const ordered = orders.filter((order: any) => order.targetTwinId === orderedTwin.id)
      .sort((left: any, right: any) => left.queuePosition - right.queuePosition);
    expect(ordered.map((order: any) => [order.targetState, order.status])).toEqual([
      ['In Progress', 'executed'],
      ['Done', 'executed'],
    ]);

    await database.db.query(
      `INSERT INTO integration_connector_sync_leases
       (connector_id, org_id, lease_owner, acquired_at, expires_at)
       VALUES ($1, $2, 'other-replica', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [connectorId, orgId],
    );
    await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(409);
    await database.db.query(
      `UPDATE integration_connector_sync_leases SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE connector_id = $1`,
      [connectorId],
    );
    await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
  });

  it('pauses only the failed twin, exposes its payload/error/history, and re-injects correction at the same FIFO position', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    const blockedIssue = jira.addIssue({ key: 'CAD-1651', summary: 'Needs correction', status: 'To Do' });
    const healthyIssue = jira.addIssue({ key: 'CAD-1652', summary: 'Keeps moving', status: 'To Do' });
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    const connectorId = await onboard(orgId, jiraConfig('Jira DLQ'));
    await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
    const twins = (await http().get(`/integrations/connectors/${connectorId}/twins`).set(headers(orgId)).expect(200)).body;
    const blockedTwin = twins.find((twin: any) => twin.externalId === blockedIssue.id);
    const healthyTwin = twins.find((twin: any) => twin.externalId === healthyIssue.id);

    jira.unavailableTransitions.add('In Review');
    const dead = await http().post(`/workspace/twins/${blockedTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'state', value: 'In Review' }).expect(201);
    expect(dead.body.workOrder).toMatchObject({ status: 'dead', attempts: 1 });
    const behind = await http().post(`/workspace/twins/${blockedTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'state', value: 'Done' }).expect(201);
    expect(behind.body.workOrder.status).toBe('pending');
    const healthy = await http().post(`/workspace/twins/${healthyTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'state', value: 'Done' }).expect(201);
    expect(healthy.body.workOrder.status).toBe('executed');

    const detail = await http().get(`/workspace/twins/${blockedTwin.id}`).set(headers(orgId)).expect(200);
    expect(detail.body.syncState).toBe('paused');
    const dlq = await http().get(`/integrations/connectors/${connectorId}/twin-dlq`).set(headers(orgId)).expect(200);
    expect(dlq.body).toHaveLength(1);
    expect(dlq.body[0]).toMatchObject({
      id: dead.body.workOrder.id,
      kind: 'state_write',
      status: 'dead',
      payload: { targetState: 'In Review', fields: {} },
      attempts: 1,
      attemptHistory: [expect.objectContaining({ outcome: 'dead_lettered' })],
      lastError: expect.stringContaining("no available transition to 'In Review'"),
    });
    await http().get(`/integrations/connectors/${connectorId}/twin-dlq/${dlq.body[0].id}`)
      .set(headers(randomUUID())).expect(404);

    jira.unavailableTransitions.delete('In Review');
    const replayed = await http().post(`/integrations/connectors/${connectorId}/twin-dlq/${dlq.body[0].id}/reinject`)
      .set(headers(orgId)).send({ payload: { targetState: 'In Review', fields: {} } }).expect(201);
    expect(replayed.body).toMatchObject({ requeued: true, status: 'pending', kind: 'state_write' });
    await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
    expect(jira.issues.get(blockedIssue.id)?.status).toBe('Done');
    expect((await http().get(`/integrations/connectors/${connectorId}/twin-dlq`).set(headers(orgId))).body).toEqual([]);

    const orders = (await http().get(`/integrations/connectors/${connectorId}/work-orders`).set(headers(orgId))).body;
    const recovered = orders.find((order: any) => order.id === dead.body.workOrder.id);
    expect(recovered.status).toBe('executed');
    expect(recovered.attemptHistory.map((attempt: any) => attempt.outcome)).toEqual([
      'dead_lettered', 'requeued', 'executed',
    ]);
    const queue = orders.filter((order: any) => order.targetTwinId === blockedTwin.id)
      .sort((left: any, right: any) => left.queuePosition - right.queuePosition);
    expect(queue.map((order: any) => order.targetState)).toEqual(['In Review', 'Done']);
  });

  it('advances the source watermark around a malformed record, then recovers it from the twin DLQ', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    jira.addIssue({ key: 'CAD-1660', summary: 'Healthy record', status: 'To Do' });
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    const connectorId = await onboard(orgId, jiraConfig('Jira Ingestion Isolation'));
    const malformedId = randomUUID();
    const malformed = {
      externalId: '', artifactType: 'issue', title: 'Malformed', status: 'To Do', fields: {},
      updatedAt: '2026-09-22T09:00:00.000Z',
    };
    await database.db.query(
      `INSERT INTO integration_connector_ingestion_queue
       (id, org_id, connector_id, partition_key, entity_type, external_id, dedupe_key, payload, status)
       VALUES ($1, $2, $3, 'jira:issue:malformed', 'issue', '', 'malformed-record', $4, 'pending')`,
      [malformedId, orgId, connectorId, JSON.stringify(malformed)],
    );

    const first = await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
    expect(first.body.recordErrors).toEqual([
      expect.objectContaining({ message: 'Provider record has no immutable id' }),
    ]);
    const healthy = await http().get(`/integrations/connectors/${connectorId}/twins`).set(headers(orgId)).expect(200);
    expect(healthy.body.map((twin: any) => twin.nativeKey)).toContain('CAD-1660');
    expect((await http().get(`/integrations/connectors/${connectorId}/health`).set(headers(orgId))).body.status).toBe('degraded');

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await database.db.query(
        `UPDATE integration_connector_ingestion_queue
         SET next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`,
        [malformedId],
      );
      await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
    }
    const dlq = await http().get(`/integrations/connectors/${connectorId}/twin-dlq`).set(headers(orgId)).expect(200);
    const entry = dlq.body.find((candidate: any) => candidate.id === malformedId);
    expect(entry).toMatchObject({ kind: 'ingestion', status: 'dead', attempts: 5 });
    expect(entry.attemptHistory).toHaveLength(5);

    const corrected = {
      externalId: 'recovered-record', artifactType: 'issue', title: 'Recovered record', status: 'To Do',
      fields: { summary: 'Recovered record', status: 'To Do' },
      fieldAuthority: { summary: 'jira', status: 'jira' },
      updatedAt: '2026-09-22T09:10:00.000Z',
    };
    await http().post(`/integrations/connectors/${connectorId}/twin-dlq/${malformedId}/reinject`)
      .set(headers(orgId)).send({ payload: corrected }).expect(201);
    await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);
    const recovered = await database.db.query<any>(
      `SELECT status, attempt_history FROM integration_connector_ingestion_queue WHERE id = $1`,
      [malformedId],
    );
    expect(recovered.rows[0].status).toBe('completed');
    const history = typeof recovered.rows[0].attempt_history === 'string'
      ? JSON.parse(recovered.rows[0].attempt_history) : recovered.rows[0].attempt_history;
    expect(history.at(-2).outcome).toBe('requeued');
    expect(history.at(-1).outcome).toBe('completed');
    const twins = (await http().get(`/integrations/connectors/${connectorId}/twins`).set(headers(orgId))).body;
    expect(twins.find((twin: any) => twin.externalId === 'recovered-record')).toMatchObject({ title: 'Recovered record' });
  });

  it('recovers a committed twin change from the transactional outbox after the dispatch gap', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    const snow = new FakeServiceNowApi();
    const issue = jira.addIssue({ key: 'CAD-1670', summary: 'Outbox target', status: 'To Do' });
    const incident = snow.addRecord('incident', { short_description: 'Outbox source', state: '1' });
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snow.fetch));
    const jiraId = await onboard(orgId, jiraConfig('Jira Outbox'));
    const snowId = await onboard(orgId, snowConfig());
    await http().post(`/integrations/connectors/${jiraId}/sync`).set(headers(orgId)).expect(201);
    await http().post(`/integrations/connectors/${snowId}/sync`).set(headers(orgId)).expect(201);
    await http().post('/integrations/correlations').set(headers(orgId)).send({
      source: { system: 'servicenow', entity_type: 'incident', immutable_id: incident.sys_id },
      target: { system: 'jira', entity_type: 'issue', immutable_id: issue.id },
      relationship: 'counterpart',
    }).expect(201);
    const mapping = await http().post('/integrations/state-mappings').set(headers(orgId)).send({
      name: 'Outbox recovery mapping',
      source: { system: 'servicenow', entity_type: 'incident' },
      target: { system: 'jira', entity_type: 'issue' },
      rules: [{ direction: 'source_to_target', from_state: 'In Progress', to_state: 'In Progress' }],
    }).expect(201);
    await http().post(`/integrations/state-mappings/${mapping.body.id}/publish`).set(headers(orgId)).expect(201);
    const sourceTwin = (await http().get(`/integrations/connectors/${snowId}/twins`).set(headers(orgId))).body[0];
    const outbox = new EventOutboxService();
    const committed = await database.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE integration_canonical_twins SET native_status = 'In Progress', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND org_id = $2`,
        [sourceTwin.id, orgId],
      );
      return outbox.enqueue(tx, {
        event_type: 'CanonicalTwinUpdated',
        work_item_id: sourceTwin.id,
        org_id: orgId,
        actor: { type: 'integration', id: `connector:${snowId}` },
        payload: {
          org_id: orgId,
          twin_id: sourceTwin.id,
          connector_id: snowId,
          identity: { system: 'servicenow', entity_type: 'incident', immutable_id: incident.sys_id },
          native_status: 'In Progress',
          correlation_node_id: sourceTwin.correlationNodeId,
          state_changed: true,
          title: sourceTwin.title,
          fields: sourceTwin.payload,
          updated_by: 'servicenow:agent',
        },
      });
    });
    expect(jira.issues.get(issue.id)?.status).toBe('To Do');
    expect((await database.db.query<any>(`SELECT status FROM event_outbox WHERE event_id = $1`, [committed.event_id])).rows[0].status)
      .toBe('pending');

    await outbox.recoverPending();
    expect(jira.issues.get(issue.id)?.status).toBe('In Progress');
    const recovered = await database.db.query<any>(
      `SELECT source_event_id, status FROM integration_connector_work_orders WHERE source_event_id = $1`,
      [committed.event_id],
    );
    expect(recovered.rows).toEqual([{ source_event_id: committed.event_id, status: 'executed' }]);
    expect((await database.db.query<any>(`SELECT status FROM event_outbox WHERE event_id = $1`, [committed.event_id])).rows[0].status)
      .toBe('dispatched');
  });
});
