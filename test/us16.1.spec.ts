import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { ConnectorService } from '../src/modules/connectors/connector.service';
import { ConnectorContext } from '../src/modules/connectors/connector.interface';
import { ConnectorRemoteError, parseRetryAfterSeconds } from '../src/modules/connectors/connector-http';
import { JiraConnectorAdapter } from '../src/modules/connectors/jira-connector.adapter';
import { ServiceNowConnectorAdapter } from '../src/modules/connectors/servicenow-connector.adapter';
import { ConnectorRateGovernor } from '../src/modules/connectors/rate-governor';
import { ConnectorRateGovernancePolicy, ConnectorRecord } from '../src/modules/connectors/connector.types';
import { FakeJiraApi } from '../src/modules/connectors/sandbox/provider-sandbox';

process.env.CADENA_NATIVE_QUERY_SCHEDULER = 'disabled';
process.env.CADENA_BACKFILL_SCHEDULER = 'disabled';
process.env.US161_JIRA_TOKEN = 'fake-token';

const policy = (overrides: Partial<ConnectorRateGovernancePolicy> = {}): ConnectorRateGovernancePolicy => ({
  requestsPerMinute: 600,
  headroomPercentage: 90,
  maxConcurrent: 4,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  jitterRatio: 0.2,
  ...overrides,
});

const context = (orgId: string, rateGovernance: ConnectorRateGovernancePolicy, baseUrl = `https://${randomUUID()}.example.test`): ConnectorContext => ({
  baseUrl,
  credentials: {},
  connector: {
    id: randomUUID(), orgId, provider: 'jira', name: 'Target', status: 'active',
    config: { baseUrl, rateGovernance }, syncLagSeconds: 0, consecutiveFailures: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
});

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(check()).toBe(true);
}

describe('US16.1 — shared rate governor', () => {
  beforeAll(async () => DatabaseService.getInstance().initialize());

  it('reserves configured quota headroom and shapes the next request into the next window', async () => {
    let clock = Date.parse('2026-09-24T10:00:00Z');
    const sleeps: number[] = [];
    const governor = new ConnectorRateGovernor({
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      random: () => 0.5,
    });
    const ctx = context(randomUUID(), policy({ requestsPerMinute: 4, headroomPercentage: 50 }));
    const executed: number[] = [];
    for (let index = 0; index < 3; index++) {
      await governor.execute(ctx, async () => { executed.push(index); return index; });
    }
    expect(executed).toEqual([0, 1, 2]);
    expect(sleeps).toEqual([60_000]);
    const [metric] = await governor.listStoredMetrics(ctx.connector.orgId);
    expect(metric.quota).toMatchObject({ requestsPerMinute: 4, headroomPercentage: 50, effectiveLimit: 2, used: 1, remaining: 1 });
    expect(metric.requests).toMatchObject({ total: 3, succeeded: 3, shapedWaitMs: 60_000 });
  });

  it('bounds concurrent sockets and resumes every queued call without loss', async () => {
    const governor = new ConnectorRateGovernor();
    const ctx = context(randomUUID(), policy({ maxConcurrent: 1 }));
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    const calls = [1, 2, 3].map((id) => governor.execute(ctx, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      completed.push(id);
      return id;
    }));
    await until(() => releases.length === 1);
    releases.shift()!();
    await until(() => releases.length === 1);
    releases.shift()!();
    await until(() => releases.length === 1);
    releases.shift()!();
    await expect(Promise.all(calls)).resolves.toHaveLength(3);
    expect(peak).toBe(1);
    expect(completed.sort()).toEqual([1, 2, 3]);
  });

  it('honours Retry-After, then applies jittered exponential backoff when no delay is supplied', async () => {
    let clock = Date.parse('2026-09-24T11:00:00Z');
    const sleeps: number[] = [];
    const governor = new ConnectorRateGovernor({
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      random: () => 0.5,
    });
    const ctx = context(randomUUID(), policy({ baseBackoffMs: 1_000, maxBackoffMs: 8_000, jitterRatio: 0.4 }));

    await expect(governor.execute(ctx, async () => {
      throw new ConnectorRemoteError('quota', 429, true, 3);
    })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 3 });
    const [afterThrottle] = await governor.listStoredMetrics(ctx.connector.orgId);
    expect(Date.parse(afterThrottle.backoff.blockedUntil!)).toBe(clock + 3_000);
    await expect(governor.execute(ctx, async () => 'resumed')).resolves.toBe('resumed');
    expect(sleeps).toEqual([]);

    const pressure = context(randomUUID(), policy({ baseBackoffMs: 1_000, maxBackoffMs: 8_000, jitterRatio: 0.4 }));
    let first: unknown;
    try {
      await governor.execute(pressure, async () => { throw new ConnectorRemoteError('semaphore pressure', 503, true); });
    } catch (error) { first = error; }
    expect(first).toMatchObject({ status: 503, retryAfterSeconds: 1 });
    let second: unknown;
    try {
      await governor.execute(pressure, async () => { throw new ConnectorRemoteError('still overloaded', 503, true); });
    } catch (error) { second = error; }
    expect(second).toMatchObject({ status: 503, retryAfterSeconds: 2 });
    expect(sleeps).toEqual([]);
    const [metric] = await governor.listStoredMetrics(pressure.connector.orgId);
    expect(metric.backoff).toMatchObject({ consecutiveFailures: 2, lastDelayMs: 2_000, semaphorePressureEvents: 2, retryEvents: 2 });
  });

  it('parses both Retry-After wire formats', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(parseRetryAfterSeconds('17', () => now)).toBe(17);
    expect(parseRetryAfterSeconds('Thu, 24 Sep 2026 12:00:09 GMT', () => now)).toBe(9);
    expect(parseRetryAfterSeconds('not-a-delay', () => now)).toBeUndefined();
  });
});

describe('US16.1 — connector pipeline and telemetry', () => {
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
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const headers = (orgId: string) => ({ 'x-org-id': orgId, 'x-actor-id': 'platform-operator' });

  const createJira = async (
    orgId: string,
    name: string,
    baseUrl: string,
    rateGovernance: Partial<ConnectorRateGovernancePolicy> = {},
  ): Promise<ConnectorRecord> => {
    const response = await http().post('/integrations/connectors').set(headers(orgId)).send({
      name, provider: 'jira', baseUrl, authType: 'basic',
      credentials: { apiToken: 'env:US161_JIRA_TOKEN' },
      options: { accountEmail: 'sync@example.test' }, projectKeys: ['CAD'],
      rateGovernance: policy(rateGovernance),
    }).expect(201);
    return response.body;
  };

  it('validates, updates and audits a per-target policy while keeping metrics tenant-scoped', async () => {
    const orgId = randomUUID();
    const connector = await createJira(orgId, 'Primary Jira', 'https://quota.example.test');
    await createJira(orgId, 'Second project', 'https://quota.example.test', {
      requestsPerMinute: 80, headroomPercentage: 50, maxConcurrent: 1,
    });
    const otherOrg = randomUUID();
    await createJira(otherOrg, 'Other tenant', 'https://quota.example.test');

    const invalid = await http().post(`/integrations/connectors/${connector.id}/rate-governance`)
      .set(headers(orgId)).send({ requestsPerMinute: 0 });
    expect(invalid.status).toBe(400);
    expect(String(invalid.body.message)).toMatch(/between 1 and 60000/);

    const updated = await http().post(`/integrations/connectors/${connector.id}/rate-governance`)
      .set(headers(orgId)).send(policy({ requestsPerMinute: 120, headroomPercentage: 75, maxConcurrent: 2 })).expect(201);
    expect(updated.body.config.rateGovernance).toMatchObject({ requestsPerMinute: 120, headroomPercentage: 75, maxConcurrent: 2 });

    const metrics = await http().get('/integrations/connectors/rate-governance').set(headers(orgId)).expect(200);
    expect(metrics.body).toHaveLength(1);
    expect(metrics.body[0].targetOrigin).toBe('https://quota.example.test');
    expect(metrics.body[0].connectors.map((item: any) => item.name).sort()).toEqual(['Primary Jira', 'Second project']);
    expect(metrics.body[0].quota).toMatchObject({ requestsPerMinute: 80, headroomPercentage: 50, effectiveLimit: 40 });
    expect(metrics.body[0].concurrency.limit).toBe(1);
    expect(metrics.body[0].backlog).toEqual({ queued: 0, failed: 0, ingestion: 0, workOrders: 0, comments: 0, backfillChunks: 0 });
    expect(metrics.body[0].targetKey).not.toContain('quota.example.test');
    expect((await http().get('/integrations/connectors/rate-governance').set(headers(otherOrg))).body[0].connectors).toHaveLength(1);

    const event = await database.db.query<any>(
      `SELECT payload FROM domain_events WHERE org_id = $1 AND event_type = 'ConnectorRateGovernanceConfigured' ORDER BY occurred_at DESC LIMIT 1`,
      [orgId],
    );
    expect(event.rows).toHaveLength(1);
    const payload = typeof event.rows[0].payload === 'string' ? JSON.parse(event.rows[0].payload) : event.rows[0].payload;
    expect(payload.after).toMatchObject({ requestsPerMinute: 120, headroomPercentage: 75, maxConcurrent: 2 });
  });

  it('retries one durable write order after a 429 without losing or duplicating it', async () => {
    const orgId = randomUUID();
    const jira = new FakeJiraApi('https://retry.example.test', 'sync@example.test', 'fake-token');
    jira.addIssue({ key: 'CAD-1', summary: 'Before retry', status: 'To Do', updated: Date.now() - 60_000 });
    let clock = Date.now();
    const sleeps: number[] = [];
    const governor = new ConnectorRateGovernor({
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      random: () => 0.5,
    });
    connectors.registerAdapter(new JiraConnectorAdapter(jira.fetch, governor));
    const connector = await createJira(orgId, 'Retry Jira', jira.baseUrl, { requestsPerMinute: 6_000, headroomPercentage: 100 });
    for (const action of ['test', 'discover', 'activate']) {
      await http().post(`/integrations/connectors/${connector.id}/${action}`).set(headers(orgId)).expect(201);
    }
    await http().post(`/integrations/connectors/${connector.id}/sync`).set(headers(orgId)).expect(201);
    const twins = await http().get(`/integrations/connectors/${connector.id}/twins`).set(headers(orgId)).expect(200);
    const twin = twins.body.find((item: any) => item.nativeKey === 'CAD-1');
    expect(twin).toBeTruthy();

    const workOrderId = randomUUID();
    await database.db.query(
      `INSERT INTO integration_connector_work_orders
       (id, org_id, transaction_id, origin, target_connector_id, target_twin_id,
        target_entity_type, target_external_id, target_state, fields, status, source_payload)
       VALUES ($1, $2, NULL, 'operator_edit', $3, $4, 'issue', $5, NULL, $6, 'pending', '{}')`,
      [workOrderId, orgId, connector.id, twin.id, twin.externalId, JSON.stringify({ summary: 'Retried safely' })],
    );
    jira.failNext('PUT', `/rest/api/3/issue/${twin.externalId}`, 429, 1, { 'Retry-After': '2' });

    const first = await http().post(`/integrations/connectors/${connector.id}/sync`).set(headers(orgId)).expect(201);
    expect(first.body.workOrdersFailed).toBe(1);
    let order = (await http().get(`/integrations/connectors/${connector.id}/work-orders`).set(headers(orgId))).body
      .find((item: any) => item.id === workOrderId);
    expect(order).toMatchObject({ status: 'failed', attempts: 1 });
    expect(Date.parse(order.nextAttemptAt)).toBeGreaterThan(Date.now() + 1_000);

    await database.db.query(
      `UPDATE integration_connector_work_orders SET next_attempt_at = CURRENT_TIMESTAMP WHERE id = $1`, [workOrderId],
    );
    const second = await http().post(`/integrations/connectors/${connector.id}/sync`).set(headers(orgId)).expect(201);
    expect(second.body.workOrdersExecuted).toBe(1);
    order = (await http().get(`/integrations/connectors/${connector.id}/work-orders`).set(headers(orgId))).body
      .find((item: any) => item.id === workOrderId);
    expect(order).toMatchObject({ status: 'executed', attempts: 2 });
    expect(jira.issues.get(twin.externalId)?.summary).toBe('Retried safely');
    expect(jira.countRequests('PUT', `/rest/api/3/issue/${twin.externalId}`)).toBe(2);

    const [metric] = (await http().get('/integrations/connectors/rate-governance').set(headers(orgId)).expect(200)).body;
    expect(metric.backoff).toMatchObject({ throttleEvents: 1, retryEvents: 1 });
    expect(metric.requests.failed).toBeGreaterThanOrEqual(1);
  });
});
