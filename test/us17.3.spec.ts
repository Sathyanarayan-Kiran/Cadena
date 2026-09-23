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
import {
  validateEncodedQuery,
  validateJql,
  validateNativeQuery,
  validateWiql,
} from '../src/modules/connectors/native-query/native-query-validator';

process.env.US173_JIRA_TOKEN = 'jira-token-value';
process.env.US173_SNOW_PASSWORD = 'snow-password-value';

const codes = (result: { errors: Array<{ code: string }> }) => result.errors.map((error) => error.code);

/**
 * US17.3 — scheduled native-query triggers.
 *
 * Validation is pure and covered exhaustively here; the definition lifecycle and the scheduled
 * runs are exercised through the API against the local fake providers only.
 */
describe('US17.3 — native query validation', () => {
  describe('JQL', () => {
    it('accepts a project-scoped query and any AND-ed extra filter', () => {
      expect(validateJql('project = "CAD"').valid).toBe(true);
      expect(validateJql('project in ("CAD", "OPS") AND status != Done AND priority = High').valid).toBe(true);
      expect(validateJql('(project = CAD OR project = OPS) AND labels = billing').valid).toBe(true);
    });

    it('blocks a query with no positive scope, naming the clause to add', () => {
      const result = validateJql('status = Open AND priority = High');
      expect(result.valid).toBe(false);
      expect(codes(result)).toEqual(['unbounded_scan']);
      expect(result.errors[0].hint).toContain('project = "CAD"');
    });

    it('does not count negations, text search or a scope on only one OR branch', () => {
      expect(codes(validateJql('project != CAD'))).toEqual(['unbounded_scan']);
      expect(codes(validateJql('text ~ "invoice"'))).toEqual(['unbounded_scan']);
      expect(codes(validateJql('project = CAD OR status = Open'))).toEqual(['unbounded_scan']);
      expect(codes(validateJql('NOT (project = CAD)'))).toEqual(['unbounded_scan']);
    });

    it('rejects an ORDER BY and any filter on the managed "updated" watermark', () => {
      expect(codes(validateJql('project = CAD ORDER BY created DESC'))).toEqual(['order_by_not_allowed']);
      expect(codes(validateJql('project = CAD AND updated >= -7d'))).toEqual(['watermark_conflict']);
      expect(codes(validateJql('project = CAD AND updated > "2026/01/01"'))).toEqual(['watermark_conflict']);
    });

    it('rejects malformed input before analysing scope', () => {
      expect(codes(validateJql(''))).toEqual(['empty_query']);
      expect(codes(validateJql('project = "CAD'))).toEqual(['syntax']);
      expect(codes(validateJql('project in ("CAD"'))).toEqual(['syntax']);
      expect(codes(validateJql('project in ()'))).toEqual(['syntax']);
      expect(codes(validateJql(`project = CAD AND ${'x'.repeat(4100)}`))).toEqual(['query_too_long']);
    });

    it('ignores keywords that sit inside quoted strings', () => {
      expect(validateJql('project = CAD AND summary ~ "fix or die order by now"').valid).toBe(true);
    });
  });

  describe('ServiceNow encoded query', () => {
    it('accepts equality, IN and STARTSWITH scopes', () => {
      expect(validateEncodedQuery('assignment_group=abc123').valid).toBe(true);
      expect(validateEncodedQuery('active=true^categoryINnetwork,hardware').valid).toBe(true);
      expect(validateEncodedQuery('numberSTARTSWITHINC001').valid).toBe(true);
    });

    it('blocks a query with only broad conditions', () => {
      for (const text of ['active=true', 'priority>2', 'short_descriptionLIKEvpn', 'assignment_group!=abc', 'assigned_toISEMPTY']) {
        const result = validateEncodedQuery(text);
        expect(codes(result), text).toEqual(['unbounded_scan']);
        expect(result.errors[0].hint).toContain('assignment_group=<sys_id>');
      }
    });

    it('requires every ^OR alternative and every ^NQ part to be scoped', () => {
      expect(validateEncodedQuery('assignment_group=abc^ORassignment_group=def').valid).toBe(true);
      expect(codes(validateEncodedQuery('assignment_group=abc^ORactive=true'))).toEqual(['unbounded_scan']);
      expect(validateEncodedQuery('assignment_group=abc^NQcategory=network').valid).toBe(true);
      const partial = validateEncodedQuery('assignment_group=abc^NQactive=true');
      expect(codes(partial)).toEqual(['unbounded_scan']);
      expect(partial.errors[0].message).toContain('Query part 2');
    });

    it('rejects ORDERBY and sys_updated_on, and reports unparseable terms', () => {
      expect(codes(validateEncodedQuery('assignment_group=abc^ORDERBYnumber'))).toEqual(['order_by_not_allowed']);
      expect(codes(validateEncodedQuery('assignment_group=abc^ORDERBYDESCsys_created_on'))).toEqual(['order_by_not_allowed']);
      expect(codes(validateEncodedQuery('assignment_group=abc^sys_updated_on>=2026-01-01'))).toContain('watermark_conflict');
      expect(codes(validateEncodedQuery('assignment_group=abc^???'))).toEqual(['syntax']);
      expect(codes(validateEncodedQuery('^'))).toEqual(['empty_query']);
      expect(codes(validateEncodedQuery('^^'))).toEqual(['syntax']);
    });
  });

  describe('WIQL (validation only)', () => {
    it('accepts a scoped query and always warns that it cannot be scheduled', () => {
      const result = validateWiql("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Payments' AND [System.State] = 'Active'");
      expect(result.valid).toBe(true);
      expect(result.warnings.map((warning) => warning.code)).toEqual(['no_runner']);
      expect(validateWiql("SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER 'Payments\\Core'").valid).toBe(true);
    });

    it('blocks a missing WHERE and an unscoped WHERE', () => {
      expect(codes(validateWiql('SELECT [System.Id] FROM WorkItems'))).toEqual(['unbounded_scan']);
      expect(codes(validateWiql('SELECT [System.Id] FROM WorkItems ORDER BY [System.Id]'))).toEqual(['unbounded_scan']);
      expect(codes(validateWiql("SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'"))).toEqual(['unbounded_scan']);
    });

    it('rejects ORDER BY, [System.ChangedDate] and malformed shapes', () => {
      expect(codes(validateWiql("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'P' ORDER BY [System.Id]"))).toEqual(['order_by_not_allowed']);
      expect(codes(validateWiql("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'P' AND [System.ChangedDate] > @Today - 1"))).toEqual(['watermark_conflict']);
      expect(codes(validateWiql('find everything'))).toEqual(['syntax']);
      expect(codes(validateWiql("SELECT [System.Id FROM WorkItems"))).toEqual(['syntax']);
    });

    it('dispatches by language', () => {
      expect(validateNativeQuery('jql', 'status = Open').language).toBe('jql');
      expect(validateNativeQuery('encoded', 'active=true').language).toBe('encoded');
      expect(validateNativeQuery('wiql', 'SELECT [System.Id] FROM WorkItems').language).toBe('wiql');
    });
  });
});

describe('US17.3 — native query definitions', () => {
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
  const headers = (orgId: string, actor = 'integration-specialist') => ({ 'x-org-id': orgId, 'x-actor-id': actor });

  const onboard = async (orgId: string, config: Record<string, unknown>, activate = true) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    const id = created.body.id as string;
    for (const step of activate ? ['test', 'discover', 'activate'] : ['test']) {
      await http().post(`/integrations/connectors/${id}/${step}`).set(headers(orgId)).expect(201);
    }
    return id;
  };

  const tenant = async () => {
    const orgId = randomUUID();
    const jiraApi = new FakeJiraApi();
    const snowApi = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jiraApi.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snowApi.fetch));
    const jiraId = await onboard(orgId, {
      name: 'Jira Cloud', provider: 'jira', baseUrl: 'https://acme.atlassian.net',
      credentials: { apiToken: 'env:US173_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' }, projectKeys: ['CAD'],
    });
    const snowId = await onboard(orgId, {
      name: 'ServiceNow ITSM', provider: 'servicenow', baseUrl: 'https://acme.service-now.com',
      credentials: { password: 'env:US173_SNOW_PASSWORD' }, options: { username: 'svc.cadena' }, tableNames: ['incident'],
    });
    return { orgId, jiraId, snowId, jiraApi, snowApi };
  };

  it('creates a draft bound to a connector, deriving the language from its provider', async () => {
    const { orgId, jiraId, snowId } = await tenant();
    const jql = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'CAD bugs', connector_id: jiraId, entity_type: 'issue', query: 'project = CAD AND issuetype = Bug' }).expect(201);
    expect(jql.body).toMatchObject({ language: 'jql', status: 'draft', interval_seconds: 900, watermark: null, start_from: null });
    expect(jql.body.validation.valid).toBe(true);

    const encoded = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'Net incidents', connector_id: snowId, entity_type: 'incident', query: 'category=network', interval_seconds: 120 }).expect(201);
    expect(encoded.body).toMatchObject({ language: 'encoded', interval_seconds: 120 });

    const listed = await http().get('/integrations/native-queries').set(headers(orgId)).expect(200);
    expect(listed.body.map((query: any) => query.name)).toEqual(['CAD bugs', 'Net incidents']);
  });

  it('keeps an unbounded draft editable and records why it cannot publish', async () => {
    const { orgId, jiraId } = await tenant();
    const draft = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'Everything open', connector_id: jiraId, entity_type: 'issue', query: 'status = Open' }).expect(201);
    expect(draft.body.validation.valid).toBe(false);
    expect(draft.body.validation.errors[0].code).toBe('unbounded_scan');

    const blocked = await http().post(`/integrations/native-queries/${draft.body.id}/publish`).set(headers(orgId)).expect(422);
    expect(blocked.body.error).toBe('invalid_native_query');
    expect(blocked.body.message).toContain('no selective scope');
    expect(blocked.body.message).toContain('project = "CAD"');
    expect(blocked.body.validation.errors[0].code).toBe('unbounded_scan');
    const stillDraft = await http().get(`/integrations/native-queries/${draft.body.id}`).set(headers(orgId)).expect(200);
    expect(stillDraft.body).toMatchObject({ status: 'draft', watermark: null });

    const fixed = await http().patch(`/integrations/native-queries/${draft.body.id}`).set(headers(orgId))
      .send({ query: 'project = CAD AND status = Open' }).expect(200);
    expect(fixed.body.validation.valid).toBe(true);
    const published = await http().post(`/integrations/native-queries/${draft.body.id}/publish`).set(headers(orgId)).expect(201);
    expect(published.body.status).toBe('published');
    expect(published.body.next_run_at).toBeTruthy();
  });

  it('fixes the watermark at publication, from start_from when given', async () => {
    const { orgId, jiraId } = await tenant();
    const startFrom = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const withStart = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'Seeded', connector_id: jiraId, entity_type: 'issue', query: 'project = CAD', start_from: startFrom }).expect(201);
    const published = await http().post(`/integrations/native-queries/${withStart.body.id}/publish`).set(headers(orgId)).expect(201);
    expect(published.body.watermark).toBe(startFrom);

    const before = Date.now();
    const bare = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'From now', connector_id: jiraId, entity_type: 'issue', query: 'project = CAD' }).expect(201);
    const bareDone = await http().post(`/integrations/native-queries/${bare.body.id}/publish`).set(headers(orgId)).expect(201);
    expect(Date.parse(bareDone.body.watermark)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('refuses a published query edit, and resets the watermark when disabled text changes', async () => {
    const { orgId, jiraId } = await tenant();
    const startFrom = new Date(Date.now() - 86_400_000).toISOString();
    const draft = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'Scoped', connector_id: jiraId, entity_type: 'issue', query: 'project = CAD', start_from: startFrom }).expect(201);
    const id = draft.body.id;
    await http().post(`/integrations/native-queries/${id}/publish`).set(headers(orgId)).expect(201);
    await http().patch(`/integrations/native-queries/${id}`).set(headers(orgId)).send({ name: 'Renamed' }).expect(409);

    const disabled = await http().post(`/integrations/native-queries/${id}/disable`).set(headers(orgId)).expect(201);
    expect(disabled.body).toMatchObject({ status: 'disabled', next_run_at: null });
    // Same text: the saved watermark survives a re-publish.
    await database.db.query(`UPDATE integration_native_queries SET watermark = $1 WHERE id = $2`, [new Date(Date.now() - 1000).toISOString(), id]);
    const same = await http().post(`/integrations/native-queries/${id}/publish`).set(headers(orgId)).expect(201);
    expect(Date.parse(same.body.watermark)).toBeGreaterThan(Date.parse(startFrom) + 1000);

    await http().post(`/integrations/native-queries/${id}/disable`).set(headers(orgId)).expect(201);
    await http().patch(`/integrations/native-queries/${id}`).set(headers(orgId)).send({ query: 'project = CAD AND labels = billing' }).expect(200);
    const changed = await http().post(`/integrations/native-queries/${id}/publish`).set(headers(orgId)).expect(201);
    expect(changed.body.watermark).toBe(startFrom);
  });

  it('validates input: connector, entity type, interval, start_from, duplicates and activation', async () => {
    const { orgId, jiraId } = await tenant();
    const base = { name: 'Checks', connector_id: jiraId, entity_type: 'issue', query: 'project = CAD' };
    const create = (overrides: Record<string, unknown>) =>
      http().post('/integrations/native-queries').set(headers(orgId)).send({ ...base, ...overrides });

    await create({ entity_type: 'incident' }).expect(422);
    await create({ interval_seconds: 30 }).expect(422);
    await create({ interval_seconds: 1.5 }).expect(422);
    await create({ start_from: 'yesterday' }).expect(422);
    await create({ start_from: new Date(Date.now() + 3_600_000).toISOString() }).expect(422);
    const tooOld = await create({ start_from: new Date(Date.now() - 400 * 86_400_000).toISOString() }).expect(422);
    expect(tooOld.body.message).toContain('366 days');
    await create({ connector_id: 'not-a-uuid' }).expect(422);
    await create({ connector_id: randomUUID() }).expect(404);
    await create({ name: '   ' }).expect(422);

    await create({}).expect(201);
    await create({}).expect(409);

    const idle = await onboard(orgId, {
      name: 'Idle Jira', provider: 'jira', baseUrl: 'https://idle.atlassian.net',
      credentials: { apiToken: 'env:US173_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' }, projectKeys: ['CAD'],
    }, false);
    const notActive = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ ...base, name: 'On idle', connector_id: idle }).expect(201);
    const refused = await http().post(`/integrations/native-queries/${notActive.body.id}/publish`).set(headers(orgId)).expect(409);
    expect(refused.body.message).toContain('activated');
  });

  it('validates WIQL statelessly but has no runner to schedule it', async () => {
    const { orgId } = await tenant();
    const ok = await http().post('/integrations/native-queries/validate').set(headers(orgId))
      .send({ language: 'wiql', query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Payments'" }).expect(201);
    expect(ok.body).toMatchObject({ valid: true, language: 'wiql' });
    expect(ok.body.warnings[0].code).toBe('no_runner');

    const bad = await http().post('/integrations/native-queries/validate').set(headers(orgId))
      .send({ language: 'wiql', query: 'SELECT [System.Id] FROM WorkItems' }).expect(201);
    expect(bad.body.valid).toBe(false);
    await http().post('/integrations/native-queries/validate').set(headers(orgId)).send({ language: 'sql', query: 'x' }).expect(422);

    const azure = randomUUID();
    await database.db.query(
      `INSERT INTO integration_connectors (id, org_id, name, provider, status, config, created_at, updated_at)
       VALUES ($1, $2, 'ADO', 'azure_devops', 'connected', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [azure, orgId],
    );
    const refused = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'ADO', connector_id: azure, entity_type: 'workitem', query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'P'" })
      .expect(422);
    expect(refused.body.message).toContain('azure_devops has no query runner');
  });

  it('isolates queries by tenant', async () => {
    const { orgId, jiraId } = await tenant();
    const draft = await http().post('/integrations/native-queries').set(headers(orgId))
      .send({ name: 'Private', connector_id: jiraId, entity_type: 'issue', query: 'project = CAD' }).expect(201);
    const other = randomUUID();
    await http().get(`/integrations/native-queries/${draft.body.id}`).set(headers(other)).expect(404);
    await http().post(`/integrations/native-queries/${draft.body.id}/publish`).set(headers(other)).expect(404);
    expect((await http().get('/integrations/native-queries').set(headers(other)).expect(200)).body).toEqual([]);
    await http().get('/integrations/native-queries').expect(400);
  });
});
