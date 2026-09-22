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
import { WorkflowService } from '../src/modules/workflow/workflow.service';
import { ExternallyOwnedWorkItemError } from '../src/modules/work-items/work-item-ownership';
import { postGitAndWait } from './integration-webhook-helpers';

process.env.PROJ_JIRA_TOKEN = 'jira-token-value';
process.env.PROJ_SNOW_PASSWORD = 'snow-password-value';

describe('Twin-backed WorkItem projection', () => {
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
  const headers = (orgId: string, actor = 'ops.lead') => ({ 'x-org-id': orgId, 'x-actor-id': actor });

  /** A tenant with one team, an owner and a team lead, as the SLA and notification engines expect. */
  const tenant = async () => {
    const orgId = randomUUID();
    const teamId = randomUUID();
    const ownerId = randomUUID();
    const leadId = randomUUID();
    await database.db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'Projection tenant')`, [orgId]);
    await database.db.query(`INSERT INTO teams (id, org_id, name, business_unit) VALUES ($1, $2, 'Payments', 'Commerce')`, [teamId, orgId]);
    await database.db.query(
      `INSERT INTO people (id, org_id, team_id, name, email, role) VALUES
       ($1, $3, $4, 'Priya Owner', 'priya@acme.test', 'developer'),
       ($2, $3, $4, 'Lee Lead', 'lee@acme.test', 'team_lead')`,
      [ownerId, leadId, orgId, teamId],
    );
    return { orgId, teamId, ownerId, leadId };
  };

  const onboard = async (orgId: string, config: Record<string, unknown>) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    const id = created.body.id as string;
    for (const step of ['test', 'discover', 'activate', 'sync']) {
      await http().post(`/integrations/connectors/${id}/${step}`).set(headers(orgId)).expect(201);
    }
    return id;
  };

  const sync = (orgId: string, id: string) => http().post(`/integrations/connectors/${id}/sync`).set(headers(orgId)).expect(201);

  const scenario = async (options: { writeBack?: boolean; ownerMap?: boolean } = {}) => {
    const t = await tenant();
    const jira = new FakeJiraApi();
    const snow = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snow.fetch));
    const story = jira.addIssue({ key: 'CAD-42', summary: 'Checkout latency fix', status: 'In Progress', priority: 'High' });
    const epic = jira.addIssue({ key: 'CAD-40', summary: 'Checkout reliability', status: 'To Do', priority: 'Medium', issueType: 'Epic' });
    const incident = snow.addRecord('incident', { short_description: 'Checkout slow for EU', state: '2', priority: '1' });
    const jiraId = await onboard(t.orgId, {
      name: 'Jira Cloud',
      provider: 'jira',
      baseUrl: 'https://acme.atlassian.net',
      credentials: { apiToken: 'env:PROJ_JIRA_TOKEN' },
      options: { accountEmail: 'sync@acme.test' },
      projectKeys: ['CAD'],
      writeBack: { state: Boolean(options.writeBack) },
    });
    const snowId = await onboard(t.orgId, {
      name: 'ServiceNow ITSM',
      provider: 'servicenow',
      baseUrl: 'https://acme.service-now.com',
      credentials: { password: 'env:PROJ_SNOW_PASSWORD' },
      options: { username: 'svc.cadena' },
      tableNames: ['incident'],
      ...(options.ownerMap ? { projection: { ownerMap: { 'Priya Owner': t.ownerId } } } : {}),
    });
    const items = async () => (await http().get('/workitems').set(headers(t.orgId)).expect(200)).body as any[];
    const byKey = async (key: string) => (await items()).find((item) => item.key === key);
    return { ...t, jira, snow, story, epic, incident, jiraId, snowId, items, byKey };
  };

  it('projects every twin as one governed WorkItem with source provenance', async () => {
    const { orgId, teamId, items, byKey, incident, story, jiraId } = await scenario();
    const all = await items();
    expect(all).toHaveLength(3);
    expect(all.every((item) => item.origin === 'connector' && item.team_id === teamId)).toBe(true);

    const jiraStory = await byKey('CAD-42');
    expect(jiraStory).toMatchObject({
      type: 'story',
      title: 'Checkout latency fix',
      status: 'In Progress',
      priority: 'P1',
      severity: null,
      source: {
        system: 'jira',
        connector_id: jiraId,
        native_key: 'CAD-42',
        native_url: 'https://acme.atlassian.net/browse/CAD-42',
      },
    });
    expect(jiraStory.entered_state_at).toBe(new Date(story.updated).toISOString());
    const snowIncident = await byKey(incident.number);
    expect(snowIncident).toMatchObject({ type: 'incident', status: 'In Progress', priority: 'P0', severity: 'SEV1' });
    expect(snowIncident.created_at).toBe(new Date(Math.floor(incident.sys_updated_on / 1000) * 1000).toISOString());

    const twins = (await http().get('/workspace/twins').set(headers(orgId)).expect(200)).body;
    const twin = twins.find((row: any) => row.nativeKey === 'CAD-42');
    expect(twin.projection).toMatchObject({ status: 'projected', workItemId: jiraStory.id, workItemKey: 'CAD-42', workItemType: 'story', agingBucket: 'green' });
    expect(jiraStory.source.twin_id).toBe(twin.id);

    const created = (await database.db.query<any>(
      `SELECT actor_type, actor_id FROM domain_events WHERE work_item_id = $1 AND event_type = 'WorkItemCreated'`,
      [jiraStory.id],
    )).rows;
    expect(created).toEqual([{ actor_type: 'integration', actor_id: `connector:${jiraId}` }]);
  });

  it('updates the projection only from newer source changes and records native state history', async () => {
    const { orgId, jira, story, jiraId, byKey } = await scenario();
    const before = await byKey('CAD-42');
    const originalSourceTime = before.source.source_updated_at;

    await sync(orgId, jiraId);
    const again = await byKey('CAD-42');
    expect(again.updated_at).toBe(before.updated_at);

    jira.editIssue(story.id, { summary: 'Checkout latency fix (EU)', priority: 'Highest' });
    await sync(orgId, jiraId);
    const renamed = await byKey('CAD-42');
    expect(renamed).toMatchObject({ title: 'Checkout latency fix (EU)', priority: 'P0', status: 'In Progress' });
    const fieldEvents = (await database.db.query<any>(
      `SELECT payload FROM domain_events WHERE work_item_id = $1 AND event_type = 'WorkItemFieldsChanged'`,
      [renamed.id],
    )).rows;
    expect(fieldEvents).toHaveLength(1);
    expect(fieldEvents[0].payload).toMatchObject({
      before: { title: 'Checkout latency fix', priority: 'P1' },
      after: { title: 'Checkout latency fix (EU)', priority: 'P0' },
      source: { system: 'jira', native_key: 'CAD-42' },
    });

    const moved = jira.editIssue(story.id, { status: 'In Review' });
    await sync(orgId, jiraId);
    const reviewed = await byKey('CAD-42');
    expect(reviewed.status).toBe('In Review');
    expect(reviewed.entered_state_at).toBe(new Date(moved.updated).toISOString());
    const history = (await database.db.query<any>(
      `SELECT actor_type, actor_id, payload, timestamp FROM audit_events
       WHERE work_item_id = $1 AND event_type = 'WorkItemStateChanged'`,
      [reviewed.id],
    )).rows;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      actor_type: 'integration',
      actor_id: `connector:${jiraId}`,
      payload: { from_state: 'In Progress', to_state: 'In Review', source: { system: 'jira', native_key: 'CAD-42' } },
    });
    expect(new Date(history[0].timestamp).toISOString()).toBe(new Date(moved.updated).toISOString());

    // A replayed older snapshot never moves the projection backwards.
    const twinId = reviewed.source.twin_id;
    const projection = (connectors as any).projection;
    await projection.projectTwin(orgId, twinId, {
      title: 'Stale title', status: 'To Do', fields: { priority: 'Low' }, sourceUpdatedAt: originalSourceTime,
    });
    expect(await byKey('CAD-42')).toMatchObject({ title: 'Checkout latency fix (EU)', status: 'In Review', priority: 'P0' });
  });

  it('puts twin-backed items under SLA policy, escalation notifications and flow metrics', async () => {
    const { orgId, snow, incident, snowId, ownerId, leadId, byKey } = await scenario({ ownerMap: true });
    snow.editRecord('incident', incident.sys_id, { assigned_to: 'Priya Owner' });
    await sync(orgId, snowId);
    const projected = await byKey(incident.number);
    expect(projected.owner_id).toBe(ownerId);

    await http().post('/sla-policies').set(headers(orgId))
      .send({ item_type: 'incident', state: 'In Progress', threshold_minutes: 30, calendar: '24x7' }).expect(201);
    await http().post('/aging/recompute').set(headers(orgId)).expect(201);
    const aged = await byKey(incident.number);
    expect(aged.aging_bucket).toBe('red');

    const notifications = (await http().get(`/notifications?work_item_id=${aged.id}`).set(headers(orgId)).expect(200)).body;
    const recipients = notifications.filter((n: any) => n.event_type === 'SLABreached').map((n: any) => n.recipient_id).sort();
    expect(recipients).toEqual([ownerId, leadId].sort());

    const twin = (await http().get(`/workspace/twins/${aged.source.twin_id}`).set(headers(orgId)).expect(200)).body;
    expect(twin.projection).toMatchObject({ agingBucket: 'red', ownerId });

    // Resolution in ServiceNow becomes restore-time evidence for the flow metrics.
    snow.editRecord('incident', incident.sys_id, { state: '6' });
    await sync(orgId, snowId);
    expect((await byKey(incident.number)).status).toBe('Resolved');
    const metrics = (await http().get('/metrics/flow').set(headers(orgId)).expect(200)).body;
    expect(metrics.dora.time_to_restore_service.count).toBe(1);
    expect(metrics.itil.incidents_resolved).toBe(1);
  });

  it('mirrors counterpart correlations as Cadena-owned traceability links', async () => {
    const { orgId, byKey, incident, story } = await scenario();
    await http().post('/integrations/correlations').set(headers(orgId)).send({
      source: { system: 'servicenow', entity_type: 'incident', immutable_id: incident.sys_id },
      target: { system: 'jira', entity_type: 'issue', immutable_id: story.id },
    }).expect(201);
    const jiraStory = await byKey('CAD-42');
    const snowIncident = await byKey(incident.number);
    const rels = (await http().get(`/workitems/${jiraStory.id}/relationships`).set(headers(orgId)).expect(200)).body;
    expect(rels.all).toEqual([expect.objectContaining({ link_type: 'relates_to' })]);
    expect([rels.all[0].source_id, rels.all[0].target_id].sort()).toEqual([jiraStory.id, snowIncident.id].sort());
    const graph = (await http().get(`/workitems/${jiraStory.id}/lineage-graph?depth=2`).set(headers(orgId)).expect(200)).body;
    expect(JSON.stringify(graph)).toContain(snowIncident.id);

    // Traceability is Cadena's domain: operators may add links to twin-backed items.
    const epic = await byKey('CAD-40');
    expect(epic.type).toBe('epic');
    await http().post(`/workitems/${jiraStory.id}/links`).set(headers(orgId)).send({ target_id: epic.id, link_type: 'child_of' }).expect(201);

    // Re-synchronizing does not duplicate the mirrored link.
    const count = (await database.db.query<any>(
      `SELECT COUNT(*)::int AS n FROM work_item_links WHERE origin = 'correlation' AND (source_id = $1 OR target_id = $1)`,
      [jiraStory.id],
    )).rows[0].n;
    expect(count).toBe(1);
  });

  it('refuses local edits to source-owned fields and routes state changes through the connector', async () => {
    const { orgId, jira, story, jiraId, byKey, leadId } = await scenario();
    // Transitions resolve the caller's RBAC role, which requires a person id.
    const asLead = { ...headers(orgId, leadId) };
    const item = await byKey('CAD-42');

    const patched = await http().patch(`/workitems/${item.id}`).set(headers(orgId)).send({ title: 'Renamed in Cadena' }).expect(409);
    expect(patched.body).toMatchObject({ error: 'externally_owned', authority: 'jira', fields: ['title'], twin_id: item.source.twin_id });
    expect(patched.body.message).toMatch(/CAD-42 is owned by Jira/);
    await http().patch(`/workitems/${item.id}`).set(headers(orgId)).send({ priority: 'P0', owner_id: randomUUID() }).expect(409);
    const tagged = await http().patch(`/workitems/${item.id}`).set(headers(orgId)).send({ tags: ['customer-impact'] }).expect(200);
    expect(tagged.body).toMatchObject({ tags: ['customer-impact'], title: 'Checkout latency fix' });

    const offered = (await http().get(`/workitems/${item.id}/available-transitions`).set(headers(orgId)).expect(200)).body;
    expect(offered).toMatchObject({ governed_by: 'connector', authority: 'jira', editable: false, transitions: [] });
    expect(offered.message).toMatch(/write-back is disabled/);
    const refused = await http().post(`/workitems/${item.id}/transitions`).set(asLead).send({ to_state: 'Done' }).expect(422);
    expect(refused.body).toMatchObject({ decision: 'blocked', reason: 'write_back_disabled' });
    expect(jira.countRequests('POST', '/transitions')).toBe(0);
    expect((await byKey('CAD-42')).status).toBe('In Progress');

    // The workflow engine itself refuses to move a twin-backed item, whatever the caller.
    await expect(new WorkflowService().transitionWorkItem({
      workItemId: item.id, orgId, toState: 'Done', actorId: 'script', actorRole: 'team_lead',
    })).rejects.toBeInstanceOf(ExternallyOwnedWorkItemError);

    await http().post(`/integrations/connectors/${jiraId}/write-back`).set(headers(orgId)).send({ state: true }).expect(201);
    const options = (await http().get(`/workitems/${item.id}/available-transitions`).set(headers(orgId)).expect(200)).body;
    expect(options.transitions.map((t: any) => t.to_state)).toEqual(['To Do', 'In Review', 'Done']);
    const routed = await http().post(`/workitems/${item.id}/transitions`).set(asLead).send({ to_state: 'Done' }).expect(201);
    expect(routed.body).toMatchObject({ governed_by: 'connector', decision: 'routed', workOrder: { origin: 'operator_edit', status: 'executed' } });
    expect(jira.issues.get(story.id)!.status).toBe('Done');
    // Not mutated locally; the projection follows the source on the next synchronization.
    expect((await byKey('CAD-42')).status).toBe('In Progress');
    await sync(orgId, jiraId);
    expect((await byKey('CAD-42')).status).toBe('Done');
  });

  it('links Git activity by native key without letting automation move source-owned state', async () => {
    const { orgId, byKey } = await scenario();
    const item = await byKey('CAD-42');
    const webhook = await postGitAndWait(app.getHttpServer(), orgId, `projection-pr-${randomUUID()}`, {
      provider: 'github',
      event_type: 'pull_request',
      repository: 'acme/checkout',
      action: 'merged',
      pull_request: { id: 9901, title: 'Ship CAD-42 latency fix (SHA-256 cache keys)', url: 'https://github.example/acme/checkout/pull/9901', merged: true, state: 'closed' },
    });
    expect(webhook.body.linked_work_item_keys).toEqual(['CAD-42']);
    expect(webhook.body.unresolved_keys).toEqual([]);
    expect(webhook.body.transitions).toEqual([expect.objectContaining({
      work_item_key: 'CAD-42', outcome: 'skipped', reason: expect.stringContaining('owned by Jira'),
    })]);
    expect((await byKey('CAD-42')).status).toBe('In Progress');
  });

  it('holds projection with a visible reason until an owning team is configured, and isolates tenants', async () => {
    const jira = new FakeJiraApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch));
    jira.addIssue({ key: 'CAD-77', summary: 'Needs a team', status: 'To Do' });
    const orgId = randomUUID();
    await database.db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'Two teams')`, [orgId]);
    const [teamA, teamB] = [randomUUID(), randomUUID()];
    await database.db.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'A'), ($2, $3, 'B')`, [teamA, teamB, orgId]);
    const jiraId = await onboard(orgId, {
      name: 'Jira Cloud', provider: 'jira', baseUrl: 'https://acme.atlassian.net',
      credentials: { apiToken: 'env:PROJ_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' }, projectKeys: ['CAD'],
    });
    expect((await http().get('/workitems').set(headers(orgId)).expect(200)).body).toEqual([]);
    const held = (await http().get('/workspace/twins').set(headers(orgId)).expect(200)).body[0];
    expect(held.projection).toMatchObject({ status: 'held', reason: expect.stringContaining('projection.teamId') });

    await http().post(`/integrations/connectors/${jiraId}/projection`).set(headers(orgId)).send({ teamId: randomUUID() }).expect(400);
    await http().post(`/integrations/connectors/${jiraId}/projection`).set(headers(orgId)).send({ typeMap: { issue: 'task' } }).expect(400);
    const configured = await http().post(`/integrations/connectors/${jiraId}/projection`).set(headers(orgId))
      .send({ teamId: teamB, typeMap: { issue: 'incident' } }).expect(201);
    expect(configured.body.twins).toMatchObject({ projected: 1, held: 0 });
    const [item] = (await http().get('/workitems').set(headers(orgId)).expect(200)).body;
    expect(item).toMatchObject({ key: 'CAD-77', type: 'incident', team_id: teamB, origin: 'connector' });

    const otherOrg = randomUUID();
    expect((await http().get('/workitems').set(headers(otherOrg)).expect(200)).body).toEqual([]);
    await http().patch(`/workitems/${item.id}`).set(headers(otherOrg)).send({ tags: ['x'] }).expect(404);
    await http().post(`/integrations/connectors/${jiraId}/projection`).set(headers(otherOrg)).send({ teamId: teamB }).expect(404);
  });
});
