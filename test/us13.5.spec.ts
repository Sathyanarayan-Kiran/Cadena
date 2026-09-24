import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

process.env.US135_JIRA_TOKEN = 'jira-token-value';
process.env.US135_SNOW_PASSWORD = 'snow-password-value';

const NOTES_FIELD = 'customfield_10500';

/**
 * US13.5 — resolution metadata written back when engineering completes the work.
 *
 * A Jira issue moving to Done resolves its correlated ServiceNow incident. The resolution code and notes travel with
 * the resolution in one write, and when a required resolution field is missing the closure is held with an error that
 * names the field instead of closing the incident incomplete. Everything runs against the provider fakes.
 */
describe('US13.5 — resolution write-back on closure', () => {
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
  const headers = (orgId: string, actor = 'itil.owner') => ({ 'x-org-id': orgId, 'x-actor-id': actor });
  const jiraEndpoint = { system: 'jira', entity_type: 'issue' };
  const snowEndpoint = { system: 'servicenow', entity_type: 'incident' };

  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    const id = created.body.id as string;
    for (const step of ['test', 'discover', 'activate', 'sync']) {
      await http().post(`/integrations/connectors/${id}/${step}`).set(headers(orgId)).expect(201);
    }
    return id;
  };
  const sync = (orgId: string, id: string) => http().post(`/integrations/connectors/${id}/sync`).set(headers(orgId)).expect(201);

  const codeRule = {
    direction: 'source_to_target', source_field: 'resolution', target_field: 'close_code',
    transform: { type: 'value_table', table: { Done: 'Solved (Permanently)', "Won't Do": 'Not Solved (Not Reproducible)' } },
  };
  const notesRule = { direction: 'source_to_target', source_field: NOTES_FIELD, target_field: 'close_notes', transform: { type: 'direct' } };

  /** A correlated Jira issue in review and ServiceNow incident in progress, with the closure mappings published. */
  const scenario = async (options: { requireFields?: boolean; fieldMapping?: boolean; mandatory?: boolean } = {}) => {
    const { requireFields = true, fieldMapping = true, mandatory = false } = options;
    const orgId = randomUUID();
    const jiraApi = new FakeJiraApi();
    const snowApi = new FakeServiceNowApi();
    if (mandatory) snowApi.mandatoryOnResolve = ['close_code', 'close_notes'];
    connectors.registerAdapter(new JiraConnectorAdapter(jiraApi.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snowApi.fetch));
    const issue = jiraApi.addIssue({ key: 'CAD-500', summary: 'Checkout latency regression', status: 'In Review' });
    const incident = snowApi.addRecord('incident', { short_description: 'Checkout slow for EU', state: '2', priority: '2' });
    const jiraId = await onboard(orgId, {
      name: 'Jira Cloud', provider: 'jira', baseUrl: 'https://acme.atlassian.net',
      credentials: { apiToken: 'env:US135_JIRA_TOKEN' },
      options: { accountEmail: 'sync@acme.test', customFieldIds: [NOTES_FIELD] }, projectKeys: ['CAD'],
    });
    const snowId = await onboard(orgId, {
      name: 'ServiceNow ITSM', provider: 'servicenow', baseUrl: 'https://acme.service-now.com',
      credentials: { password: 'env:US135_SNOW_PASSWORD' }, options: { username: 'svc.cadena' }, tableNames: ['incident'],
    });
    await http().post('/integrations/correlations').set(headers(orgId)).send({
      source: { system: 'servicenow', entity_type: 'incident', immutable_id: incident.sys_id },
      target: { system: 'jira', entity_type: 'issue', immutable_id: issue.id },
    }).expect(201);

    const stateDraft = await http().post('/integrations/state-mappings').set(headers(orgId)).send({
      name: 'Engineering closure', source: jiraEndpoint, target: snowEndpoint,
      rules: [{
        direction: 'source_to_target', from_state: 'Done', to_state: 'Resolved',
        ...(requireFields ? { required_target_fields: ['close_code', 'close_notes'] } : {}),
      }],
    }).expect(201);
    await http().post(`/integrations/state-mappings/${stateDraft.body.id}/publish`).set(headers(orgId)).expect(201);

    if (fieldMapping) {
      const fieldDraft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
        name: 'Resolution details', source: jiraEndpoint, target: snowEndpoint, rules: [codeRule, notesRule],
      }).expect(201);
      await http().post(`/integrations/field-mappings/${fieldDraft.body.id}/publish`).set(headers(orgId)).expect(201);
    }
    return { orgId, jiraApi, snowApi, issue, incident, jiraId, snowId };
  };

  const patches = (snowApi: FakeServiceNowApi) => snowApi.requests.filter((r) => r.method === 'PATCH');
  const orders = async (orgId: string, snowId: string) =>
    (await http().get(`/integrations/connectors/${snowId}/work-orders`).set(headers(orgId)).expect(200)).body;

  it('writes the resolution code and notes together with the resolution when engineering completes the work', async () => {
    const { orgId, jiraApi, snowApi, issue, incident, jiraId, snowId } = await scenario();
    jiraApi.editIssue(issue.id, {
      status: 'Done', resolution: 'Done', custom: { [NOTES_FIELD]: 'Rolled back release 4.2 and flushed the CDN cache.' },
    });

    const result = await sync(orgId, jiraId);
    expect(result.body).toMatchObject({ workOrdersPrepared: 1, workOrdersExecuted: 1, workOrdersHeld: 0 });

    // One write carries the state and both resolution fields, as the provider's data policy requires.
    expect(patches(snowApi)).toHaveLength(1);
    expect(patches(snowApi)[0].body).toEqual({
      close_code: 'Solved (Permanently)', close_notes: 'Rolled back release 4.2 and flushed the CDN cache.', state: '6',
    });
    expect(snowApi.tables.get('incident')!.get(incident.sys_id)).toMatchObject({
      state: '6', close_code: 'Solved (Permanently)', close_notes: 'Rolled back release 4.2 and flushed the CDN cache.',
    });
    expect((await orders(orgId, snowId))[0]).toMatchObject({
      status: 'executed', targetState: 'Resolved',
      fields: { close_code: 'Solved (Permanently)', close_notes: 'Rolled back release 4.2 and flushed the CDN cache.' },
    });
  });

  it('maps each engineering resolution to its configured resolution code', async () => {
    const { orgId, jiraApi, snowApi, issue, incident, jiraId } = await scenario();
    jiraApi.editIssue(issue.id, { status: 'Done', resolution: "Won't Do", custom: { [NOTES_FIELD]: 'Out of scope for this quarter.' } });
    await sync(orgId, jiraId);
    expect(snowApi.tables.get('incident')!.get(incident.sys_id)).toMatchObject({ state: '6', close_code: 'Not Solved (Not Reproducible)' });
  });

  it('refuses to close the incident when a required resolution field is missing, and names the field', async () => {
    const { orgId, jiraApi, snowApi, issue, incident, jiraId, snowId } = await scenario();
    jiraApi.editIssue(issue.id, { status: 'Done', resolution: 'Done' });

    const result = await sync(orgId, jiraId);
    expect(result.body).toMatchObject({ workOrdersHeld: 1, workOrdersExecuted: 0 });

    const held = (await orders(orgId, snowId)).find((order: any) => order.status === 'held');
    expect(held.lastError).toContain('close_notes');
    expect(held.lastError).not.toContain('close_code,');
    expect(held.lastError).toContain('was not changed');
    // Nothing was sent, so the incident is exactly as it was.
    expect(patches(snowApi)).toHaveLength(0);
    expect(snowApi.tables.get('incident')!.get(incident.sys_id)!.state).toBe('2');
  });

  it('names every missing field, and treats blank notes as missing', async () => {
    const both = await scenario();
    both.jiraApi.editIssue(both.issue.id, { status: 'Done' });
    await sync(both.orgId, both.jiraId);
    const heldBoth = (await orders(both.orgId, both.snowId)).find((order: any) => order.status === 'held');
    expect(heldBoth.lastError).toContain('close_code');
    expect(heldBoth.lastError).toContain('close_notes');
    expect(patches(both.snowApi)).toHaveLength(0);

    const blank = await scenario();
    blank.jiraApi.editIssue(blank.issue.id, { status: 'Done', resolution: 'Done', custom: { [NOTES_FIELD]: '   ' } });
    await sync(blank.orgId, blank.jiraId);
    const heldBlank = (await orders(blank.orgId, blank.snowId)).find((order: any) => order.status === 'held');
    expect(heldBlank.lastError).toContain('close_notes');
    expect(blank.snowApi.tables.get('incident')!.get(blank.incident.sys_id)!.state).toBe('2');
  });

  it('completes the closure once the missing field is supplied through the twin dead-letter queue', async () => {
    const { orgId, jiraApi, snowApi, issue, incident, jiraId, snowId } = await scenario();
    jiraApi.editIssue(issue.id, { status: 'Done', resolution: 'Done' });
    await sync(orgId, jiraId);

    const held = (await http().get(`/integrations/connectors/${snowId}/twin-dlq`).set(headers(orgId)).expect(200)).body
      .find((entry: any) => entry.status === 'held');
    expect(held).toBeTruthy();
    const corrected = JSON.parse(JSON.stringify(held.payload.sourcePayload));
    corrected.fields[NOTES_FIELD] = 'Configuration reverted; confirmed by the on-call engineer.';
    await http().post(`/integrations/connectors/${snowId}/twin-dlq/${held.id}/reinject`).set(headers(orgId))
      .send({ payload: { targetState: held.payload.targetState || 'Resolved', fields: {}, sourcePayload: corrected } }).expect(201);
    await sync(orgId, snowId);

    expect(snowApi.tables.get('incident')!.get(incident.sys_id)).toMatchObject({
      state: '6', close_code: 'Solved (Permanently)', close_notes: 'Configuration reverted; confirmed by the on-call engineer.',
    });
    expect(patches(snowApi)).toHaveLength(1);
  });

  it('never leaves the incident resolved without its fields even if no field is declared required, because the provider refuses', async () => {
    const { orgId, jiraApi, snowApi, issue, incident, jiraId, snowId } = await scenario({ requireFields: false, fieldMapping: false, mandatory: true });
    jiraApi.editIssue(issue.id, { status: 'Done', resolution: 'Done' });
    await sync(orgId, jiraId);

    const order = (await orders(orgId, snowId))[0];
    expect(['failed', 'dead']).toContain(order.status);
    expect(order.lastError).toContain('Resolution code, Resolution notes are mandatory');
    expect(snowApi.tables.get('incident')!.get(incident.sys_id)!.state).toBe('2');
  });

  it('does not affect a closure that has nothing required, and other transitions', async () => {
    const { orgId, jiraApi, snowApi, issue, incident, jiraId } = await scenario({ requireFields: false, fieldMapping: false });
    jiraApi.editIssue(issue.id, { status: 'Done' });
    await sync(orgId, jiraId);
    expect(snowApi.tables.get('incident')!.get(incident.sys_id)!.state).toBe('6');
    expect(patches(snowApi)[0].body).toEqual({ state: '6' });
  });
});
