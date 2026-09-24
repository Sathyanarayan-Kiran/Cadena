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

process.env.US134_JIRA_TOKEN = 'jira-token-value';
process.env.US134_SNOW_PASSWORD = 'snow-password-value';

describe('US13.4 — work-note privacy in comment sync', () => {
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
  const headers = (orgId: string) => ({ 'x-org-id': orgId, 'x-actor-id': 'support.lead' });
  const jiraConfig = (commentSync?: Record<string, unknown>) => ({
    name: 'Jira Cloud', provider: 'jira', baseUrl: 'https://acme.atlassian.net',
    credentials: { apiToken: 'env:US134_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' },
    projectKeys: ['CAD'], ...(commentSync ? { commentSync } : {}),
  });
  const snowConfig = (commentSync?: Record<string, unknown>) => ({
    name: 'ServiceNow ITSM', provider: 'servicenow', baseUrl: 'https://acme.service-now.com',
    credentials: { password: 'env:US134_SNOW_PASSWORD' }, options: { username: 'svc.cadena' },
    tableNames: ['incident'], ...(commentSync ? { commentSync } : {}),
  });
  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    for (const step of ['test', 'discover', 'activate', 'sync']) {
      await http().post(`/integrations/connectors/${created.body.id}/${step}`).set(headers(orgId)).expect(201);
    }
    return created.body.id as string;
  };
  const correlate = (orgId: string, snowId: string, jiraId: string) => http().post('/integrations/correlations').set(headers(orgId)).send({
    source: { system: 'servicenow', entity_type: 'incident', immutable_id: snowId },
    target: { system: 'jira', entity_type: 'issue', immutable_id: jiraId },
  }).expect(201);
  const sync = (orgId: string, connectorId: string) =>
    http().post(`/integrations/connectors/${connectorId}/sync`).set(headers(orgId)).expect(201);

  it('is off by default and does not even ask the provider for comments', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    const issue = jira.addIssue({ key: 'CAD-1340', summary: 'No comment opt-in', status: 'To Do' });
    const connectorId = await onboard(orgId, jiraConfig());
    jira.addComment(issue.id, { body: 'This must stay in Jira.', authorId: 'acct-1' });

    const result = await sync(orgId, connectorId);
    expect(result.body).toMatchObject({ commentsFetched: 0, commentsStored: 0, commentsTransferred: 0 });
    expect(jira.countRequests('GET', `/issue/${issue.id}/comment`)).toBe(0);
    const stored = await database.db.query<any>(`SELECT id FROM integration_public_comments WHERE org_id = $1`, [orgId]);
    expect(stored.rows).toHaveLength(0);
  });

  it('drops ServiceNow work notes inside the adapter, transfers only public comments, and suppresses the returning marker', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    const snow = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snow.fetch));
    const issue = jira.addIssue({ key: 'CAD-1341', summary: 'Customer update', status: 'In Progress' });
    const incident = snow.addRecord('incident', { short_description: 'Customer cannot check out', state: '2' });
    const jiraConnector = await onboard(orgId, jiraConfig({ enabled: true, direction: 'to_source' }));
    const snowConnector = await onboard(orgId, snowConfig({ enabled: true, direction: 'from_source' }));
    await correlate(orgId, incident.sys_id, issue.id);

    snow.addJournal('incident', incident.sys_id, {
      element: 'work_notes', value: 'Database password is visible in the diagnostic dump.',
      authorId: 'agent.private', authorName: 'Private Agent',
    });
    snow.addJournal('incident', incident.sys_id, {
      element: 'comments', value: 'We are investigating and will update you shortly.',
      authorId: 'agent.public', authorName: 'Asha Support',
    });
    const result = await sync(orgId, snowConnector);
    expect(result.body).toMatchObject({ commentsFetched: 1, commentsStored: 1, commentsTransferred: 1 });
    // Internal work notes are never even requested from ServiceNow, not merely dropped after arriving.
    const journalReads = snow.requests.filter((request) => request.path.includes('sys_journal_field'));
    expect(journalReads.length).toBeGreaterThan(0);
    expect(journalReads.every((request) => !decodeURIComponent(request.url).includes('work_notes'))).toBe(true);

    const jiraComments = jira.comments.get(issue.id) || [];
    expect(jiraComments).toHaveLength(1);
    expect(jiraComments[0].body).toContain('We are investigating');
    expect(jiraComments[0].body).toContain('Originally posted by Asha Support (agent.public) in ServiceNow');
    expect(jiraComments[0].body).toMatch(/\[cadena-comment:[0-9a-f-]{36}\]/);
    expect(jiraComments[0].body).not.toContain('password');

    const privateRows = await database.db.query<any>(
      `SELECT body FROM integration_public_comments WHERE org_id = $1 ORDER BY source_created_at`, [orgId],
    );
    expect(privateRows.rows.map((row) => row.body)).toEqual(['We are investigating and will update you shortly.']);

    const twins = (await http().get('/workspace/twins').set(headers(orgId)).expect(200)).body;
    const snowTwin = twins.find((twin: any) => twin.connectorId === snowConnector);
    const jiraTwin = twins.find((twin: any) => twin.connectorId === jiraConnector);
    for (const twin of [snowTwin, jiraTwin]) {
      const detail = (await http().get(`/workspace/twins/${twin.id}`).set(headers(orgId)).expect(200)).body;
      expect(detail.comments).toHaveLength(1);
      expect(detail.comments[0]).toMatchObject({
        body: 'We are investigating and will update you shortly.',
        originalAuthorId: 'agent.public', originalAuthorName: 'Asha Support',
        sourceSystem: 'servicenow', readOnly: true,
      });
    }

    // Let Jira read as well: the comment written by Cadena returns with the marker and is not stored again.
    await http().post(`/integrations/connectors/${jiraConnector}/comment-sync`).set(headers(orgId))
      .send({ enabled: true, direction: 'bidirectional' }).expect(201);
    const echo = await sync(orgId, jiraConnector);
    expect(echo.body.commentsFiltered).toBe(1);
    const afterEcho = await database.db.query<any>(`SELECT id FROM integration_public_comments WHERE org_id = $1`, [orgId]);
    expect(afterEcho.rows).toHaveLength(1);
  });

  it('drops restricted Jira and JSM-internal comments while transferring a public one', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    const snow = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snow.fetch));
    const issue = jira.addIssue({ key: 'CAD-1342', summary: 'JSM privacy', status: 'In Progress' });
    const incident = snow.addRecord('incident', { short_description: 'JSM privacy', state: '2' });
    const jiraConnector = await onboard(orgId, jiraConfig({ enabled: true, direction: 'from_source' }));
    await onboard(orgId, snowConfig({ enabled: true, direction: 'to_source' }));
    await correlate(orgId, incident.sys_id, issue.id);

    jira.addComment(issue.id, { body: 'Visible customer update', authorId: 'acct-public', authorName: 'Jo Engineer' });
    jira.addComment(issue.id, { body: 'Restricted to Developers', authorId: 'acct-public', visibility: { type: 'role', value: 'Developers' } });
    jira.addComment(issue.id, { body: 'JSM internal diagnostic', authorId: 'acct-public', jsdPublic: false });
    const result = await sync(orgId, jiraConnector);
    expect(result.body).toMatchObject({ commentsFetched: 1, commentsStored: 1, commentsTransferred: 1 });
    const publicEntries = snow.journals.filter((entry) => entry.element === 'comments');
    expect(publicEntries).toHaveLength(1);
    expect(publicEntries[0].value).toContain('Visible customer update');
    expect(publicEntries[0].value).not.toContain('Restricted');
    expect(publicEntries[0].value).not.toContain('diagnostic');
  });

  it('enforces source author allow/block lists and target direction independently', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi();
    const snow = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snow.fetch));
    const issue = jira.addIssue({ key: 'CAD-1343', summary: 'Author policy', status: 'To Do' });
    const incident = snow.addRecord('incident', { short_description: 'Author policy', state: '1' });
    const jiraConnector = await onboard(orgId, jiraConfig({
      enabled: true, direction: 'from_source', authorAllowList: ['acct-allowed', 'acct-blocked'], authorBlockList: ['acct-blocked'],
    }));
    const snowConnector = await onboard(orgId, snowConfig({ enabled: true, direction: 'to_source' }));
    await correlate(orgId, incident.sys_id, issue.id);

    jira.addComment(issue.id, { body: 'Allowed update', authorId: 'acct-allowed', authorName: 'Allowed Author' });
    jira.addComment(issue.id, { body: 'Not on allow-list', authorId: 'acct-other', authorName: 'Other Author' });
    jira.addComment(issue.id, { body: 'Block-list wins', authorId: 'acct-blocked', authorName: 'Blocked Author' });
    const first = await sync(orgId, jiraConnector);
    expect(first.body).toMatchObject({ commentsFetched: 3, commentsStored: 1, commentsFiltered: 2, commentsTransferred: 1 });
    expect(snow.journals.filter((entry) => entry.element === 'comments')).toHaveLength(1);

    await http().post(`/integrations/connectors/${snowConnector}/comment-sync`).set(headers(orgId))
      .send({ enabled: true, direction: 'from_source' }).expect(201);
    jira.addComment(issue.id, { body: 'Direction must stop this', authorId: 'acct-allowed', authorName: 'Allowed Author' });
    const second = await sync(orgId, jiraConnector);
    expect(second.body).toMatchObject({ commentsStored: 1, commentsTransferred: 0 });
    expect(snow.journals.filter((entry) => entry.element === 'comments')).toHaveLength(1);
  });

  it('validates and audits connector comment policy without exposing another tenant', async () => {
    const orgId = randomUUID();
    const otherOrg = randomUUID();
    const jira = new FakeJiraApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    jira.addIssue({ key: 'CAD-1344', summary: 'Policy audit', status: 'To Do' });
    const connectorId = await onboard(orgId, jiraConfig());

    await http().post(`/integrations/connectors/${connectorId}/comment-sync`).set(headers(orgId))
      .send({ enabled: true, direction: 'sideways' }).expect(400);
    const configured = await http().post(`/integrations/connectors/${connectorId}/comment-sync`).set(headers(orgId))
      .send({ enabled: true, direction: 'from_source', authorAllowList: ['acct-1'], authorBlockList: ['acct-2'] }).expect(201);
    expect(configured.body.config.commentSync).toEqual({
      enabled: true, direction: 'from_source', authorAllowList: ['acct-1'], authorBlockList: ['acct-2'],
    });
    await http().post(`/integrations/connectors/${connectorId}/comment-sync`).set(headers(otherOrg))
      .send({ enabled: false }).expect(404);
    const events = await database.db.query<any>(
      `SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'ConnectorCommentSyncConfigured'`, [orgId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.after).toMatchObject({ enabled: true, direction: 'from_source' });
  });
});
