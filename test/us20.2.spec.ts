import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import { ConnectorService } from '../src/modules/connectors/connector.service';
import { JiraConnectorAdapter } from '../src/modules/connectors/jira-connector.adapter';
import { ServiceNowConnectorAdapter } from '../src/modules/connectors/servicenow-connector.adapter';
import { FakeJiraApi, FakeServiceNowApi } from '../src/modules/connectors/sandbox/provider-sandbox';

process.env.US202_JIRA_TOKEN = 'jira-token-value';
process.env.US202_SNOW_PASSWORD = 'snow-password-value';

describe('US20.2 — connector-led management workspace', () => {
  let app: INestApplication;
  let connectors: ConnectorService;
  const database = DatabaseService.getInstance();
  const originalMode = process.env.CADENA_INTERACTION_MODE;

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    connectors = app.get(ConnectorService);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.CADENA_INTERACTION_MODE;
    else process.env.CADENA_INTERACTION_MODE = originalMode;
  });

  afterAll(async () => {
    connectors.registerAdapter(new JiraConnectorAdapter());
    connectors.registerAdapter(new ServiceNowConnectorAdapter());
    if (app) await app.close();
  });

  const http = () => request(app.getHttpServer());
  const headers = (orgId: string, actor = 'ops.lead') => ({ 'x-org-id': orgId, 'x-actor-id': actor });

  const jiraConfig = (overrides: Record<string, unknown> = {}) => ({
    name: 'Jira Cloud',
    provider: 'jira',
    baseUrl: 'https://acme.atlassian.net',
    credentials: { apiToken: 'env:US202_JIRA_TOKEN' },
    options: { accountEmail: 'sync@acme.test' },
    projectKeys: ['CAD'],
    ...overrides,
  });

  const snowConfig = (overrides: Record<string, unknown> = {}) => ({
    name: 'ServiceNow ITSM',
    provider: 'servicenow',
    baseUrl: 'https://acme.service-now.com',
    credentials: { password: 'env:US202_SNOW_PASSWORD' },
    options: { username: 'svc.cadena' },
    tableNames: ['incident'],
    ...overrides,
  });

  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    const id = created.body.id as string;
    await http().post(`/integrations/connectors/${id}/test`).set(headers(orgId)).expect(201);
    await http().post(`/integrations/connectors/${id}/discover`).set(headers(orgId)).expect(201);
    await http().post(`/integrations/connectors/${id}/activate`).set(headers(orgId)).expect(201);
    await http().post(`/integrations/connectors/${id}/sync`).set(headers(orgId)).expect(201);
    return id;
  };

  /** Two connected sources, one correlated pair and a published lifecycle mapping. */
  const scenario = async (jiraOverrides: Record<string, unknown> = {}) => {
    const jira = new FakeJiraApi();
    const snow = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snow.fetch));
    const orgId = randomUUID();
    const issue = jira.addIssue({ key: 'CAD-42', summary: 'Checkout latency', status: 'In Progress', priority: 'High' });
    const incident = snow.addRecord('incident', { short_description: 'Checkout slow', state: '2' });
    const jiraId = await onboard(orgId, jiraConfig(jiraOverrides));
    const snowId = await onboard(orgId, snowConfig());
    await http().post('/integrations/correlations').set(headers(orgId)).send({
      source: { system: 'servicenow', entity_type: 'incident', immutable_id: incident.sys_id },
      target: { system: 'jira', entity_type: 'issue', immutable_id: issue.id },
    }).expect(201);
    const draft = await http().post('/integrations/state-mappings').set(headers(orgId)).send({
      name: 'Delivery lifecycle',
      source: { system: 'servicenow', entity_type: 'incident' },
      target: { system: 'jira', entity_type: 'issue' },
      rules: [{ direction: 'target_to_source', from_state: 'Done', to_state: 'Resolved' }],
    }).expect(201);
    await http().post(`/integrations/state-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(201);
    const twins = (await http().get('/workspace/twins').set(headers(orgId)).expect(200)).body;
    const jiraTwin = twins.find((twin: any) => twin.provider === 'jira');
    const snowTwin = twins.find((twin: any) => twin.provider === 'servicenow');
    return { jira, snow, orgId, issue, incident, jiraId, snowId, jiraTwin, snowTwin };
  };

  const auditTypes = async (subjectId: string) => (await database.db.query<any>(
    `SELECT event_type, actor_id, payload FROM domain_events WHERE work_item_id = $1 ORDER BY occurred_at`,
    [subjectId],
  )).rows;

  it('derives the interaction mode from the runtime and refuses demo-only modes outside local', () => {
    const staging = {
      CADENA_RUNTIME_MODE: 'staging',
      DATABASE_URL: 'postgresql://cadena:secret@db.internal:5432/cadena',
      CADENA_DATABASE_SSL: 'verify-full',
      CADENA_BOOTSTRAP_TOKEN: 'x'.repeat(40),
    };
    expect(loadRuntimeConfig({}).interactionMode).toBe('pilot');
    expect(loadRuntimeConfig(staging).interactionMode).toBe('connector-led');
    expect(loadRuntimeConfig({ ...staging, CADENA_INTERACTION_MODE: 'standalone' }).interactionMode).toBe('standalone');
    expect(() => loadRuntimeConfig({ ...staging, CADENA_INTERACTION_MODE: 'pilot' })).toThrow(/forbids CADENA_INTERACTION_MODE=pilot/);
    expect(() => loadRuntimeConfig({ ...staging, CADENA_CONNECTOR_SANDBOX: 'enabled' })).toThrow(/forbids CADENA_CONNECTOR_SANDBOX/);
    expect(() => loadRuntimeConfig({ CADENA_INTERACTION_MODE: 'kanban' })).toThrow(/must be connector-led, pilot, or standalone/);
    expect(loadRuntimeConfig({ CADENA_CONNECTOR_SANDBOX: 'enabled' }).connectorSandbox).toBe(true);
  });

  it('refuses local work-item creation and backlog import in connector-led mode only', async () => {
    const orgId = randomUUID();
    const item = { type: 'story', title: 'Local story', team_id: '00000000-0000-0000-0000-000000000001' };

    process.env.CADENA_INTERACTION_MODE = 'connector-led';
    const config = await http().get('/workspace/config').set(headers(orgId)).expect(200);
    expect(config.body).toMatchObject({ interactionMode: 'connector-led', localCreation: false, pilotActions: false });
    const refused = await http().post('/workitems').set(headers(orgId)).send(item).expect(403);
    expect(refused.body.message).toMatch(/connector-led mode/);
    await http().post('/workitems/import-backlog').set(headers(orgId)).send({}).expect(403);
    expect((await http().get('/workitems').set(headers(orgId)).expect(200)).body).toHaveLength(0);

    process.env.CADENA_INTERACTION_MODE = 'standalone';
    expect((await http().get('/workspace/config').set(headers(orgId))).body).toMatchObject({ localCreation: true, pilotActions: false });
    await http().post('/workitems').set(headers(orgId)).send(item).expect(201);

    delete process.env.CADENA_INTERACTION_MODE;
    expect((await http().get('/workspace/config').set(headers(orgId))).body).toMatchObject({ interactionMode: 'pilot', localCreation: true, pilotActions: true });
  });

  it('summarizes source health, lag, twin counts and write-back queues for the landing view', async () => {
    const empty = await http().get('/workspace/overview').set(headers(randomUUID())).expect(200);
    expect(empty.body.totals).toEqual({ sources: 0, healthy: 0, attention: 0, twins: 0, maxLagSeconds: 0, queuedWrites: 0, failedWrites: 0 });

    const { orgId, jira } = await scenario();
    const healthy = await http().get('/workspace/overview').set(headers(orgId)).expect(200);
    expect(healthy.body.totals).toMatchObject({ sources: 2, healthy: 2, attention: 0, twins: 2, queuedWrites: 0, failedWrites: 0 });
    expect(healthy.body.sources.map((source: any) => source.name).sort()).toEqual(['Jira Cloud', 'ServiceNow ITSM']);

    // A second connector over the same Jira project cannot own its records and degrades.
    jira.editIssue(Array.from(jira.issues.keys())[0], { summary: 'Touched' });
    await onboard(orgId, jiraConfig({ name: 'Overlapping Jira' }));
    const degraded = await http().get('/workspace/overview').set(headers(orgId)).expect(200);
    expect(degraded.body.totals).toMatchObject({ sources: 3, healthy: 2, attention: 1 });
    expect(degraded.body.sources.find((source: any) => source.name === 'Overlapping Jira')).toMatchObject({
      status: 'degraded',
      errorMessage: expect.stringContaining('already managed by connector'),
    });
  });

  it('shows provenance, native links, sync state, field authority and counterparts for each twin', async () => {
    const { orgId, jiraTwin, snowTwin, incident, issue } = await scenario();
    expect(jiraTwin).toMatchObject({
      provider: 'jira',
      nativeKey: 'CAD-42',
      nativeUrl: 'https://acme.atlassian.net/browse/CAD-42',
      title: 'Checkout latency',
      status: 'In Progress',
      syncState: 'synced',
      connectorName: 'Jira Cloud',
      connectorStatus: 'active',
      fieldAuthority: expect.objectContaining({ summary: 'jira', status: 'jira' }),
      queuedWrites: 0,
      failedWrites: 0,
    });
    expect(Date.parse(jiraTwin.lastSuccessAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(jiraTwin.counterparts).toEqual([expect.objectContaining({
      system: 'servicenow', immutableId: incident.sys_id, displayKey: incident.number, twinId: snowTwin.id, status: 'In Progress',
    })]);
    expect(snowTwin.counterparts).toEqual([expect.objectContaining({ system: 'jira', immutableId: issue.id, displayKey: 'CAD-42', twinId: jiraTwin.id })]);

    const detail = await http().get(`/workspace/twins/${jiraTwin.id}`).set(headers(orgId)).expect(200);
    const state = detail.body.fields.find((field: any) => field.field === 'state');
    expect(state).toMatchObject({ nativeField: 'status', authority: 'jira', editable: false, reason: 'write_back_disabled', value: 'In Progress' });
    expect(state.message).toMatch(/State write-back is disabled for Jira Cloud/);
    expect(detail.body.fields.find((field: any) => field.field === 'summary')).toMatchObject({
      label: 'Summary', authority: 'jira', editable: false, reason: 'no_outbound_mapping', value: 'Checkout latency',
    });
    expect(detail.body.workOrders).toEqual([]);

    const otherOrg = randomUUID();
    await http().get(`/workspace/twins/${jiraTwin.id}`).set(headers(otherOrg)).expect(404);
    await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(otherOrg)).send({ field: 'state', value: 'Done' }).expect(404);
    expect((await http().get('/workspace/twins').set(headers(otherOrg)).expect(200)).body).toEqual([]);
  });

  it('blocks edits without a permitted outbound mapping, explains ownership, and audits the refusal', async () => {
    const { orgId, jira, issue, jiraTwin, jiraId } = await scenario();
    const summary = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'summary', value: 'Renamed locally' }).expect(422);
    expect(summary.body).toMatchObject({ decision: 'blocked', reason: 'no_outbound_mapping', authority: 'jira' });
    expect(summary.body.message).toMatch(/Jira owns Summary/);

    const state = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'status', value: 'Done' }).expect(422);
    expect(state.body).toMatchObject({ decision: 'blocked', reason: 'write_back_disabled' });

    const unknownField = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId))
      .send({ field: 'story_points', value: '8' }).expect(422);
    expect(unknownField.body.reason).toBe('no_outbound_mapping');

    // Nothing reached Jira and nothing changed locally.
    expect(jira.countRequests('POST', '/transitions')).toBe(0);
    const after = await http().get(`/workspace/twins/${jiraTwin.id}`).set(headers(orgId)).expect(200);
    expect(after.body).toMatchObject({ title: 'Checkout latency', status: 'In Progress', syncState: 'synced' });
    expect(jira.issues.get(issue.id)!.summary).toBe('Checkout latency');

    const audit = await auditTypes(jiraTwin.id);
    expect(audit.filter((event: any) => event.event_type === 'TwinEditBlocked').map((event: any) => event.payload.reason))
      .toEqual(['no_outbound_mapping', 'write_back_disabled', 'no_outbound_mapping']);
    expect(audit.every((event: any) => event.event_type !== 'TwinEditBlocked' || event.actor_id === 'ops.lead')).toBe(true);

    await http().post(`/integrations/connectors/${jiraId}/write-back`).set(headers(orgId)).send({ summary: true }).expect(400);
  });

  it('routes a permitted state change through an audited work order, propagates it, and suppresses its echo', async () => {
    const { orgId, jira, snow, issue, incident, jiraTwin, snowId, jiraId } = await scenario();
    const enabled = await http().post(`/integrations/connectors/${jiraId}/write-back`).set(headers(orgId)).send({ state: true }).expect(201);
    expect(enabled.body.config.writeBack).toEqual({ state: true, fields: [] });
    const policy = (await http().get(`/workspace/twins/${jiraTwin.id}`).set(headers(orgId))).body.fields[0];
    expect(policy).toMatchObject({ editable: true, reason: 'write_back_enabled', allowedValues: ['To Do', 'In Progress', 'In Review', 'Done'] });

    await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId)).send({ field: 'state', value: 'Shipped' }).expect(422)
      .then((response) => expect(response.body.reason).toBe('invalid_value'));
    const noop = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId)).send({ field: 'state', value: 'in progress' }).expect(201);
    expect(noop.body).toMatchObject({ decision: 'noop' });

    const routed = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId)).send({ field: 'state', value: 'done' }).expect(201);
    expect(routed.body).toMatchObject({
      decision: 'routed',
      value: 'Done',
      workOrder: { origin: 'operator_edit', requestedBy: 'ops.lead', status: 'executed', targetState: 'Done', transactionId: null },
      propagation: { prepared: 1, executed: 1, held: 0 },
    });
    expect(jira.issues.get(issue.id)!.status).toBe('Done');
    expect(snow.tables.get('incident')!.get(incident.sys_id)!.state).toBe('6');

    // The twin is not mutated locally; it reflects the source after the next synchronization.
    const beforeSync = await http().get(`/workspace/twins/${jiraTwin.id}`).set(headers(orgId)).expect(200);
    expect(beforeSync.body.status).toBe('In Progress');
    expect(beforeSync.body.workOrders[0]).toMatchObject({ origin: 'operator_edit', status: 'executed' });
    const jiraPoll = await http().post(`/integrations/connectors/${jiraId}/sync`).set(headers(orgId)).expect(201);
    expect(jiraPoll.body).toMatchObject({ twinsUpdated: 1, echoesSuppressed: 1, workOrdersPrepared: 0 });
    const snowPoll = await http().post(`/integrations/connectors/${snowId}/sync`).set(headers(orgId)).expect(201);
    expect(snowPoll.body).toMatchObject({ echoesSuppressed: 1, workOrdersPrepared: 0 });
    expect(snow.countRequests('PATCH', '/api/now/table/incident')).toBe(1);
    expect((await http().get(`/workspace/twins/${jiraTwin.id}`).set(headers(orgId))).body.status).toBe('Done');

    const audit = await auditTypes(jiraTwin.id);
    expect(audit.find((event: any) => event.event_type === 'TwinEditRouted')?.payload).toMatchObject({ field: 'state', before: 'In Progress', after: 'Done' });
  });

  it('keeps failed and refused write-backs visible and refuses edits while the source is paused', async () => {
    const { orgId, jira, issue, jiraTwin, jiraId } = await scenario({ writeBack: { state: true } });
    jira.failNext('POST', `/rest/api/3/issue/${issue.id}/transitions`, 503);
    const retrying = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId)).send({ field: 'state', value: 'In Review' }).expect(201);
    expect(retrying.body.workOrder).toMatchObject({ status: 'failed', attempts: 1 });
    expect(retrying.body.message).toMatch(/will be retried/);

    const rows = (await http().get('/workspace/twins').set(headers(orgId)).expect(200)).body;
    expect(rows.find((row: any) => row.id === jiraTwin.id)).toMatchObject({ queuedWrites: 1, failedWrites: 0 });
    const overview = await http().get('/workspace/overview').set(headers(orgId)).expect(200);
    expect(overview.body.totals).toMatchObject({ queuedWrites: 1, attention: 1 });

    jira.unavailableTransitions.add('To Do');
    const refused = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId)).send({ field: 'state', value: 'To Do' }).expect(201);
    // The later edit cannot overtake the retrying head of this twin's FIFO queue.
    expect(refused.body.workOrder.status).toBe('pending');
    expect(refused.body.message).toMatch(/queued behind earlier work/);
    expect((await http().get('/workspace/overview').set(headers(orgId))).body.totals.failedWrites).toBe(0);

    await database.db.query(
      `UPDATE integration_connector_work_orders SET next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE id = $1`,
      [retrying.body.workOrder.id],
    );
    await http().post(`/integrations/connectors/${jiraId}/sync`).set(headers(orgId)).expect(201);
    const settled = await http().get(`/integrations/connectors/${jiraId}/work-orders`).set(headers(orgId)).expect(200);
    expect(settled.body.find((order: any) => order.id === retrying.body.workOrder.id).status).toBe('executed');
    expect(settled.body.find((order: any) => order.id === refused.body.workOrder.id).status).toBe('dead');
    // The refused Jira write and the intentionally unmapped counterpart propagation are both visible.
    expect((await http().get('/workspace/overview').set(headers(orgId))).body.totals.failedWrites).toBe(2);

    await http().post(`/integrations/connectors/${jiraId}/pause`).set(headers(orgId)).expect(201);
    const paused = await http().post(`/workspace/twins/${jiraTwin.id}/edits`).set(headers(orgId)).send({ field: 'state', value: 'Done' }).expect(422);
    expect(paused.body).toMatchObject({ reason: 'connector_unavailable' });
    expect(paused.body.message).toMatch(/is paused/);
  });
});
