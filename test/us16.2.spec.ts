import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { ConnectorService } from '../src/modules/connectors/connector.service';
import { ConnectorFieldSchema, ConnectorRecord } from '../src/modules/connectors/connector.types';
import { JiraConnectorAdapter } from '../src/modules/connectors/jira-connector.adapter';
import { ServiceNowConnectorAdapter } from '../src/modules/connectors/servicenow-connector.adapter';
import { FakeJiraApi, FakeServiceNowApi } from '../src/modules/connectors/sandbox/provider-sandbox';
import { ConnectorContext } from '../src/modules/connectors/connector.interface';
import { ConnectorLoadShedError, ConnectorRemoteError } from '../src/modules/connectors/connector-http';
import { ConnectorRateGovernor } from '../src/modules/connectors/rate-governor';
import { validateEncodedQuery, validateJql } from '../src/modules/connectors/native-query/native-query-validator';
import { buildQueryIndexCatalog, validateQueryIndexes } from '../src/modules/connectors/native-query/query-index-catalog';

process.env.CADENA_NATIVE_QUERY_SCHEDULER = 'disabled';
process.env.CADENA_BACKFILL_SCHEDULER = 'disabled';
process.env.US162_JIRA_TOKEN = 'jira-token-value';
process.env.US162_SNOW_PASSWORD = 'snow-password-value';

const field = (id: string, extra: Partial<ConnectorFieldSchema> = {}): ConnectorFieldSchema => ({
  id, name: id, type: 'string', required: false, custom: false, ...extra,
});

const connector = (
  provider: 'jira' | 'servicenow',
  entityType: string,
  fields: ConnectorFieldSchema[],
  queryIndexes?: Record<string, string[]>,
): ConnectorRecord => ({
  id: randomUUID(), orgId: randomUUID(), provider, name: provider, status: 'active',
  config: { baseUrl: 'https://example.test', ...(queryIndexes ? { queryIndexes } : {}) },
  discoveryMetadata: {
    provider, entities: [{ entityType, name: entityType, fields }], scopes: [],
    discoveredAt: new Date().toISOString(), supportedCapabilities: [],
  },
  syncLagSeconds: 0, consecutiveFailures: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

const jiraFields = [
  field('project', { indexed: true, clauseNames: ['project'] }),
  field('labels', { indexed: true, clauseNames: ['labels'] }),
  field('customfield_10020', { name: 'Sprint', custom: true, indexed: true, clauseNames: ['Sprint', 'cf[10020]'] }),
  field('customfield_10600', { name: 'Vendor ticket', custom: true, indexed: false, clauseNames: [] }),
];
const snowFields = [
  field('short_description'),
  field('category'),
  field('assignment_group', { reference: true }),
  field('caller_id', { reference: true }),
];

/**
 * US16.2 — outbound queries constrained to indexed fields.
 *
 * Index findings are pure and covered here against synthetic catalogs; the configuration
 * lifecycle is exercised through the API against the local provider fakes only.
 */
describe('US16.2 — indexed-field validation', () => {
  it('accepts JQL that filters only on searchable fields, by id, clause name or cf[] alias', () => {
    const catalog = buildQueryIndexCatalog(connector('jira', 'issue', jiraFields), 'issue');
    expect(validateJql('project = CAD AND labels = billing AND Sprint = 7', catalog).valid).toBe(true);
    expect(validateJql('project = CAD AND cf[10020] in (7, 8) AND text ~ "outage"', catalog).valid).toBe(true);
  });

  it('rejects a JQL field Jira does not index, naming it, wherever it appears in the expression', () => {
    const catalog = buildQueryIndexCatalog(connector('jira', 'issue', jiraFields), 'issue');
    for (const query of [
      'project = CAD AND "Vendor ticket" ~ "INC-1"',
      'project = CAD AND (labels = x OR NOT "Vendor ticket" is EMPTY)',
    ]) {
      const result = validateJql(query, catalog);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([expect.objectContaining({ code: 'unindexed_field', field: 'customfield_10600' })]);
      expect(result.errors[0].message).toContain("'Vendor ticket'");
    }
    const unknown = validateJql('project = CAD AND "Mystery field" = 1', catalog);
    expect(unknown.errors).toEqual([expect.objectContaining({ code: 'unknown_field', field: 'Mystery field' })]);
  });

  it('refuses to vouch for a Jira schema discovered before searchability was recorded', () => {
    const legacy = jiraFields.map(({ indexed: _ignored, ...rest }) => rest);
    const result = validateJql('project = CAD', buildQueryIndexCatalog(connector('jira', 'issue', legacy), 'issue'));
    expect(result.errors.map((error) => error.code)).toEqual(['index_catalog_unavailable']);
  });

  it('allows ServiceNow reference and platform columns and names every other filtered column', () => {
    const catalog = buildQueryIndexCatalog(connector('servicenow', 'incident', snowFields), 'incident');
    expect(validateEncodedQuery('assignment_group=grpA^ORcaller_id=u1^numberSTARTSWITHINC00', catalog).valid).toBe(true);

    const result = validateEncodedQuery('assignment_group=grpA^short_descriptionLIKEdisk^NQcaller_id.department=d1^category=network', catalog);
    expect(result.errors.map((error) => [error.code, error.field])).toEqual([
      ['unindexed_field', 'short_description'],
      ['unindexed_field', 'caller_id.department'],
      ['unindexed_field', 'category'],
    ]);
    expect(result.errors[2].hint).toContain("declare it in the connector's query indexes");
    expect(validateEncodedQuery('assignment_group=grpA^u_nope=1', catalog).errors)
      .toEqual([expect.objectContaining({ code: 'unknown_field', field: 'u_nope' })]);
  });

  it('accepts a column an administrator has declared indexed, including a dot-walk', () => {
    const catalog = buildQueryIndexCatalog(
      connector('servicenow', 'incident', snowFields, { incident: ['category', 'caller_id.department'] }),
      'incident',
    );
    expect(validateEncodedQuery('category=network^NQcaller_id.department=d1', catalog).valid).toBe(true);
  });

  it('validates the declaration shape', () => {
    expect(validateQueryIndexes({ incident: [' category ', 'category', 'u_region'] })).toEqual({ incident: ['category', 'u_region'] });
    expect(() => validateQueryIndexes(['category'])).toThrow(/must be an object/);
    expect(() => validateQueryIndexes({ incident: ['bad field'] })).toThrow(/list of field ids/);
    expect(() => validateQueryIndexes({ 'bad type': ['x'] })).toThrow(/invalid entity type/);
  });
});

describe('US16.2 — indexed queries through the API', () => {
  let app: INestApplication;
  let connectors: ConnectorService;
  const database = DatabaseService.getInstance();

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    connectors = app.get(ConnectorService);
  });

  afterAll(async () => {
    connectors.registerAdapter(new JiraConnectorAdapter());
    connectors.registerAdapter(new ServiceNowConnectorAdapter());
    if (app) await app.close();
  });

  const http = () => request(app.getHttpServer());
  const headers = (orgId: string) => ({ 'x-org-id': orgId, 'x-actor-id': 'integration-specialist' });

  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    for (const step of ['test', 'discover', 'activate']) {
      await http().post(`/integrations/connectors/${created.body.id}/${step}`).set(headers(orgId)).expect(201);
    }
    return created.body.id as string;
  };

  const tenant = async () => {
    const orgId = randomUUID();
    const jiraApi = new FakeJiraApi();
    const snowApi = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jiraApi.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snowApi.fetch));
    const jiraId = await onboard(orgId, {
      name: 'Jira Cloud', provider: 'jira', baseUrl: 'https://acme.atlassian.net',
      credentials: { apiToken: 'env:US162_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' }, projectKeys: ['CAD'],
    });
    const snowId = await onboard(orgId, {
      name: 'ServiceNow ITSM', provider: 'servicenow', baseUrl: 'https://acme.service-now.com',
      credentials: { password: 'env:US162_SNOW_PASSWORD' }, options: { username: 'svc.cadena' }, tableNames: ['incident'],
    });
    return { orgId, jiraId, snowId, jiraApi, snowApi };
  };

  const draft = async (orgId: string, body: Record<string, unknown>) =>
    (await http().post('/integrations/native-queries').set(headers(orgId)).send(body).expect(201)).body;
  const providerQueries = (jira: FakeJiraApi, snow: FakeServiceNowApi) =>
    jira.countRequests('POST', '/rest/api/3/search/jql') + snow.countRequests('GET', '/api/now/table/incident');

  it('records searchability at discovery and refuses to publish a query on an unindexed Jira field, naming it', async () => {
    const { orgId, jiraId, jiraApi, snowApi } = await tenant();
    const discovered = await http().get(`/integrations/connectors/${jiraId}`).set(headers(orgId)).expect(200);
    const fields = discovered.body.discoveryMetadata.entities[0].fields;
    expect(fields.find((candidate: any) => candidate.id === 'customfield_10600')).toMatchObject({ indexed: false });
    expect(fields.find((candidate: any) => candidate.id === 'issuetype')).toMatchObject({ indexed: true, clauseNames: ['issuetype', 'type'] });

    const saved = await draft(orgId, {
      name: 'Vendor escalations', connector_id: jiraId, entity_type: 'issue', query: 'project = CAD AND "Vendor ticket" ~ "V-1"',
    });
    expect(saved.validation.errors).toEqual([expect.objectContaining({ code: 'unindexed_field', field: 'customfield_10600' })]);

    const before = providerQueries(jiraApi, snowApi);
    const refused = await http().post(`/integrations/native-queries/${saved.id}/publish`).set(headers(orgId)).expect(422);
    expect(refused.body.message).toContain("'Vendor ticket' is not indexed");
    expect((await http().get(`/integrations/native-queries/${saved.id}`).set(headers(orgId))).body.status).toBe('draft');
    expect(providerQueries(jiraApi, snowApi)).toBe(before);
  });

  it('checks indexes ad hoc when a connector is named, and says when it could not', async () => {
    const { orgId, snowId } = await tenant();
    const checked = await http().post('/integrations/native-queries/validate').set(headers(orgId))
      .send({ language: 'encoded', query: 'assignment_group=grpA^short_description=disk', connector_id: snowId, entity_type: 'incident' })
      .expect(201);
    expect(checked.body.errors).toEqual([expect.objectContaining({ code: 'unindexed_field', field: 'short_description' })]);
    expect(checked.body.warnings).toEqual([]);

    const unchecked = await http().post('/integrations/native-queries/validate').set(headers(orgId))
      .send({ language: 'encoded', query: 'assignment_group=grpA^short_description=disk' }).expect(201);
    expect(unchecked.body.valid).toBe(true);
    expect(unchecked.body.warnings.map((warning: any) => warning.code)).toEqual(['indexes_not_checked']);

    await http().post('/integrations/native-queries/validate').set(headers(orgId))
      .send({ language: 'jql', query: 'project = CAD', connector_id: snowId, entity_type: 'incident' }).expect(422);
  });

  it('publishes once an administrator declares the index, audits the declaration, and stops runs when it is withdrawn', async () => {
    const { orgId, snowId, jiraApi, snowApi } = await tenant();
    const saved = await draft(orgId, {
      name: 'Network', connector_id: snowId, entity_type: 'incident', query: 'assignment_group=grpA^category=network',
    });
    await http().post(`/integrations/native-queries/${saved.id}/publish`).set(headers(orgId)).expect(422);

    await http().post(`/integrations/connectors/${snowId}/query-indexes`).set(headers(orgId))
      .send({ change_request: ['category'] }).expect(400);
    const configured = await http().post(`/integrations/connectors/${snowId}/query-indexes`).set(headers(orgId))
      .send({ incident: ['category'] }).expect(201);
    expect(configured.body.config.queryIndexes).toEqual({ incident: ['category'] });
    const event = await database.db.query<any>(
      `SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'ConnectorQueryIndexesConfigured'`, [orgId],
    );
    expect(event.rows).toHaveLength(1);
    const payload = typeof event.rows[0].payload === 'string' ? JSON.parse(event.rows[0].payload) : event.rows[0].payload;
    expect(payload).toMatchObject({ before: {}, after: { incident: ['category'] } });

    await http().post(`/integrations/native-queries/${saved.id}/publish`).set(headers(orgId)).expect(201);
    expect((await http().post(`/integrations/native-queries/${saved.id}/run`).set(headers(orgId)).expect(201)).body.status).toBe('succeeded');

    // Withdrawing the declaration makes the next run refuse the query before any provider call.
    await http().post(`/integrations/connectors/${snowId}/query-indexes`).set(headers(orgId)).send({}).expect(201);
    const before = providerQueries(jiraApi, snowApi);
    const blocked = (await http().post(`/integrations/native-queries/${saved.id}/run`).set(headers(orgId)).expect(201)).body;
    expect(blocked).toMatchObject({ status: 'failed' });
    expect(blocked.message).toContain("'category' is not indexed");
    expect(providerQueries(jiraApi, snowApi)).toBe(before);
  });
});

const payloadOf = (row: any) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);

describe('US16.2 — load shedding under semaphore pressure', () => {
  beforeAll(async () => DatabaseService.getInstance().initialize());
  const database = DatabaseService.getInstance();

  const context = (orgId: string, shedAfterPressureResponses = 1): ConnectorContext => {
    const baseUrl = `https://${randomUUID()}.example.test`;
    return {
      baseUrl,
      credentials: {},
      connector: {
        id: randomUUID(), orgId, provider: 'servicenow', name: 'Overloaded', status: 'active',
        config: { baseUrl, rateGovernance: { baseBackoffMs: 1_000, maxBackoffMs: 8_000, jitterRatio: 0, shedAfterPressureResponses } },
        syncLagSeconds: 0, consecutiveFailures: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    };
  };
  const events = async (orgId: string, type: string) => (await database.db.query<any>(
    `SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = $2 ORDER BY occurred_at`, [orgId, type],
  )).rows.map(payloadOf);

  it('stops calling the target after pressure, probes once when the window ends, and records both transitions', async () => {
    let clock = Date.parse('2026-09-24T12:00:00Z');
    const governor = new ConnectorRateGovernor({ now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0.5 });
    const orgId = randomUUID();
    const ctx = context(orgId);
    const calls: string[] = [];

    await expect(governor.execute(ctx, async () => {
      calls.push('pressure');
      throw new ConnectorRemoteError('Provider responded 503: database semaphore exhausted', 503, true);
    })).rejects.toMatchObject({ status: 503, retryAfterSeconds: 1 });

    // Inside the window every call is refused before it is sent.
    for (let index = 0; index < 3; index++) {
      const refused = await governor.execute(ctx, async () => { calls.push('sent'); }).catch((error) => error);
      expect(refused).toBeInstanceOf(ConnectorLoadShedError);
      expect(refused.until.toISOString()).toBe(new Date(clock + 1_000).toISOString());
    }
    expect(calls).toEqual(['pressure']);
    let [metric] = await governor.listStoredMetrics(orgId);
    expect(metric.loadShedding).toMatchObject({ state: 'shedding', episodes: 1, shedRequests: 3 });
    expect(metric.loadShedding.reason).toContain('semaphore exhausted');
    expect(await events(orgId, 'ConnectorLoadSheddingStarted')).toEqual([
      expect.objectContaining({ connector_id: ctx.connector.id, status: 503, shedding_until: new Date(clock + 1_000).toISOString() }),
    ]);

    // After the window one probe is admitted; a call arriving while it is out is still refused.
    clock += 1_000;
    let releaseProbe!: () => void;
    const probe = governor.execute(ctx, () => new Promise<string>((resolve) => { releaseProbe = () => resolve('recovered'); }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await governor.execute(ctx, async () => { calls.push('during-probe'); }).catch((error) => error)).toBeInstanceOf(ConnectorLoadShedError);
    [metric] = await governor.listStoredMetrics(orgId);
    expect(metric.loadShedding.state).toBe('probing');
    releaseProbe();
    await expect(probe).resolves.toBe('recovered');

    [metric] = await governor.listStoredMetrics(orgId);
    expect(metric.loadShedding).toMatchObject({ state: 'normal', until: null, episodes: 1, shedRequests: 4 });
    expect(await events(orgId, 'ConnectorLoadSheddingEnded')).toEqual([
      expect.objectContaining({ connector_id: ctx.connector.id, duration_ms: 1_000 }),
    ]);
    await expect(governor.execute(ctx, async () => 'normal')).resolves.toBe('normal');
    expect(calls).toEqual(['pressure']);
  });

  it('sheds only after sustained pressure, honours Retry-After as the window, reopens longer when the probe meets pressure, and ignores other failures', async () => {
    let clock = Date.parse('2026-09-24T13:00:00Z');
    const governor = new ConnectorRateGovernor({ now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0.5 });
    const orgId = randomUUID();
    const ctx = context(orgId, 2);
    const pressure = (retryAfter?: number) => governor.execute(ctx, async () => {
      throw new ConnectorRemoteError('semaphore', 503, true, retryAfter);
    }).catch(() => undefined);

    // One overloaded response is an ordinary per-item retry; a success resets the streak.
    await pressure();
    let [metric] = await governor.listStoredMetrics(orgId);
    expect(metric.loadShedding.state).toBe('normal');
    await governor.execute(ctx, async () => 'ok');
    await pressure();
    [metric] = await governor.listStoredMetrics(orgId);
    expect(metric.loadShedding.state).toBe('normal');

    // The second consecutive one opens the window for the target's stated Retry-After.
    await pressure(5);
    [metric] = await governor.listStoredMetrics(orgId);
    expect(metric.loadShedding).toMatchObject({ state: 'shedding', episodes: 1 });
    expect(Date.parse(metric.loadShedding.until!)).toBe(clock + 5_000);

    clock += 5_000;
    await governor.execute(ctx, async () => { throw new ConnectorRemoteError('still exhausted', 503, true); }).catch(() => undefined);
    [metric] = await governor.listStoredMetrics(orgId);
    // Third consecutive failure: the exponential delay grows (1s, 2s, 4s).
    expect(metric.loadShedding).toMatchObject({ state: 'shedding', episodes: 1 });
    expect(Date.parse(metric.loadShedding.until!)).toBe(clock + 4_000);
    expect(await events(orgId, 'ConnectorLoadSheddingStarted')).toEqual([expect.objectContaining({ consecutive_pressure_responses: 2 })]);

    // An ordinary quota 429 or a permanent error is not semaphore pressure and sheds nothing.
    const other = context(randomUUID(), 1);
    await governor.execute(other, async () => { throw new ConnectorRemoteError('Provider responded 429', 429, true, 1); }).catch(() => undefined);
    await governor.execute(other, async () => { throw new ConnectorRemoteError('Provider responded 404', 404, false); }).catch(() => undefined);
    const [unaffected] = await governor.listStoredMetrics(other.connector.orgId);
    expect(unaffected.loadShedding).toMatchObject({ state: 'normal', episodes: 0 });
    await expect(governor.execute(other, async () => 'sent')).resolves.toBe('sent');
  });
});

describe('US16.2 — durable work under load shedding', () => {
  let app: INestApplication;
  let connectors: ConnectorService;
  const database = DatabaseService.getInstance();

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    connectors = app.get(ConnectorService);
  });

  afterAll(async () => {
    connectors.registerAdapter(new JiraConnectorAdapter());
    if (app) await app.close();
  });

  const http = () => request(app.getHttpServer());
  const headers = (orgId: string) => ({ 'x-org-id': orgId, 'x-actor-id': 'platform-operator' });

  it('defers queued writes and scheduled queries without spending attempts, surfaces the condition, and resumes after recovery', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi(`https://${randomUUID()}.atlassian.net`);
    for (const key of ['CAD-1', 'CAD-2', 'CAD-3']) jira.addIssue({ key, summary: `Before ${key}`, status: 'To Do', updated: Date.now() - 120_000 });
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send({
      name: 'Pressured Jira', provider: 'jira', baseUrl: jira.baseUrl,
      credentials: { apiToken: 'env:US162_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' }, projectKeys: ['CAD'],
      // One call at a time, so the first pressure response lands before the next order is admitted.
      rateGovernance: { requestsPerMinute: 6_000, headroomPercentage: 100, maxConcurrent: 1 },
    }).expect(201);
    const connectorId = created.body.id as string;
    for (const step of ['test', 'discover', 'activate', 'sync']) {
      await http().post(`/integrations/connectors/${connectorId}/${step}`).set(headers(orgId)).expect(201);
    }
    const twins = (await http().get(`/integrations/connectors/${connectorId}/twins`).set(headers(orgId)).expect(200)).body;
    expect(twins).toHaveLength(3);
    const orderIds: string[] = [];
    for (const twin of twins) {
      const id = randomUUID();
      orderIds.push(id);
      await database.db.query(
        `INSERT INTO integration_connector_work_orders
         (id, org_id, transaction_id, origin, target_connector_id, target_twin_id,
          target_entity_type, target_external_id, target_state, fields, status, source_payload)
         VALUES ($1, $2, NULL, 'operator_edit', $3, $4, 'issue', $5, NULL, $6, 'pending', '{}')`,
        [id, orgId, connectorId, twin.id, twin.externalId, JSON.stringify({ summary: `After ${twin.nativeKey}` })],
      );
    }
    const query = (await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'CAD watch', connector_id: connectorId, entity_type: 'issue', query: 'project = CAD' }).expect(201)).body;
    await http().post(`/integrations/native-queries/${query.id}/publish`).set(headers(orgId)).expect(201);

    // The first two writes meet semaphore pressure; the second (the default threshold) opens a one-second window.
    jira.failNext('PUT', '/rest/api/3/issue/', 503, 2, { 'Retry-After': '1' });
    const writesBefore = jira.countRequests('PUT', '/rest/api/3/issue/');
    const searchesBefore = jira.countRequests('POST', '/rest/api/3/search/jql');
    const shedSync = (await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201)).body;
    expect(jira.countRequests('PUT', '/rest/api/3/issue/') - writesBefore).toBe(2);
    expect(jira.countRequests('POST', '/rest/api/3/search/jql')).toBe(searchesBefore);
    expect(shedSync.loadShedding.reason).toContain('shedding load');
    expect(shedSync.workOrdersFailed).toBe(2);

    const orders = (await http().get(`/integrations/connectors/${connectorId}/work-orders`).set(headers(orgId))).body
      .filter((order: any) => orderIds.includes(order.id));
    expect(orders.map((order: any) => order.status).sort()).toEqual(['failed', 'failed', 'pending']);
    // Only the orders the target actually answered spent an attempt; nothing was dead-lettered.
    expect(orders.map((order: any) => order.attempts).sort()).toEqual([0, 1, 1]);
    expect(orders.filter((order: any) => order.status === 'pending').every((order: any) => order.lastError.startsWith('Deferred:'))).toBe(true);

    const connector = (await http().get(`/integrations/connectors/${connectorId}`).set(headers(orgId))).body;
    expect(connector).toMatchObject({ status: 'degraded', consecutiveFailures: 0 });
    expect(connector.errorMessage).toMatch(/^Load shedding: /);
    const [metric] = (await http().get('/integrations/connectors/rate-governance').set(headers(orgId)).expect(200)).body;
    expect(metric.loadShedding).toMatchObject({ state: 'shedding', episodes: 1 });
    expect(metric.backlog.workOrders).toBe(3);

    // While shedding, a sync and a scheduled run send nothing and count no failure.
    const idleSync = (await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201)).body;
    expect(idleSync.loadShedding).toBeTruthy();
    const deferredRun = (await http().post(`/integrations/native-queries/${query.id}/run`).set(headers(orgId)).expect(201)).body;
    expect(deferredRun.status).toBe('skipped');
    const stored = (await http().get(`/integrations/native-queries/${query.id}`).set(headers(orgId))).body;
    expect(stored).toMatchObject({ consecutive_failures: 0 });
    expect(stored.last_error).toMatch(/^Deferred:/);
    expect(Date.parse(stored.next_run_at)).toBe(Date.parse(metric.loadShedding.until));
    expect(jira.countRequests('PUT', '/rest/api/3/issue/') - writesBefore).toBe(2);
    expect(jira.countRequests('POST', '/rest/api/3/search/jql')).toBe(searchesBefore);

    // After the window the next sync probes, recovers and completes every write exactly once.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await database.db.query(
      `UPDATE integration_connector_work_orders SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`, [orderIds],
    );
    const recovered = (await http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201)).body;
    expect(recovered.loadShedding).toBeUndefined();
    expect(recovered.workOrdersExecuted).toBe(3);
    expect(jira.countRequests('PUT', '/rest/api/3/issue/') - writesBefore).toBe(5);
    expect(Array.from(jira.issues.values()).map((issue) => issue.summary).sort()).toEqual(['After CAD-1', 'After CAD-2', 'After CAD-3']);
    expect((await http().get(`/integrations/connectors/${connectorId}`).set(headers(orgId))).body.status).toBe('active');
    const [after] = (await http().get('/integrations/connectors/rate-governance').set(headers(orgId)).expect(200)).body;
    expect(after.loadShedding).toMatchObject({ state: 'normal', episodes: 1 });
    const transitions = await database.db.query<any>(
      `SELECT event_type FROM domain_events WHERE org_id = $1 AND event_type LIKE 'ConnectorLoadShedding%' ORDER BY occurred_at`, [orgId],
    );
    expect(transitions.rows.map((row: any) => row.event_type)).toEqual(['ConnectorLoadSheddingStarted', 'ConnectorLoadSheddingEnded']);
  });
});
