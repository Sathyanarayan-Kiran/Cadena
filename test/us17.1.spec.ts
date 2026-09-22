import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { ConnectorService } from '../src/modules/connectors/connector.service';
import { JiraConnectorAdapter } from '../src/modules/connectors/jira-connector.adapter';
import { ServiceNowConnectorAdapter } from '../src/modules/connectors/servicenow-connector.adapter';
import { SecretManagerResolver } from '../src/modules/connectors/secret-manager-ref';

describe('US17.1 — Native Connectors, Discovery and Ingestion', () => {
  let app: INestApplication;
  const database = DatabaseService.getInstance();
  let connectorService: ConnectorService;
  const orgId = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    connectorService = app.get(ConnectorService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const headers = (actor = 'admin') => ({
    'x-org-id': orgId,
    'x-actor-id': actor,
  });

  it('resolves secret references without storing plaintext credentials in cleartext', () => {
    process.env.TEST_JIRA_TOKEN = 'secret-api-token-12345';

    const resolved = SecretManagerResolver.resolveSecret('env:TEST_JIRA_TOKEN');
    expect(resolved).toBe('secret-api-token-12345');

    const sanitized = SecretManagerResolver.sanitizeConfigForStorage({
      baseUrl: 'https://jira.example.com',
      credentials: {
        apiToken: 'env:TEST_JIRA_TOKEN',
        rawSecret: 'my-plaintext-password',
      },
    });

    expect(sanitized.credentials.apiToken).toBe('env:TEST_JIRA_TOKEN');
    expect(sanitized.credentials.rawSecret).toBe('secret-ref://rawsecret');
  });

  it('registers a native Jira connector, tests connection, and discovers project/field schemas via API', async () => {
    const jiraAdapter = new JiraConnectorAdapter([
      {
        id: '10001',
        key: 'CAD-101',
        summary: 'Ingest external tickets',
        status: 'To Do',
        description: 'Native connector ingestion',
        updatedAt: '2026-09-22T10:00:00.000Z',
      },
    ]);
    connectorService.registerAdapter(jiraAdapter);

    // 1. Create connector via POST /integrations/connectors
    const createRes = await request(app.getHttpServer())
      .post('/integrations/connectors')
      .set(headers())
      .send({
        name: 'Production Jira SDLC',
        provider: 'jira',
        baseUrl: 'https://jira.acme.com',
        credentials: { apiToken: 'env:JIRA_TOKEN' },
        projectKeys: ['CAD'],
      })
      .expect(201);

    const connector = createRes.body;
    expect(connector.id).toBeDefined();
    expect(connector.provider).toBe('jira');
    expect(connector.status).toBe('unconfigured');
    expect(connector.config.credentials).toEqual({ apiToken: 'env:JIRA_TOKEN' });

    // 2. Test connection via POST /integrations/connectors/:id/test
    const testRes = await request(app.getHttpServer())
      .post(`/integrations/connectors/${connector.id}/test`)
      .set(headers())
      .expect(201);

    expect(testRes.body.success).toBe(true);
    expect(testRes.body.status).toBe('connected');

    // 3. Discover schema via POST /integrations/connectors/:id/discover
    const discoverRes = await request(app.getHttpServer())
      .post(`/integrations/connectors/${connector.id}/discover`)
      .set(headers())
      .expect(201);

    const discovery = discoverRes.body;
    expect(discovery.provider).toBe('jira');
    expect(discovery.entities.length).toBeGreaterThan(0);

    const issueEntity = discovery.entities.find((e: any) => e.entityType === 'issue');
    expect(issueEntity).toBeDefined();

    const summaryField = issueEntity?.fields.find((f: any) => f.id === 'summary');
    expect(summaryField?.required).toBe(true);

    const customField = issueEntity?.fields.find((f: any) => f.custom);
    expect(customField).toBeDefined();

    // 4. Verify updated status
    const getRes = await request(app.getHttpServer())
      .get(`/integrations/connectors/${connector.id}`)
      .set(headers())
      .expect(200);

    expect(getRes.body.status).toBe('active');
    expect(getRes.body.discoveryMetadata?.supportedCapabilities).toContain('jql_incremental_sync');
  });

  it('ingests external records into canonical twins and maintains immutable correlation nodes', async () => {
    const jiraAdapter = new JiraConnectorAdapter([
      {
        id: '10001',
        key: 'CAD-101',
        summary: 'Ingest external tickets',
        status: 'To Do',
        description: 'First ingestion test',
        updatedAt: '2026-09-22T10:00:00.000Z',
      },
      {
        id: '10002',
        key: 'CAD-102',
        summary: 'Sync ServiceNow incidents',
        status: 'In Progress',
        updatedAt: '2026-09-22T10:05:00.000Z',
      },
    ]);
    connectorService.registerAdapter(jiraAdapter);

    const createRes = await request(app.getHttpServer())
      .post('/integrations/connectors')
      .set(headers())
      .send({
        name: 'Jira Ingestion Test',
        provider: 'jira',
        projectKeys: ['CAD'],
      })
      .expect(201);

    const connectorId = createRes.body.id;

    // Trigger sync poll via POST /integrations/connectors/:id/sync
    const syncRes = await request(app.getHttpServer())
      .post(`/integrations/connectors/${connectorId}/sync`)
      .set(headers())
      .expect(201);

    expect(syncRes.body.fetchedCount).toBe(2);
    expect(syncRes.body.twinsCreated).toBe(2);

    // Query canonical twins via GET /integrations/connectors/:id/twins
    const twinsRes = await request(app.getHttpServer())
      .get(`/integrations/connectors/${connectorId}/twins`)
      .set(headers())
      .expect(200);

    const twins = twinsRes.body;
    expect(twins.length).toBe(2);

    const twin101 = twins.find((t: any) => t.externalId === '10001');
    expect(twin101).toBeDefined();
    expect(twin101?.nativeKey).toBe('CAD-101');
    expect(twin101?.syncState).toBe('synced');
    expect(twin101?.correlationNodeId).toBeDefined();
    expect(twin101?.fieldAuthority.summary).toBe('jira');

    // Update issue and re-sync -> proves update without duplicate twin
    jiraAdapter.addFixtureItem({
      id: '10001',
      key: 'CAD-101',
      summary: 'Ingest external tickets (Updated)',
      status: 'In Progress',
      description: 'First ingestion test',
      updatedAt: '2026-09-22T10:15:00.000Z',
    });

    const secondSyncRes = await request(app.getHttpServer())
      .post(`/integrations/connectors/${connectorId}/sync`)
      .set(headers())
      .expect(201);

    expect(secondSyncRes.body.fetchedCount).toBe(2);
    expect(secondSyncRes.body.twinsCreated).toBe(0);
    expect(secondSyncRes.body.twinsUpdated).toBe(2);

    const updatedTwinsRes = await request(app.getHttpServer())
      .get(`/integrations/connectors/${connectorId}/twins`)
      .set(headers())
      .expect(200);

    expect(updatedTwinsRes.body.length).toBe(2);
    const updatedTwin = updatedTwinsRes.body.find((t: any) => t.externalId === '10001');
    expect(updatedTwin?.payload.summary).toBe('Ingest external tickets (Updated)');
    expect(updatedTwin?.payload.status).toBe('In Progress');
  });

  it('supports ServiceNow adapter boundary for ITSM table discovery and twin ingestion', async () => {
    const snAdapter = new ServiceNowConnectorAdapter([
      {
        sys_id: 'sn_inc_9901',
        number: 'INC0019901',
        short_description: 'Database connection pool exhausted',
        state: 'New',
        sys_updated_on: '2026-09-22T11:00:00.000Z',
      },
    ]);
    connectorService.registerAdapter(snAdapter);

    const createRes = await request(app.getHttpServer())
      .post('/integrations/connectors')
      .set(headers())
      .send({
        name: 'ServiceNow Production ITSM',
        provider: 'servicenow',
        tableNames: ['incident', 'change_request'],
      })
      .expect(201);

    const connectorId = createRes.body.id;

    const discoverRes = await request(app.getHttpServer())
      .post(`/integrations/connectors/${connectorId}/discover`)
      .set(headers())
      .expect(201);

    expect(discoverRes.body.provider).toBe('servicenow');
    expect(discoverRes.body.entities.map((e: any) => e.entityType)).toContain('incident');

    const syncRes = await request(app.getHttpServer())
      .post(`/integrations/connectors/${connectorId}/sync`)
      .set(headers())
      .expect(201);

    expect(syncRes.body.fetchedCount).toBe(1);
    expect(syncRes.body.twinsCreated).toBe(1);

    const twinsRes = await request(app.getHttpServer())
      .get(`/integrations/connectors/${connectorId}/twins`)
      .set(headers())
      .expect(200);

    expect(twinsRes.body.length).toBe(1);
    expect(twinsRes.body[0].nativeKey).toBe('INC0019901');
    expect(twinsRes.body[0].provider).toBe('servicenow');
  });
});
