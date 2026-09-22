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
import { SecretManagerResolver } from '../src/modules/connectors/secret-manager-ref';
import { ConnectorCredentialError } from '../src/modules/connectors/connector-http';
import { FakeJiraApi, FakeServiceNowApi } from './fixtures/fake-connector-apis';

process.env.US171_JIRA_TOKEN = 'jira-token-value';
process.env.SECRET_SNOW_PROD_PASSWORD = 'snow-password-value';

describe('US17.1 — native connectors, discovery and connector-led ingestion', () => {
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
    // Restore live-guarded default adapters for any later suite sharing the process.
    connectors.registerAdapter(new JiraConnectorAdapter());
    connectors.registerAdapter(new ServiceNowConnectorAdapter());
    if (app) await app.close();
  });

  const http = () => request(app.getHttpServer());
  const headers = (orgId: string, actor = 'integration-admin') => ({ 'x-org-id': orgId, 'x-actor-id': actor });

  const jiraConfig = (overrides: Record<string, unknown> = {}) => ({
    name: 'Jira Cloud',
    provider: 'jira',
    baseUrl: 'https://acme.atlassian.net',
    authType: 'basic',
    credentials: { apiToken: 'env:US171_JIRA_TOKEN' },
    options: { accountEmail: 'sync@acme.test', customFieldIds: ['customfield_10014'] },
    projectKeys: ['CAD'],
    ...overrides,
  });

  const snowConfig = (overrides: Record<string, unknown> = {}) => ({
    name: 'ServiceNow ITSM',
    provider: 'servicenow',
    baseUrl: 'https://acme.service-now.com',
    authType: 'basic',
    credentials: { password: 'secret-ref://snow/prod-password' },
    options: { username: 'svc.cadena' },
    tableNames: ['incident'],
    ...overrides,
  });

  const useFakes = () => {
    const jira = new FakeJiraApi();
    const snow = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snow.fetch));
    return { jira, snow };
  };

  /** Registers, tests, discovers and activates a connector; returns its id. */
  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    const id = created.body.id as string;
    const tested = await http().post(`/integrations/connectors/${id}/test`).set(headers(orgId)).expect(201);
    expect(tested.body).toMatchObject({ success: true, status: 'connected' });
    const discovered = await http().post(`/integrations/connectors/${id}/discover`).set(headers(orgId)).expect(201);
    expect(discovered.body.capabilityReport.ready).toBe(true);
    await http().post(`/integrations/connectors/${id}/activate`).set(headers(orgId)).expect(201);
    return id;
  };

  const sync = (orgId: string, id: string) => http().post(`/integrations/connectors/${id}/sync`).set(headers(orgId));

  it('accepts only resolvable secret references and fails closed', () => {
    expect(SecretManagerResolver.validateReferences({ apiToken: 'env:US171_JIRA_TOKEN', password: 'secret-ref://snow/prod-password' }))
      .toEqual({ apiToken: 'env:US171_JIRA_TOKEN', password: 'secret-ref://snow/prod-password' });
    expect(() => SecretManagerResolver.validateReferences({ apiToken: 'my-plaintext-token' })).toThrow(ConnectorCredentialError);
    expect(() => SecretManagerResolver.validateReferences({ apiToken: 'my-plaintext-token' })).not.toThrow(/my-plaintext-token/);

    const resolver = new SecretManagerResolver();
    expect(resolver.resolve('apiToken', 'env:US171_JIRA_TOKEN')).toBe('jira-token-value');
    // secret-ref://snow/prod-password is projected as SECRET_SNOW_PROD_PASSWORD.
    expect(resolver.resolve('password', 'secret-ref://snow/prod-password')).toBe('snow-password-value');
    expect(() => resolver.resolve('apiToken', 'env:US171_UNSET_VARIABLE')).toThrow(/could not be resolved/);
    expect(() => resolver.resolve('apiToken', 'secret-ref://missing/entry')).toThrow(/could not be resolved/);
  });

  it('refuses unusable registrations before anything is stored', async () => {
    useFakes();
    const orgId = randomUUID();
    const providers = await http().get('/integrations/connectors/providers').set(headers(orgId)).expect(200);
    expect(providers.body.map((provider: any) => provider.provider).sort()).toEqual(['jira', 'servicenow']);

    const plaintext = await http().post('/integrations/connectors').set(headers(orgId))
      .send(jiraConfig({ credentials: { apiToken: 'super-secret-token-123' } })).expect(400);
    expect(plaintext.body.message).toMatch(/must be a secret reference/);
    expect(JSON.stringify(plaintext.body)).not.toContain('super-secret-token-123');

    const unsupported = await http().post('/integrations/connectors').set(headers(orgId))
      .send(jiraConfig({ provider: 'zendesk' })).expect(400);
    expect(unsupported.body.message).toMatch(/not available.*jira, servicenow/);

    await http().post('/integrations/connectors').set(headers(orgId)).send(jiraConfig({ projectKeys: ['bad key'] })).expect(400);
    await http().post('/integrations/connectors').set(headers(orgId)).send(jiraConfig({ projectKeys: [] })).expect(400);
    await http().post('/integrations/connectors').set(headers(orgId))
      .send(jiraConfig({ options: { accountEmail: 'sync@acme.test', apiToken: 'leaked' } })).expect(400);
    await http().post('/integrations/connectors').set(headers(orgId)).send(snowConfig({ tableNames: ['Incident Table'] })).expect(400);

    const list = await http().get('/integrations/connectors').set(headers(orgId)).expect(200);
    expect(list.body).toEqual([]);

    await http().post('/integrations/connectors').set(headers(orgId)).send(jiraConfig()).expect(201);
    await http().post('/integrations/connectors').set(headers(orgId)).send(jiraConfig()).expect(409);
  });

  it('never opens a network connection unless live connector HTTP is explicitly enabled', async () => {
    connectors.registerAdapter(new JiraConnectorAdapter());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const orgId = randomUUID();
    try {
      const created = await http().post('/integrations/connectors').set(headers(orgId)).send(jiraConfig()).expect(201);
      const tested = await http().post(`/integrations/connectors/${created.body.id}/test`).set(headers(orgId)).expect(201);
      expect(tested.body).toMatchObject({ success: false, status: 'error' });
      expect(tested.body.message).toMatch(/Live connector HTTP is disabled/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('discovers Jira projects, fields, custom fields and statuses through the native REST API', async () => {
    const { jira } = useFakes();
    const orgId = randomUUID();
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(jiraConfig()).expect(201);
    expect(created.body).toMatchObject({ status: 'unconfigured', config: { credentials: { apiToken: 'env:US171_JIRA_TOKEN' } } });
    const id = created.body.id;

    const tested = await http().post(`/integrations/connectors/${id}/test`).set(headers(orgId)).expect(201);
    expect(tested.body).toMatchObject({ success: true, status: 'connected', account: 'Cadena Sync' });
    const expectedAuth = `Basic ${Buffer.from('sync@acme.test:jira-token-value').toString('base64')}`;
    expect(jira.requests[0]).toMatchObject({ method: 'GET', path: '/rest/api/3/myself' });
    expect(jira.requests[0].headers.Authorization).toBe(expectedAuth);

    const discovered = await http().post(`/integrations/connectors/${id}/discover`).set(headers(orgId)).expect(201);
    expect(discovered.body.scopes).toEqual([{ id: 'CAD', name: 'Cadena Delivery', entityType: 'issue', found: true }]);
    const issue = discovered.body.entities.find((entity: any) => entity.entityType === 'issue');
    expect(issue.fields.find((field: any) => field.id === 'summary')).toMatchObject({ required: true, custom: false });
    expect(issue.fields.find((field: any) => field.id === 'customfield_10014')).toMatchObject({ name: 'Epic Link', custom: true });
    expect(issue.fields.find((field: any) => field.id === 'status').allowedValues).toEqual(['To Do', 'In Progress', 'In Review', 'Done']);
    expect(discovered.body.capabilityReport).toMatchObject({ ready: true, limitations: [] });
    expect(jira.requests.map((r) => r.path)).toEqual(expect.arrayContaining([
      '/rest/api/3/project/search', '/rest/api/3/field', '/rest/api/3/status',
    ]));

    const current = await http().get(`/integrations/connectors/${id}`).set(headers(orgId)).expect(200);
    expect(current.body.status).toBe('discovered');
    await sync(orgId, id).expect(409);

    const activated = await http().post(`/integrations/connectors/${id}/activate`).set(headers(orgId)).expect(201);
    expect(activated.body.status).toBe('active');
    expect(activated.body.activatedAt).toBeDefined();
  });

  it('reports missing scopes and required fields before activation instead of failing during sync', async () => {
    const { snow } = useFakes();
    const orgId = randomUUID();
    const created = await http().post('/integrations/connectors').set(headers(orgId))
      .send(jiraConfig({ projectKeys: ['CAD', 'GHOST'], requiredFields: { issue: ['customfield_99999', 'summary'] } }))
      .expect(201);
    const discovered = await http().post(`/integrations/connectors/${created.body.id}/discover`).set(headers(orgId)).expect(201);
    expect(discovered.body.capabilityReport.ready).toBe(false);
    expect(discovered.body.capabilityReport.limitations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scope_not_found', severity: 'blocking', message: expect.stringContaining('GHOST') }),
      expect.objectContaining({ code: 'field_not_found', severity: 'blocking', field: 'customfield_99999' }),
    ]));
    expect(discovered.body.capabilityReport.limitations.some((item: any) => item.field === 'summary')).toBe(false);

    const refused = await http().post(`/integrations/connectors/${created.body.id}/activate`).set(headers(orgId)).expect(422);
    expect(refused.body.limitations.length).toBe(2);
    await sync(orgId, created.body.id).expect(409);

    const snowCreated = await http().post('/integrations/connectors').set(headers(orgId))
      .send(snowConfig({ tableNames: ['incident', 'u_legacy_ticket'] })).expect(201);
    const snowDiscovered = await http().post(`/integrations/connectors/${snowCreated.body.id}/discover`).set(headers(orgId)).expect(201);
    expect(snowDiscovered.body.scopes).toEqual([
      expect.objectContaining({ id: 'incident', found: true }),
      expect.objectContaining({ id: 'u_legacy_ticket', found: false }),
    ]);
    const incident = snowDiscovered.body.entities.find((entity: any) => entity.entityType === 'incident');
    // Inherited task columns are discovered alongside table-specific and custom (u_) columns.
    expect(incident.fields.find((field: any) => field.id === 'state')).toMatchObject({
      allowedValues: ['New', 'In Progress', 'On Hold', 'Resolved', 'Closed'],
      allowedValueCodes: ['1', '2', '3', '6', '7'],
    });
    expect(incident.fields.find((field: any) => field.id === 'short_description').required).toBe(true);
    expect(incident.fields.find((field: any) => field.id === 'u_business_service').custom).toBe(true);
    await http().post(`/integrations/connectors/${snowCreated.body.id}/activate`).set(headers(orgId)).expect(422);
    expect(snow.countRequests('GET', '/api/now/table/sys_dictionary')).toBe(2);
  });

  it('pages through Jira changes under a watermark and materializes each record exactly once', async () => {
    const { jira } = useFakes();
    const orgId = randomUUID();
    for (let index = 1; index <= 120; index++) {
      jira.addIssue({
        key: `CAD-${index}`,
        summary: `Imported story ${index}`,
        status: 'To Do',
        custom: { customfield_10014: 'CAD-EPIC-1' },
      });
    }
    jira.addIssue({ key: 'OPS-1', summary: 'Out of scope', status: 'To Do' });
    const id = await onboard(orgId, jiraConfig({ options: { accountEmail: 'sync@acme.test', maxPagesPerPoll: 1, customFieldIds: ['customfield_10014'] } }));

    const first = await sync(orgId, id).expect(201);
    expect(first.body).toMatchObject({ fetchedCount: 100, twinsCreated: 100, hasMore: true });
    const lagging = await http().get(`/integrations/connectors/${id}/health`).set(headers(orgId)).expect(200);
    expect(lagging.body.syncLagSeconds).toBeGreaterThan(0);
    expect(lagging.body.cursors[0].entityType).toBe('issue');

    const second = await sync(orgId, id).expect(201);
    expect(second.body.twinsCreated).toBe(20);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.twinsUnchanged).toBe(second.body.fetchedCount - 20);

    const twins = await http().get(`/integrations/connectors/${id}/twins`).set(headers(orgId)).expect(200);
    expect(twins.body).toHaveLength(120);
    const twin = twins.body.find((candidate: any) => candidate.nativeKey === 'CAD-7');
    expect(twin).toMatchObject({
      provider: 'jira',
      artifactType: 'issue',
      nativeUrl: 'https://acme.atlassian.net/browse/CAD-7',
      status: 'To Do',
      syncState: 'synced',
      fieldAuthority: expect.objectContaining({ summary: 'jira', status: 'jira' }),
      payload: expect.objectContaining({ customfield_10014: 'CAD-EPIC-1', projectKey: 'CAD' }),
    });
    expect(twin.correlationNodeId).toBeDefined();

    const searches = jira.requests.filter((r) => r.path === '/rest/api/3/search/jql');
    expect(searches[0].body.jql).toBe('project in ("CAD") ORDER BY updated ASC, key ASC');
    expect(searches[searches.length - 1].body.jql).toMatch(/^project in \("CAD"\) AND updated >= "\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}" ORDER BY updated ASC, key ASC$/);

    jira.editIssue(twin.externalId, { summary: 'Renamed in Jira' });
    const third = await sync(orgId, id).expect(201);
    expect(third.body).toMatchObject({ twinsCreated: 0, twinsUpdated: 1 });
    const renamed = await http().get(`/integrations/connectors/${id}/twins`).set(headers(orgId)).expect(200);
    expect(renamed.body).toHaveLength(120);
    expect(renamed.body.find((candidate: any) => candidate.id === twin.id)).toMatchObject({ title: 'Renamed in Jira', correlationNodeId: twin.correlationNodeId });

    const health = await http().get(`/integrations/connectors/${id}/health`).set(headers(orgId)).expect(200);
    expect(health.body).toMatchObject({ status: 'active', twinCount: 120, syncLagSeconds: 0, consecutiveFailures: 0 });
    expect(health.body.secondsSinceLastSuccess).toBeLessThan(60);
  });

  it('translates native state changes both ways and suppresses the echo of its own writes', async () => {
    const { jira, snow } = useFakes();
    const orgId = randomUUID();
    const incident = snow.addRecord('incident', { short_description: 'Checkout latency', state: '1' });
    const issue = jira.addIssue({ key: 'CAD-500', summary: 'Fix checkout latency', status: 'To Do' });
    const snowId = await onboard(orgId, snowConfig());
    const jiraId = await onboard(orgId, jiraConfig());
    await sync(orgId, snowId).expect(201);
    await sync(orgId, jiraId).expect(201);

    await http().post('/integrations/correlations').set(headers(orgId)).send({
      source: { system: 'servicenow', entity_type: 'incident', immutable_id: incident.sys_id },
      target: { system: 'jira', entity_type: 'issue', immutable_id: issue.id },
      relationship: 'counterpart',
    }).expect(201);
    const draft = await http().post('/integrations/state-mappings').set(headers(orgId)).send({
      name: 'Incident delivery lifecycle',
      source: { system: 'servicenow', entity_type: 'incident' },
      target: { system: 'jira', entity_type: 'issue' },
      rules: [
        { direction: 'source_to_target', from_state: 'In Progress', to_state: 'In Progress' },
        { direction: 'target_to_source', from_state: 'Done', to_state: 'Resolved', allowed_target_from_states: ['In Progress'] },
      ],
    }).expect(201);
    await http().post(`/integrations/state-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(201);

    // ServiceNow agent starts work → Jira issue transitions natively.
    snow.editRecord('incident', incident.sys_id, { state: '2' });
    const forward = await sync(orgId, snowId).expect(201);
    expect(forward.body).toMatchObject({ twinsUpdated: 1, workOrdersPrepared: 1, workOrdersExecuted: 1, workOrdersHeld: 0 });
    expect(jira.issues.get(issue.id)!.status).toBe('In Progress');
    const transition = jira.requests.find((r) => r.method === 'POST' && r.path === `/rest/api/3/issue/${issue.id}/transitions`);
    expect(transition?.body).toEqual({ transition: { id: '12' } });

    // Cadena's own Jira write comes back on the next poll and is not re-propagated.
    const echo = await sync(orgId, jiraId).expect(201);
    expect(echo.body).toMatchObject({ twinsUpdated: 1, echoesSuppressed: 1, workOrdersPrepared: 0 });
    expect(snow.countRequests('PATCH', '/api/now/table/incident')).toBe(0);

    // A developer finishes the Jira issue → ServiceNow incident resolves using the discovered state code.
    jira.editIssue(issue.id, { status: 'Done' });
    const backward = await sync(orgId, jiraId).expect(201);
    expect(backward.body).toMatchObject({ workOrdersPrepared: 1, workOrdersExecuted: 1 });
    const patch = snow.requests.find((r) => r.method === 'PATCH');
    expect(patch?.path).toBe(`/api/now/table/incident/${incident.sys_id}`);
    expect(patch?.body).toEqual({ state: '6' });
    expect(snow.tables.get('incident')!.get(incident.sys_id)!.state).toBe('6');

    const echoBack = await sync(orgId, snowId).expect(201);
    expect(echoBack.body).toMatchObject({ echoesSuppressed: 1, workOrdersPrepared: 0 });
    expect(jira.issues.get(issue.id)!.status).toBe('Done');

    const orders = await http().get(`/integrations/connectors/${jiraId}/work-orders`).set(headers(orgId)).expect(200);
    expect(orders.body.map((order: any) => [order.targetState, order.status]).sort()).toEqual([
      ['In Progress', 'executed'],
      ['Resolved', 'executed'],
    ]);
    const transactions = await http().get('/integrations/state-mappings/transactions').set(headers(orgId)).expect(200);
    expect(transactions.body.filter((tx: any) => tx.status === 'ready')).toHaveLength(2);
    expect(transactions.body.every((tx: any) => tx.mapping_version === 1)).toBe(true);

    // An unmapped state is held for review, never guessed.
    snow.editRecord('incident', incident.sys_id, { state: '3' });
    const held = await sync(orgId, snowId).expect(201);
    expect(held.body).toMatchObject({ workOrdersPrepared: 0, workOrdersHeld: 1 });
    expect(jira.issues.get(issue.id)!.status).toBe('Done');
  });

  it('retries throttled writes with backoff and dead-letters writes the provider refuses', async () => {
    const { jira, snow } = useFakes();
    const orgId = randomUUID();
    const incidentA = snow.addRecord('incident', { short_description: 'Retry path', state: '1' });
    const incidentB = snow.addRecord('incident', { short_description: 'Refused path', state: '1' });
    const issueA = jira.addIssue({ key: 'CAD-601', summary: 'Retry', status: 'To Do' });
    const issueB = jira.addIssue({ key: 'CAD-602', summary: 'Refused', status: 'To Do' });
    const snowId = await onboard(orgId, snowConfig());
    const jiraId = await onboard(orgId, jiraConfig());
    await sync(orgId, snowId).expect(201);
    await sync(orgId, jiraId).expect(201);
    for (const [incident, issue] of [[incidentA, issueA], [incidentB, issueB]] as const) {
      await http().post('/integrations/correlations').set(headers(orgId)).send({
        source: { system: 'servicenow', entity_type: 'incident', immutable_id: incident.sys_id },
        target: { system: 'jira', entity_type: 'issue', immutable_id: issue.id },
      }).expect(201);
    }
    const draft = await http().post('/integrations/state-mappings').set(headers(orgId)).send({
      name: 'Retry lifecycle',
      source: { system: 'servicenow', entity_type: 'incident' },
      target: { system: 'jira', entity_type: 'issue' },
      rules: [
        { direction: 'source_to_target', from_state: 'In Progress', to_state: 'In Progress' },
        { direction: 'source_to_target', from_state: 'Resolved', to_state: 'In Review' },
      ],
    }).expect(201);
    await http().post(`/integrations/state-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(201);

    jira.failNext('POST', `/rest/api/3/issue/${issueA.id}/transitions`, 503);
    jira.unavailableTransitions.add('In Review');
    snow.editRecord('incident', incidentA.sys_id, { state: '2' });
    snow.editRecord('incident', incidentB.sys_id, { state: '6' });
    const first = await sync(orgId, snowId).expect(201);
    expect(first.body).toMatchObject({ workOrdersPrepared: 2, workOrdersExecuted: 0, workOrdersFailed: 2 });

    const failedOrders = await http().get(`/integrations/connectors/${jiraId}/work-orders`).set(headers(orgId)).expect(200);
    const retrying = failedOrders.body.find((order: any) => order.targetExternalId === issueA.id);
    const refused = failedOrders.body.find((order: any) => order.targetExternalId === issueB.id);
    expect(retrying).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining('503') });
    expect(Date.parse(retrying.nextAttemptAt)).toBeGreaterThan(Date.now());
    expect(refused).toMatchObject({ status: 'dead', attempts: 1, lastError: expect.stringContaining("no available transition to 'In Review'") });

    // Not yet due: the Jira poll leaves it queued.
    const early = await sync(orgId, jiraId).expect(201);
    expect(early.body.workOrdersExecuted).toBe(0);

    await database.db.query(
      `UPDATE integration_connector_work_orders SET next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`,
      [retrying.id],
    );
    const retried = await sync(orgId, jiraId).expect(201);
    expect(retried.body.workOrdersExecuted).toBe(1);
    expect(jira.issues.get(issueA.id)!.status).toBe('In Progress');
    expect(jira.issues.get(issueB.id)!.status).toBe('To Do');

    const health = await http().get(`/integrations/connectors/${jiraId}/health`).set(headers(orgId)).expect(200);
    expect(health.body.workOrders).toMatchObject({ executed: 1, dead: 1, failed: 0, pending: 0 });

    // Re-running the sync never replays an executed or dead order.
    const transitionsBefore = jira.countRequests('POST', '/transitions');
    await sync(orgId, jiraId).expect(201);
    expect(jira.countRequests('POST', '/transitions')).toBe(transitionsBefore);
  });

  it('records provider outages without advancing the watermark and recovers on the next poll', async () => {
    const { jira } = useFakes();
    const orgId = randomUUID();
    jira.addIssue({ key: 'CAD-700', summary: 'Before outage', status: 'To Do' });
    const id = await onboard(orgId, jiraConfig());
    await sync(orgId, id).expect(201);
    const before = await http().get(`/integrations/connectors/${id}/health`).set(headers(orgId)).expect(200);

    jira.failNext('POST', '/rest/api/3/search/jql', 500);
    const failed = await sync(orgId, id).expect(502);
    expect(failed.body.message).toMatch(/Provider responded 500/);
    const unhealthy = await http().get(`/integrations/connectors/${id}/health`).set(headers(orgId)).expect(200);
    expect(unhealthy.body).toMatchObject({ status: 'error', consecutiveFailures: 1, lastSuccessAt: before.body.lastSuccessAt });
    expect(unhealthy.body.cursors).toEqual(before.body.cursors.map((cursor: any) => expect.objectContaining({ cursorValue: cursor.cursorValue })));

    jira.addIssue({ key: 'CAD-701', summary: 'During outage', status: 'To Do' });
    const recovered = await sync(orgId, id).expect(201);
    expect(recovered.body.twinsCreated).toBe(1);
    const healthy = await http().get(`/integrations/connectors/${id}/health`).set(headers(orgId)).expect(200);
    expect(healthy.body).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    expect(healthy.body.errorMessage).toBeUndefined();

    const orphan = await http().post('/integrations/connectors').set(headers(orgId))
      .send(jiraConfig({ name: 'Unresolvable', credentials: { apiToken: 'env:US171_NOT_SET' } })).expect(201);
    const denied = await http().post(`/integrations/connectors/${orphan.body.id}/test`).set(headers(orgId)).expect(201);
    expect(denied.body).toMatchObject({ success: false, status: 'error', message: expect.stringContaining('could not be resolved') });
  });

  it('isolates tenants and refuses to let two connectors own the same external identity', async () => {
    const { jira } = useFakes();
    const orgA = randomUUID();
    const orgB = randomUUID();
    jira.addIssue({ key: 'CAD-800', summary: 'Shared upstream', status: 'To Do' });
    const idA = await onboard(orgA, jiraConfig());
    await sync(orgA, idA).expect(201);

    await http().get(`/integrations/connectors/${idA}`).set(headers(orgB)).expect(404);
    await http().get(`/integrations/connectors/${idA}/health`).set(headers(orgB)).expect(404);
    await http().get(`/integrations/connectors/${idA}/twins`).set(headers(orgB)).expect(404);
    await sync(orgB, idA).expect(404);
    await http().post(`/integrations/connectors/${idA}/activate`).set(headers(orgB)).expect(404);
    expect((await http().get('/integrations/connectors/twins').set(headers(orgB)).expect(200)).body).toEqual([]);

    const idB = await onboard(orgB, jiraConfig());
    const syncB = await sync(orgB, idB).expect(201);
    expect(syncB.body.twinsCreated).toBe(1);
    const twinsA = (await http().get('/integrations/connectors/twins').set(headers(orgA)).expect(200)).body;
    const twinsB = (await http().get('/integrations/connectors/twins').set(headers(orgB)).expect(200)).body;
    expect(twinsA).toHaveLength(1);
    expect(twinsB).toHaveLength(1);
    expect(twinsA[0].id).not.toBe(twinsB[0].id);
    expect(twinsA[0].correlationNodeId).not.toBe(twinsB[0].correlationNodeId);

    const duplicate = await onboard(orgA, jiraConfig({ name: 'Second Jira connector' }));
    const conflicted = await sync(orgA, duplicate).expect(201);
    expect(conflicted.body.recordErrors[0].message).toMatch(/already managed by connector/);
    const health = await http().get(`/integrations/connectors/${duplicate}/health`).set(headers(orgA)).expect(200);
    expect(health.body.status).toBe('degraded');
    expect(health.body.twinCount).toBe(0);
  });

  it('allows one synchronization per connector at a time and none while paused', async () => {
    const { jira } = useFakes();
    const orgId = randomUUID();
    jira.addIssue({ key: 'CAD-900', summary: 'Concurrency', status: 'To Do' });
    const id = await onboard(orgId, jiraConfig());

    const release = jira.hold();
    const firstRequest = sync(orgId, id).then((response) => response);
    await vi.waitFor(() => expect(jira.countRequests('POST', '/rest/api/3/search/jql')).toBe(1));
    await sync(orgId, id).expect(409);
    release();
    expect((await firstRequest).status).toBe(201);

    const paused = await http().post(`/integrations/connectors/${id}/pause`).set(headers(orgId)).expect(201);
    expect(paused.body.status).toBe('paused');
    await sync(orgId, id).expect(409);
    await http().post(`/integrations/connectors/${id}/activate`).set(headers(orgId)).expect(201);
    await sync(orgId, id).expect(201);
  });
});
