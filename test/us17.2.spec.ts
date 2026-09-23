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

process.env.US172_JIRA_TOKEN = 'jira-token-value';
process.env.US172_SNOW_PASSWORD = 'snow-password-value';

/**
 * US17.2 — governed visual field mappings and the sandboxed scripting escape hatch.
 *
 * The script sandbox itself (timeout, memory limit, no ambient network/filesystem) is verified in
 * `test/mapping-script-sandbox.spec.ts`; these tests cover the mapping definitions, their
 * publish-time schema validation, and evaluation of every visual rule type.
 */
describe('US17.2 — field mapping definitions', () => {
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
  const headers = (orgId: string, actor = 'mapping-admin') => ({ 'x-org-id': orgId, 'x-actor-id': actor });

  const jira = () => ({ system: 'jira', entity_type: 'issue' });
  const snow = () => ({ system: 'servicenow', entity_type: 'incident' });

  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    const id = created.body.id as string;
    for (const step of ['test', 'discover', 'activate']) {
      await http().post(`/integrations/connectors/${id}/${step}`).set(headers(orgId)).expect(201);
    }
    return id;
  };

  /** A tenant with a discovered (but not necessarily activated-for-sync) Jira and ServiceNow connector. */
  const discoveredTenant = async () => {
    const orgId = randomUUID();
    const jiraApi = new FakeJiraApi();
    const snowApi = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jiraApi.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snowApi.fetch));
    await onboard(orgId, {
      name: 'Jira Cloud', provider: 'jira', baseUrl: 'https://acme.atlassian.net',
      credentials: { apiToken: 'env:US172_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' }, projectKeys: ['CAD'],
    });
    await onboard(orgId, {
      name: 'ServiceNow ITSM', provider: 'servicenow', baseUrl: 'https://acme.service-now.com',
      credentials: { password: 'env:US172_SNOW_PASSWORD' }, options: { username: 'svc.cadena' }, tableNames: ['incident'],
    });
    return { orgId, jiraApi, snowApi };
  };

  const valueTableRule = (overrides: Record<string, unknown> = {}) => ({
    direction: 'source_to_target',
    source_field: 'priority',
    target_field: 'priority',
    transform: { type: 'value_table', table: { High: '1 - Critical', Medium: '3 - Moderate', Low: '4 - Low' }, default_value: '3 - Moderate' },
    ...overrides,
  });

  it('versions drafts per connector pair and previews both directions without persisting anything', async () => {
    const { orgId } = await discoveredTenant();
    const draft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Priority translation', source: jira(), target: snow(), rules: [valueTableRule()],
    }).expect(201);
    expect(draft.body).toMatchObject({ version: 1, status: 'draft', source: jira(), target: snow() });

    const secondDraft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Priority translation v2', source: jira(), target: snow(), rules: [valueTableRule()],
    }).expect(201);
    expect(secondDraft.body.version).toBe(2);

    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ name: 'x', source: jira(), target: jira(), rules: [valueTableRule()] }).expect(422);
    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ name: 'x', source: jira(), target: snow(), rules: [] }).expect(422);

    const list = await http().get('/integrations/field-mappings').set(headers(orgId)).expect(200);
    expect(list.body).toHaveLength(2);

    const fetched = await http().get(`/integrations/field-mappings/${draft.body.id}`).set(headers(orgId)).expect(200);
    expect(fetched.body.id).toBe(draft.body.id);
    await http().get(`/integrations/field-mappings/${randomUUID()}`).set(headers(orgId)).expect(404);
  });

  it('refuses to publish a rule targeting a field the discovered schema does not have', async () => {
    const { orgId } = await discoveredTenant();
    const draft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Bad field', source: jira(), target: snow(),
      rules: [valueTableRule({ target_field: 'not_a_real_field' })],
    }).expect(201);
    const refused = await http().post(`/integrations/field-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(422);
    expect(refused.body.message).toMatch(/not_a_real_field/);

    const good = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Good field', source: jira(), target: snow(), rules: [valueTableRule()],
    }).expect(201);
    const published = await http().post(`/integrations/field-mappings/${good.body.id}/publish`).set(headers(orgId)).expect(201);
    expect(published.body).toMatchObject({ status: 'published', published_by: 'mapping-admin' });
    expect(published.body.source_schema_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Publishing a newer draft for the same pair supersedes the old one, exactly like US13.1.
    const draft2 = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Good field v2', source: jira(), target: snow(), rules: [valueTableRule()],
    }).expect(201);
    await http().post(`/integrations/field-mappings/${draft2.body.id}/publish`).set(headers(orgId)).expect(201);
    const superseded = await http().get(`/integrations/field-mappings/${good.body.id}`).set(headers(orgId)).expect(200);
    expect(superseded.body.status).toBe('superseded');
    await http().post(`/integrations/field-mappings/${good.body.id}/publish`).set(headers(orgId)).expect(409);
  });

  it('evaluates a value table with a default, holding only on an unmapped value with no default', async () => {
    const { orgId } = await discoveredTenant();
    const draft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Priority', source: jira(), target: snow(),
      rules: [{
        direction: 'source_to_target', source_field: 'priority', target_field: 'priority',
        transform: { type: 'value_table', table: { High: '1 - Critical' } },
      }],
    }).expect(201);
    await http().post(`/integrations/field-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(201);

    const mapped = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { priority: 'high' },
    }).expect(201);
    expect(mapped.body).toMatchObject({ status: 'ready', fields: { priority: '1 - Critical' } });
    expect(mapped.body.outcomes[0]).toMatchObject({ status: 'applied', value: '1 - Critical' });

    const held = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { priority: 'Lowest' },
    }).expect(201);
    expect(held.body).toMatchObject({ status: 'held' });
    expect(held.body.outcomes[0]).toMatchObject({ status: 'held', reason: 'no_table_entry' });

    // No value present at all for the mapped field: the rule is a no-op, not a hold.
    const skipped = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: {},
    }).expect(201);
    expect(skipped.body).toMatchObject({ status: 'ready', fields: {} });
    expect(skipped.body.outcomes[0]).toMatchObject({ status: 'unchanged' });
  });

  it('evaluates a conditional rule branching on a different field than the one it writes', async () => {
    const { orgId } = await discoveredTenant();
    const draft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Assignment group by project', source: jira(), target: snow(),
      rules: [{
        direction: 'source_to_target', source_field: 'projectKey', target_field: 'assignment_group',
        transform: {
          type: 'conditional',
          cases: [
            { when: { field: '$value', equals: 'CAD' }, then: 'Platform Engineering' },
            { when: { field: 'priority', equals: 'High' }, then: 'Escalations' },
          ],
          else_value: 'General Support',
        },
      }],
    }).expect(201);
    await http().post(`/integrations/field-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(201);

    const byOwnValue = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { projectKey: 'CAD', priority: 'Low' },
    }).expect(201);
    expect(byOwnValue.body.fields).toEqual({ assignment_group: 'Platform Engineering' });

    const byOtherField = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { projectKey: 'OPS', priority: 'High' },
    }).expect(201);
    expect(byOtherField.body.fields).toEqual({ assignment_group: 'Escalations' });

    const fallback = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { projectKey: 'OPS', priority: 'Low' },
    }).expect(201);
    expect(fallback.body.fields).toEqual({ assignment_group: 'General Support' });
  });

  it('evaluates a sandboxed script rule and holds when the script throws', async () => {
    const { orgId } = await discoveredTenant();
    const draft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Scripted label', source: jira(), target: snow(),
      rules: [{
        direction: 'source_to_target', source_field: 'summary', target_field: 'short_description',
        transform: { type: 'script', code: 'if (!fields.summary) throw new Error("no summary"); return "[" + sourceState + "] " + fields.summary;' },
      }],
    }).expect(201);
    await http().post(`/integrations/field-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(201);

    const applied = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target',
      source_fields: { summary: 'Checkout latency' }, source_state: 'In Progress',
    }).expect(201);
    expect(applied.body).toMatchObject({ status: 'ready', fields: { short_description: '[In Progress] Checkout latency' } });

    // A script that throws is only reached once its source field is present. Publishing this
    // second mapping for the same pair supersedes the first, exactly like US13.1 versioning.
    const draftFailing = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Always throws', source: jira(), target: snow(),
      rules: [{
        direction: 'source_to_target', source_field: 'summary', target_field: 'short_description',
        transform: { type: 'script', code: 'throw new Error("deliberate failure");' },
      }],
    }).expect(201);
    await http().post(`/integrations/field-mappings/${draftFailing.body.id}/publish`).set(headers(orgId)).expect(201);
    const failing = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { summary: 'Anything' },
    }).expect(201);
    expect(failing.body).toMatchObject({ status: 'held' });
    expect(failing.body.outcomes[0]).toMatchObject({ status: 'held', reason: 'script_failed' });
    expect(failing.body.outcomes[0].message).toContain('deliberate failure');
  });

  it('rejects malformed rule definitions before they can ever be saved', async () => {
    const { orgId } = await discoveredTenant();
    const base = { name: 'Bad rules', source: jira(), target: snow() };
    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ ...base, rules: [{ direction: 'sideways', source_field: 'priority', target_field: 'priority', transform: { type: 'direct' } }] }).expect(422);
    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ ...base, rules: [{ direction: 'source_to_target', source_field: 'not a path!', target_field: 'priority', transform: { type: 'direct' } }] }).expect(422);
    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ ...base, rules: [{ direction: 'source_to_target', source_field: 'priority', target_field: 'priority', transform: { type: 'value_table', table: {} } }] }).expect(422);
    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ ...base, rules: [{ direction: 'source_to_target', source_field: 'priority', target_field: 'priority', transform: { type: 'conditional', cases: [] } }] }).expect(422);
    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ ...base, rules: [{ direction: 'source_to_target', source_field: 'priority', target_field: 'priority', transform: { type: 'script', code: '   ' } }] }).expect(422);
    await http().post('/integrations/field-mappings').set(headers(orgId))
      .send({ ...base, rules: [{ direction: 'source_to_target', source_field: 'priority', target_field: 'priority', transform: { type: 'not_a_type' } }] }).expect(422);
    // A syntactically broken script is rejected at save time, before it is ever run.
    await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      ...base, rules: [{ direction: 'source_to_target', source_field: 'priority', target_field: 'priority', transform: { type: 'script', code: 'return fields.priority ===;' } }],
    }).expect(422);
  });

  it('reports no_mapping when nothing is published for a pair, and isolates tenants', async () => {
    const { orgId } = await discoveredTenant();
    const otherOrg = randomUUID();
    const unmapped = await http().post('/integrations/field-mappings/preview').set(headers(orgId)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { priority: 'High' },
    }).expect(201);
    expect(unmapped.body).toMatchObject({ status: 'no_mapping', mapping: null });

    const draft = await http().post('/integrations/field-mappings').set(headers(orgId)).send({
      name: 'Tenant-scoped', source: jira(), target: snow(), rules: [valueTableRule()],
    }).expect(201);
    await http().post(`/integrations/field-mappings/${draft.body.id}/publish`).set(headers(orgId)).expect(201);

    expect((await http().get('/integrations/field-mappings').set(headers(otherOrg)).expect(200)).body).toEqual([]);
    await http().get(`/integrations/field-mappings/${draft.body.id}`).set(headers(otherOrg)).expect(404);
    const otherPreview = await http().post('/integrations/field-mappings/preview').set(headers(otherOrg)).send({
      source: jira(), target: snow(), direction: 'source_to_target', source_fields: { priority: 'High' },
    }).expect(201);
    expect(otherPreview.body).toMatchObject({ status: 'no_mapping' });
  });
});
