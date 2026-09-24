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
import { MAX_CHUNKS_PER_JOB, planChunks } from '../src/modules/connectors/backfill/backfill-planner';
import { BackfillScheduler } from '../src/modules/connectors/backfill/backfill.scheduler';
import {
  AdaptiveLimiter,
  MAX_DELAY_MS,
  RequestPacer,
  SUCCESSES_PER_INCREASE,
  THROTTLE_BASE_DELAY_MS,
} from '../src/modules/connectors/backfill/adaptive-limiter';

process.env.CADENA_NATIVE_QUERY_SCHEDULER = 'disabled';
process.env.CADENA_BACKFILL_SCHEDULER = 'disabled';
process.env.US174_JIRA_TOKEN = 'jira-token-value';
process.env.US174_SNOW_PASSWORD = 'snow-password-value';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * US17.4 — governed bulk synchronization and historical backfill.
 *
 * Planning and adaptive limiting are pure and covered exhaustively; paging, the job lifecycle and
 * the runs are exercised against the local fake providers only.
 */
describe('US17.4 — chunk planning', () => {
  it('partitions a range exactly: contiguous, non-overlapping, with a shorter final chunk', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-04T12:00:00Z');
    const chunks = planChunks(from, to, 86_400);
    expect(chunks).toHaveLength(4);
    expect(chunks[0].windowStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(chunks[3].windowEnd.toISOString()).toBe('2026-01-04T12:00:00.000Z');
    expect(chunks[3].windowEnd.getTime() - chunks[3].windowStart.getTime()).toBe(12 * HOUR);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].windowStart.getTime()).toBe(chunks[index - 1].windowEnd.getTime());
      expect(chunks[index].seq).toBe(index);
    }
  });

  it('gives every instant in the range to exactly one chunk, including the boundaries', () => {
    const from = new Date('2026-03-01T00:00:00Z');
    const to = new Date('2026-03-02T00:00:00Z');
    const chunks = planChunks(from, to, 3600);
    for (let probe = from.getTime(); probe < to.getTime(); probe += 7 * MINUTE) {
      expect(chunks.filter((chunk) => probe >= chunk.windowStart.getTime() && probe < chunk.windowEnd.getTime())).toHaveLength(1);
    }
    // The exclusive end is in no chunk, so adjacent jobs can share a boundary without double-reading it.
    expect(chunks.filter((chunk) => to.getTime() >= chunk.windowStart.getTime() && to.getTime() < chunk.windowEnd.getTime())).toHaveLength(0);
  });

  it('truncates to whole minutes, because provider queries have minute precision', () => {
    const chunks = planChunks(new Date('2026-01-01T00:00:45Z'), new Date('2026-01-01T02:00:59Z'), 3600);
    expect(chunks[0].windowStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(chunks[chunks.length - 1].windowEnd.toISOString()).toBe('2026-01-01T02:00:00.000Z');
  });

  it('rejects impossible plans with an actionable message', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(() => planChunks(from, from, 3600)).toThrow(/earlier than to/);
    expect(() => planChunks(from, new Date(from.getTime() + 30_000), 3600)).toThrow(/earlier than to/);
    expect(() => planChunks(from, new Date(from.getTime() + DAY), 30)).toThrow(/between 60/);
    expect(() => planChunks(from, new Date(from.getTime() + DAY), 90)).toThrow(/multiple of 60/);
    expect(() => planChunks(from, new Date(from.getTime() + DAY), 60.5)).toThrow(/whole number/);
    expect(() => planChunks(from, new Date(from.getTime() + 12 * 366 * DAY), 86_400)).toThrow(/10 years/);
    expect(() => planChunks(new Date('nope'), from, 3600)).toThrow(/valid timestamps/);

    const tooMany = () => planChunks(from, new Date(from.getTime() + 400 * DAY), 3600);
    expect(tooMany).toThrow(new RegExp(`the limit is ${MAX_CHUNKS_PER_JOB}`));
    expect(tooMany).toThrow(/chunk_seconds of at least \d+/);
  });
});

describe('US17.4 — adaptive limiting', () => {
  it('grows concurrency one step per run of successes, up to its ceiling', () => {
    const limiter = new AdaptiveLimiter({ maxConcurrency: 3, maxRequestsPerMinute: 6000 });
    expect(limiter.concurrency).toBe(1);
    for (let index = 0; index < SUCCESSES_PER_INCREASE - 1; index++) limiter.onSuccess();
    expect(limiter.concurrency).toBe(1);
    limiter.onSuccess();
    expect(limiter.concurrency).toBe(2);
    for (let index = 0; index < 20; index++) limiter.onSuccess();
    expect(limiter.concurrency).toBe(3);
  });

  it('halves concurrency and imposes a delay on throttling, then relaxes as the provider recovers', () => {
    const limiter = new AdaptiveLimiter({ maxConcurrency: 8, maxRequestsPerMinute: 6000, initial: { concurrency: 8 } });
    limiter.onThrottle();
    expect(limiter.concurrency).toBe(4);
    expect(limiter.snapshot().delayMs).toBe(THROTTLE_BASE_DELAY_MS);
    limiter.onThrottle();
    expect(limiter.concurrency).toBe(2);
    expect(limiter.snapshot().delayMs).toBe(THROTTLE_BASE_DELAY_MS * 2);
    limiter.onThrottle();
    limiter.onThrottle();
    expect(limiter.concurrency).toBe(1);
    expect(limiter.snapshot().throttleEvents).toBe(4);

    const delayAfterThrottling = limiter.snapshot().delayMs;
    for (let index = 0; index < SUCCESSES_PER_INCREASE; index++) limiter.onSuccess();
    expect(limiter.snapshot().delayMs).toBe(Math.floor(delayAfterThrottling / 2));
    for (let index = 0; index < SUCCESSES_PER_INCREASE * 10; index++) limiter.onSuccess();
    expect(limiter.snapshot().delayMs).toBe(0);
  });

  it('backs off faster than it speeds up', () => {
    const limiter = new AdaptiveLimiter({ maxConcurrency: 8, maxRequestsPerMinute: 6000, initial: { concurrency: 8 } });
    limiter.onThrottle();
    const afterOneThrottle = limiter.concurrency;
    for (let index = 0; index < SUCCESSES_PER_INCREASE; index++) limiter.onSuccess();
    // One throttle removed 4 workers; a whole run of successes restored one.
    expect(limiter.concurrency).toBe(afterOneThrottle + 1);
    expect(limiter.concurrency).toBeLessThan(8);
  });

  it('honours Retry-After, but never waits longer than a minute, and a throttle resets the success streak', () => {
    const limiter = new AdaptiveLimiter({ maxConcurrency: 4, maxRequestsPerMinute: 6000 });
    limiter.onThrottle(7);
    expect(limiter.snapshot().delayMs).toBe(7000);
    limiter.onThrottle(9999);
    expect(limiter.snapshot().delayMs).toBe(MAX_DELAY_MS);

    const fresh = new AdaptiveLimiter({ maxConcurrency: 4, maxRequestsPerMinute: 6000 });
    fresh.onSuccess();
    fresh.onSuccess();
    fresh.onThrottle();
    fresh.onSuccess();
    expect(fresh.concurrency).toBe(1);
  });

  it('applies the per-minute ceiling on top of the adaptive delay, and resumes from saved state', () => {
    const limited = new AdaptiveLimiter({ maxConcurrency: 4, maxRequestsPerMinute: 60 });
    expect(limited.intervalMs).toBe(1000);
    limited.onThrottle(3);
    expect(limited.intervalMs).toBe(3000);

    const resumed = new AdaptiveLimiter({ maxConcurrency: 4, maxRequestsPerMinute: 600, initial: { concurrency: 3, delayMs: 500, throttleEvents: 2 } });
    expect(resumed.snapshot()).toEqual({ concurrency: 3, delayMs: 500, throttleEvents: 2 });
    expect(resumed.intervalMs).toBe(500);
    // A saved concurrency above a lowered ceiling is clamped rather than trusted.
    expect(new AdaptiveLimiter({ maxConcurrency: 2, maxRequestsPerMinute: 60, initial: { concurrency: 8 } }).concurrency).toBe(2);
  });

  it('spaces concurrent request starts by reserving slots on a shared clock', async () => {
    let clock = 1000;
    const slept: number[] = [];
    // Concurrent callers all read the clock in the same tick, so the fake sleep must not move it.
    const pacer = new RequestPacer(() => clock, async (ms) => { slept.push(ms); });
    // Three workers arrive at once: the first goes immediately, the others queue behind it.
    await Promise.all([pacer.acquire(200), pacer.acquire(200), pacer.acquire(200)]);
    expect(slept).toEqual([200, 400]);

    clock += 10_000;
    slept.length = 0;
    await pacer.acquire(200);
    expect(slept).toEqual([]);
  });
});

describe('US17.4 — backfill paging, lifecycle and runs', () => {
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
  const headers = (orgId: string, actor = 'migration-lead') => ({ 'x-org-id': orgId, 'x-actor-id': actor });
  const minuteBase = () => Math.floor((Date.now() - 30 * DAY) / MINUTE) * MINUTE;

  const onboard = async (orgId: string, config: Record<string, unknown>, activate = true) => {
    const created = await http().post('/integrations/connectors').set(headers(orgId)).send(config).expect(201);
    for (const step of activate ? ['test', 'discover', 'activate'] : ['test']) {
      await http().post(`/integrations/connectors/${created.body.id}/${step}`).set(headers(orgId)).expect(201);
    }
    return created.body.id as string;
  };

  const tenant = async (jiraOptions: Record<string, unknown> = {}) => {
    const orgId = randomUUID();
    const jiraApi = new FakeJiraApi();
    const snowApi = new FakeServiceNowApi();
    connectors.registerAdapter(new JiraConnectorAdapter(jiraApi.fetch));
    connectors.registerAdapter(new ServiceNowConnectorAdapter(snowApi.fetch));
    const jiraId = await onboard(orgId, {
      name: 'Jira Cloud', provider: 'jira', baseUrl: 'https://acme.atlassian.net',
      credentials: { apiToken: 'env:US174_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test', ...jiraOptions }, projectKeys: ['CAD'],
    });
    const snowId = await onboard(orgId, {
      name: 'ServiceNow ITSM', provider: 'servicenow', baseUrl: 'https://acme.service-now.com',
      credentials: { password: 'env:US174_SNOW_PASSWORD' }, options: { username: 'svc.cadena' }, tableNames: ['incident'],
    });
    return { orgId, jiraId, snowId, jiraApi, snowApi };
  };

  const createJob = (orgId: string, body: Record<string, unknown>) =>
    http().post('/integrations/backfill-jobs').set(headers(orgId)).send(body);
  const jobBody = (connectorId: string, base: number, overrides: Record<string, unknown> = {}) => ({
    name: 'Historical load', connector_id: connectorId, entity_type: 'issue',
    from: new Date(base).toISOString(), to: new Date(base + 3 * DAY).toISOString(), chunk_seconds: 86_400, ...overrides,
  });

  describe('provider paging', () => {
    const window = (base: number, minutes: number) => ({ from: new Date(base), to: new Date(base + minutes * MINUTE) });
    const connectorOf = async (orgId: string, id: string) => connectors.getConnector(orgId, id);
    const drain = async (orgId: string, id: string, entityType: string, span: { from: Date; to: Date }, query?: string) => {
      const connector = await connectorOf(orgId, id);
      const seen: string[] = [];
      let token: string | undefined;
      let pages = 0;
      do {
        const page = await connectors.fetchBackfillPage(connector, entityType, span, query, token);
        seen.push(...page.records.map((record) => record.nativeKey || record.externalId));
        token = page.nextPageToken;
        pages++;
      } while (token && pages < 50);
      return { seen, pages };
    };

    it('reads a half-open Jira window, confined to the connector project and any operator query', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      jiraApi.addIssue({ key: 'CAD-1', summary: 'At start', status: 'To Do', issueType: 'Bug', updated: base });
      jiraApi.addIssue({ key: 'CAD-2', summary: 'Inside', status: 'To Do', issueType: 'Story', updated: base + 30 * MINUTE });
      jiraApi.addIssue({ key: 'CAD-3', summary: 'At exclusive end', status: 'To Do', issueType: 'Bug', updated: base + 60 * MINUTE });
      jiraApi.addIssue({ key: 'CAD-4', summary: 'Before', status: 'To Do', issueType: 'Bug', updated: base - MINUTE });
      jiraApi.addIssue({ key: 'OPS-1', summary: 'Other project', status: 'To Do', issueType: 'Bug', updated: base + MINUTE });

      const all = await drain(orgId, jiraId, 'issue', window(base, 60));
      expect(all.seen.sort()).toEqual(['CAD-1', 'CAD-2']);
      // The next window starts exactly where this one ended, so CAD-3 is read once, there.
      expect((await drain(orgId, jiraId, 'issue', window(base + 60 * MINUTE, 60))).seen).toEqual(['CAD-3']);
      // An operator query narrows the window but cannot widen it past the connector's project.
      const narrowed = await drain(orgId, jiraId, 'issue', window(base, 60), 'project in (CAD, OPS) AND issuetype = Bug');
      expect(narrowed.seen).toEqual(['CAD-1']);
      const sent: string = jiraApi.requests.filter((entry) => entry.path === '/rest/api/3/search/jql').pop()!.body.jql;
      expect(sent).toContain('(project in (CAD, OPS) AND issuetype = Bug) AND project in ("CAD") AND updated >= "');
      expect(sent).toContain(' AND updated < "');
      expect(sent).toMatch(/ORDER BY updated ASC, key ASC$/);
    });

    it('resumes a Jira window across pages from the continuation token, reading every record once', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      for (let index = 1; index <= 230; index++) {
        jiraApi.addIssue({ key: `CAD-${index}`, summary: `Issue ${index}`, status: 'To Do', updated: base + index * 10_000 });
      }
      const result = await drain(orgId, jiraId, 'issue', window(base, 60));
      expect(result.pages).toBe(3);
      expect(result.seen).toHaveLength(230);
      expect(new Set(result.seen).size).toBe(230);
    });

    it('reads a ServiceNow window and applies it to every ^NQ part of an operator query', async () => {
      const { orgId, snowId, snowApi } = await tenant();
      const base = minuteBase();
      snowApi.addRecord('incident', { short_description: 'Group A', state: '2', assignment_group: 'grpA', sys_updated_on: base + MINUTE });
      snowApi.addRecord('incident', { short_description: 'Network', state: '1', category: 'network', sys_updated_on: base + 2 * MINUTE });
      snowApi.addRecord('incident', { short_description: 'Unrelated', state: '1', category: 'hardware', sys_updated_on: base + 3 * MINUTE });
      snowApi.addRecord('incident', { short_description: 'Before window', state: '1', category: 'network', sys_updated_on: base - HOUR });
      snowApi.addRecord('incident', { short_description: 'At exclusive end', state: '1', category: 'network', sys_updated_on: base + 60 * MINUTE });

      expect((await drain(orgId, snowId, 'incident', window(base, 60))).seen).toHaveLength(3);
      const narrowed = await drain(orgId, snowId, 'incident', window(base, 60), 'assignment_group=grpA^NQcategory=network');
      expect(narrowed.seen).toHaveLength(2);
      const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
      const query = new URL(snowApi.requests.filter((entry) => entry.path === '/api/now/table/incident').pop()!.url).searchParams.get('sysparm_query');
      expect(query).toBe(
        `assignment_group=grpA^sys_updated_on>=${stamp(base)}^sys_updated_on<${stamp(base + 60 * MINUTE)}`
        + `^NQcategory=network^sys_updated_on>=${stamp(base)}^sys_updated_on<${stamp(base + 60 * MINUTE)}^ORDERBYsys_updated_on^ORDERBYsys_id`,
      );
    });

    it('pages ServiceNow by timestamp so records sharing one second are neither skipped nor repeated', async () => {
      const { orgId, snowId, snowApi } = await tenant();
      const base = minuteBase();
      // 230 records in the same second span three pages of 100: every page boundary is inside a tie.
      for (let index = 0; index < 230; index++) {
        snowApi.addRecord('incident', { short_description: `Tie ${index}`, state: '1', sys_id: `tie${String(index).padStart(3, '0')}`, sys_updated_on: base + 5 * MINUTE });
      }
      snowApi.addRecord('incident', { short_description: 'Earlier', state: '1', sys_id: 'early', sys_updated_on: base + MINUTE });
      snowApi.addRecord('incident', { short_description: 'Later', state: '1', sys_id: 'late', sys_updated_on: base + 6 * MINUTE });
      const result = await drain(orgId, snowId, 'incident', window(base, 60));
      expect(result.seen).toHaveLength(232);
      expect(new Set(result.seen).size).toBe(232);

      const connector = await connectorOf(orgId, snowId);
      await expect(connectors.fetchBackfillPage(connector, 'incident', window(base, 60), undefined, 'not-a-token')).rejects.toThrow(/malformed/);
    });
  });

  describe('job lifecycle', () => {
    it('plans a job into persisted chunks without contacting the provider', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      const requestsBefore = jiraApi.requests.length;
      const created = await createJob(orgId, jobBody(jiraId, base)).expect(201);
      expect(created.body).toMatchObject({
        status: 'pending', entity_type: 'issue', chunk_seconds: 86_400, max_concurrency: 4, max_requests_per_minute: 300, language: null,
        limiter: { concurrency: 1, delay_ms: 0, throttle_events: 0 },
      });
      expect(created.body.counts).toEqual({
        chunks: { total: 3, pending: 3, running: 0, done: 0, failed: 0 },
        records: { fetched: 0, enqueued: 0, duplicates: 0 },
        queue: { queued: 0, processed: 0, failed: 0 },
      });
      const chunks = (await http().get(`/integrations/backfill-jobs/${created.body.id}/chunks`).set(headers(orgId)).expect(200)).body;
      expect(chunks.map((chunk: any) => [chunk.seq, chunk.window_start, chunk.window_end, chunk.status])).toEqual([
        [0, new Date(base).toISOString(), new Date(base + DAY).toISOString(), 'pending'],
        [1, new Date(base + DAY).toISOString(), new Date(base + 2 * DAY).toISOString(), 'pending'],
        [2, new Date(base + 2 * DAY).toISOString(), new Date(base + 3 * DAY).toISOString(), 'pending'],
      ]);
      expect(jiraApi.requests.length).toBe(requestsBefore);
      expect((await http().get('/integrations/backfill-jobs').set(headers(orgId)).expect(200)).body).toHaveLength(1);
    });

    it('refuses plans that are unsafe or unusable, and says how to fix them', async () => {
      const { orgId, jiraId, snowId } = await tenant();
      const base = minuteBase();
      const refused = async (body: Record<string, unknown>, status = 422) => (await createJob(orgId, body).expect(status)).body;

      expect((await refused(jobBody(jiraId, base, { entity_type: 'incident' }))).message).toContain('not configured');
      expect((await refused(jobBody(jiraId, base, { chunk_seconds: 30 }))).message).toContain('between 60');
      expect((await refused(jobBody(jiraId, base, { to: new Date(base - DAY).toISOString() }))).message).toContain('earlier than to');
      expect((await refused(jobBody(jiraId, base, { to: new Date(Date.now() + DAY).toISOString() }))).message).toContain('future');
      expect((await refused(jobBody(jiraId, base, { from: 'yesterday' }))).message).toContain('ISO-8601');
      expect((await refused(jobBody(jiraId, base, { max_concurrency: 9 }))).message).toContain('max_concurrency');
      expect((await refused(jobBody(jiraId, base, { max_requests_per_minute: 0 }))).message).toContain('max_requests_per_minute');
      expect((await refused(jobBody(jiraId, base, { name: '  ' }))).message).toContain('name is required');
      const big = await refused(jobBody(jiraId, base, { from: new Date(base - 400 * DAY).toISOString(), to: new Date(base).toISOString(), chunk_seconds: 3600 }));
      expect(big.message).toMatch(/limit is 5000.*chunk_seconds of at least/);
      // An unbounded operator query is refused with the same hint a scheduled query gets.
      const unbounded = await refused(jobBody(jiraId, base, { query: 'status = Open' }));
      expect(unbounded.message).toContain('no selective scope');
      expect(unbounded.validation.errors[0].code).toBe('unbounded_scan');
      expect((await refused(jobBody(snowId, base, { entity_type: 'incident', query: 'active=true' }))).validation.errors[0].code).toBe('unbounded_scan');
      await refused({ ...jobBody(jiraId, base), connector_id: 'not-a-uuid' });
      await refused({ ...jobBody(jiraId, base), connector_id: randomUUID() }, 404);

      const idle = await onboard(orgId, {
        name: 'Idle Jira', provider: 'jira', baseUrl: 'https://idle.atlassian.net',
        credentials: { apiToken: 'env:US174_JIRA_TOKEN' }, options: { accountEmail: 'sync@acme.test' }, projectKeys: ['CAD'],
      }, false);
      expect((await refused(jobBody(idle, base), 409)).message).toContain('activated');

      const azure = randomUUID();
      await database.db.query(
        `INSERT INTO integration_connectors (id, org_id, name, provider, status, config, created_at, updated_at)
         VALUES ($1, $2, 'ADO', 'azure_devops', 'connected', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [azure, orgId],
      );
      expect((await refused(jobBody(azure, base, { entity_type: 'workitem' }))).message).toContain('no backfill adapter');
    });

    it('accepts a valid operator query and records its language', async () => {
      const { orgId, snowId, jiraId } = await tenant();
      const base = minuteBase();
      const encoded = await createJob(orgId, jobBody(snowId, base, { entity_type: 'incident', query: 'assignment_group=grpA' })).expect(201);
      expect(encoded.body).toMatchObject({ language: 'encoded', query: 'assignment_group=grpA' });
      const jql = await createJob(orgId, jobBody(jiraId, base, { name: 'Bugs only', query: 'project = CAD AND issuetype = Bug' })).expect(201);
      expect(jql.body).toMatchObject({ language: 'jql' });
    });

    it('runs one job per connector at a time, and supports pause, resume and cancel', async () => {
      const { orgId, jiraId, snowId } = await tenant();
      const base = minuteBase();
      const first = (await createJob(orgId, jobBody(jiraId, base)).expect(201)).body.id;
      const second = (await createJob(orgId, jobBody(jiraId, base, { name: 'Second' })).expect(201)).body.id;
      const other = (await createJob(orgId, jobBody(snowId, base, { name: 'Other connector', entity_type: 'incident' })).expect(201)).body.id;
      const act = (id: string, action: string) => http().post(`/integrations/backfill-jobs/${id}/${action}`).set(headers(orgId));

      const started = (await act(first, 'start').expect(201)).body;
      expect(started.status).toBe('running');
      expect(started.started_at).toBeTruthy();
      const blocked = await act(second, 'start').expect(409);
      expect(blocked.body.message).toContain("'Historical load' is already running");
      // A different connector is a different platform, so it may run alongside.
      await act(other, 'start').expect(201);

      await act(first, 'start').expect(409);
      expect((await act(first, 'pause').expect(201)).body.status).toBe('paused');
      // Pausing frees the connector, so the second job may now start; then the first cannot resume.
      await act(second, 'start').expect(201);
      await act(first, 'resume').expect(409);
      await act(second, 'pause').expect(201);
      expect((await act(first, 'resume').expect(201)).body.status).toBe('running');

      const cancelled = (await act(first, 'cancel').expect(201)).body;
      expect(cancelled).toMatchObject({ status: 'cancelled' });
      expect(cancelled.finished_at).toBeTruthy();
      await act(first, 'pause').expect(409);
      await act(first, 'cancel').expect(409);
      await act(first, 'retry-failed').expect(409);
      await act(randomUUID(), 'start').expect(404);
    });

    it('isolates jobs by tenant', async () => {
      const { orgId, jiraId } = await tenant();
      const id = (await createJob(orgId, jobBody(jiraId, minuteBase())).expect(201)).body.id;
      const other = randomUUID();
      await http().get(`/integrations/backfill-jobs/${id}`).set(headers(other)).expect(404);
      await http().get(`/integrations/backfill-jobs/${id}/chunks`).set(headers(other)).expect(404);
      await http().post(`/integrations/backfill-jobs/${id}/start`).set(headers(other)).expect(404);
      expect((await http().get('/integrations/backfill-jobs').set(headers(other)).expect(200)).body).toEqual([]);
      await http().get('/integrations/backfill-jobs').expect(400);
    });
  });

  describe('stale versions', () => {
    it('drops a record older than the twin it would overwrite, and still applies a newer one', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      jiraApi.addIssue({ key: 'CAD-1', summary: 'Current title', status: 'In Progress', issueType: 'Bug', updated: base + 10 * MINUTE });
      await http().post(`/integrations/connectors/${jiraId}/sync`).set(headers(orgId)).send({}).expect(201);
      const twinOf = async () => (await http().get(`/integrations/connectors/${jiraId}/twins`).set(headers(orgId)).expect(200)).body[0];
      const twin = await twinOf();
      expect(twin.title).toBe('Current title');

      const connector = await connectors.getConnector(orgId, jiraId);
      const version = (title: string, updatedAt: number) => ({
        externalId: twin.externalId, artifactType: 'issue', title, nativeKey: 'CAD-1', status: 'To Do', fields: {}, updatedAt: new Date(updatedAt).toISOString(),
      });
      // A backfill page read this earlier, but it reaches the queue after the live sync above.
      await connectors.enqueueBackfillRecords(orgId, connector, 'issue', [version('Stale title', base + 5 * MINUTE)], randomUUID(), async () => undefined);
      await connectors.drainIngestionQueue(orgId, jiraId);
      expect((await twinOf()).title).toBe('Current title');

      await connectors.enqueueBackfillRecords(orgId, connector, 'issue', [version('Newer title', base + 20 * MINUTE)], randomUUID(), async () => undefined);
      await connectors.drainIngestionQueue(orgId, jiraId);
      expect((await twinOf()).title).toBe('Newer title');
    });
  });
  describe('runs', () => {
    const act = (orgId: string, id: string, action: string, body: Record<string, unknown> = {}) =>
      http().post(`/integrations/backfill-jobs/${id}/${action}`).set(headers(orgId)).send(body);
    const getJob = async (orgId: string, id: string) => (await http().get(`/integrations/backfill-jobs/${id}`).set(headers(orgId)).expect(200)).body;
    const searches = (api: FakeJiraApi) => api.requests.filter((entry) => entry.path === '/rest/api/3/search/jql');
    const twinCount = async (connectorId: string) =>
      Number((await database.db.query<any>(`SELECT COUNT(*)::int AS n FROM integration_canonical_twins WHERE connector_id = $1`, [connectorId])).rows[0].n);

    /** Three daily chunks holding 3, 2 and 4 issues: nine records in all. */
    const seedNine = (api: FakeJiraApi, base: number) => {
      const perDay = [3, 2, 4];
      let key = 1;
      perDay.forEach((count, day) => {
        for (let index = 0; index < count; index++) {
          api.addIssue({ key: `CAD-${key++}`, summary: `Day ${day} issue ${index}`, status: 'To Do', issueType: 'Bug', updated: base + day * DAY + (index + 1) * HOUR });
        }
      });
    };
    const startJob = async (orgId: string, connectorId: string, base: number, overrides: Record<string, unknown> = {}) => {
      const id = (await createJob(orgId, jobBody(connectorId, base, overrides)).expect(201)).body.id as string;
      await act(orgId, id, 'start').expect(201);
      return id;
    };
    const parseCsv = (text: string): string[][] => {
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = '';
      let quoted = false;
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
          if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; } else if (char === '"') quoted = false; else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ',') { row.push(cell); cell = ''; }
        else if (char === '\r') { /* row ends at the following \n */ }
        else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += char;
      }
      return rows;
    };

    it('works every chunk, links the records to twins, and reports processed, queued and failed counts', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      // Records outside the range and outside the connector's project must never be read.
      jiraApi.addIssue({ key: 'CAD-90', summary: 'Before the range', status: 'To Do', updated: base - HOUR });
      jiraApi.addIssue({ key: 'CAD-91', summary: 'After the range', status: 'To Do', updated: base + 3 * DAY });
      jiraApi.addIssue({ key: 'OPS-1', summary: 'Other project', status: 'To Do', updated: base + HOUR });

      const id = await startJob(orgId, jiraId, base);
      const result = (await act(orgId, id, 'run').expect(201)).body;
      expect(result).toMatchObject({ status: 'completed', chunks_run: 3, pages: 3, enqueued: 9 });

      const job = await getJob(orgId, id);
      expect(job.status).toBe('completed');
      expect(job.finished_at).toBeTruthy();
      expect(job.counts).toEqual({
        chunks: { total: 3, pending: 0, running: 0, done: 3, failed: 0 },
        records: { fetched: 9, enqueued: 9, duplicates: 0 },
        queue: { queued: 0, processed: 9, failed: 0 },
      });
      expect(await twinCount(jiraId)).toBe(9);
      expect(searches(jiraApi)).toHaveLength(3);
      for (const request of searches(jiraApi)) {
        expect(request.body.jql).toContain('project in ("CAD") AND updated >= "');
        expect(request.body.jql).toContain(' AND updated < "');
      }
      const chunks = (await http().get(`/integrations/backfill-jobs/${id}/chunks`).set(headers(orgId)).expect(200)).body;
      expect(chunks.map((chunk: any) => [chunk.status, chunk.fetched, chunk.enqueued, chunk.pages])).toEqual([['done', 3, 3, 1], ['done', 2, 2, 1], ['done', 4, 4, 1]]);

      // Only a running job can be worked.
      await act(orgId, id, 'run').expect(409);
    });

    it('recognises records it already brought in, so a second pass over the same range adds nothing', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const first = await startJob(orgId, jiraId, base);
      await act(orgId, first, 'run').expect(201);
      const second = await startJob(orgId, jiraId, base, { name: 'Same range again' });
      await act(orgId, second, 'run').expect(201);

      const job = await getJob(orgId, second);
      expect(job.counts.records).toEqual({ fetched: 9, enqueued: 0, duplicates: 9 });
      expect(job.counts.queue).toEqual({ queued: 0, processed: 0, failed: 0 });
      expect(await twinCount(jiraId)).toBe(9);
    });

    it('resumes across runs: a slice that ends early leaves the rest for the next one, reading nothing twice', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base);

      const partial = (await act(orgId, id, 'run', { max_ms: 1 }).expect(201)).body;
      expect(partial.status).toBe('running');
      const midway = await getJob(orgId, id);
      expect(midway.counts.chunks.done).toBeGreaterThanOrEqual(1);
      expect(midway.counts.chunks.done).toBeLessThan(3);

      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');
      const done = await getJob(orgId, id);
      expect(done.counts.records).toEqual({ fetched: 9, enqueued: 9, duplicates: 0 });
      expect(searches(jiraApi)).toHaveLength(3);
    });

    it('takes over a job from a worker that died, without redoing finished chunks', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base);
      await act(orgId, id, 'run', { max_ms: 1 }).expect(201);
      const finishedBefore = (await getJob(orgId, id)).counts.chunks.done;
      // The dead worker left a chunk mid-flight and a lease that has since expired.
      await database.db.query(`UPDATE integration_backfill_chunks SET status = 'running' WHERE job_id = $1 AND status = 'pending' AND seq = $2`, [id, finishedBefore]);
      await database.db.query(`UPDATE integration_backfill_jobs SET lease_owner = 'dead-worker', lease_expires_at = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1`, [id]);

      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');
      expect((await getJob(orgId, id)).counts.records).toEqual({ fetched: 9, enqueued: 9, duplicates: 0 });
      expect(searches(jiraApi)).toHaveLength(3);
    });

    it('resumes a chunk from its saved page after a mid-window failure, without re-reading earlier pages', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      for (let index = 1; index <= 230; index++) {
        jiraApi.addIssue({ key: `CAD-${index}`, summary: `Issue ${index}`, status: 'To Do', updated: base + index * 10_000 });
      }
      const id = await startJob(orgId, jiraId, base, { to: new Date(base + DAY).toISOString() });

      // Let the first page through, then fail the second permanently.
      const originalFetch = jiraApi.fetch;
      let seen = 0;
      const guarded: typeof jiraApi.fetch = async (url, init) => {
        if (init.method === 'POST' && new URL(url).pathname === '/rest/api/3/search/jql' && ++seen === 2) jiraApi.failNext('POST', '/rest/api/3/search/jql', 400, 1);
        return originalFetch(url, init);
      };
      connectors.registerAdapter(new JiraConnectorAdapter(guarded));
      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed_with_errors');
      const failed = await getJob(orgId, id);
      expect(failed.counts.chunks).toMatchObject({ done: 0, failed: 1 });
      expect(failed.counts.records.enqueued).toBe(100);

      await act(orgId, id, 'retry-failed').expect(201);
      const before = searches(jiraApi).length;
      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');
      const retried = searches(jiraApi).slice(before);
      // The retry starts at page two (Jira's token for the first 100), not at the beginning.
      expect(retried[0].body.nextPageToken).toBe('100');
      const done = await getJob(orgId, id);
      expect(done.counts.records).toEqual({ fetched: 230, enqueued: 230, duplicates: 0 });
      expect(await twinCount(jiraId)).toBe(230);
    });

    it('isolates a failing chunk, finishes the rest, and lets the failure be retried', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base);
      jiraApi.failNext('POST', '/rest/api/3/search/jql', 400, 1);

      const result = (await act(orgId, id, 'run').expect(201)).body;
      expect(result.status).toBe('completed_with_errors');
      const job = await getJob(orgId, id);
      expect(job.status).toBe('completed_with_errors');
      expect(job.last_error).toContain('1 chunk(s) failed');
      expect(job.counts.chunks).toEqual({ total: 3, pending: 0, running: 0, done: 2, failed: 1 });
      const chunks = (await http().get(`/integrations/backfill-jobs/${id}/chunks`).set(headers(orgId)).expect(200)).body;
      const bad = chunks.find((chunk: any) => chunk.status === 'failed');
      expect(bad.last_error).toContain('Provider responded 400');

      const failedReport = parseCsv((await http().get(`/integrations/backfill-jobs/${id}/report.csv`).set(headers(orgId)).expect(200)).text);
      const failedRow = failedReport.find((row) => row[9] === 'chunk_failed')!;
      expect(failedRow[2]).toBe(String(bad.seq));
      expect(failedRow[12]).toContain('Provider responded 400');

      await act(orgId, id, 'retry-failed').expect(201);
      expect((await getJob(orgId, id)).status).toBe('running');
      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');
      const done = await getJob(orgId, id);
      expect(done.counts.chunks).toMatchObject({ done: 3, failed: 0 });
      expect(done.counts.records.enqueued).toBe(9);
      expect(done.last_error).toBeNull();
    });

    it('shrinks concurrency and honours Retry-After when the provider throttles, then finishes', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base, { max_concurrency: 4, max_requests_per_minute: 6000 });
      await database.db.query(`UPDATE integration_backfill_jobs SET concurrency = 4 WHERE id = $1`, [id]);
      jiraApi.failNext('POST', '/rest/api/3/search/jql', 429, 1, { 'Retry-After': '1' });

      const started = Date.now();
      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');
      const job = await getJob(orgId, id);
      expect(job.limiter.throttle_events).toBe(1);
      // Four chunks at once became at most three after one halving and a partial recovery.
      expect(job.limiter.concurrency).toBeLessThan(4);
      // The throttled chunk waited out Retry-After before its second attempt.
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(searches(jiraApi)).toHaveLength(4);
      expect(job.counts.records).toEqual({ fetched: 9, enqueued: 9, duplicates: 0 });
      expect(job.counts.chunks.failed).toBe(0);
    });

    it('grows concurrency while the provider keeps up, and never exceeds the job maximum', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      for (let day = 0; day < 8; day++) jiraApi.addIssue({ key: `CAD-${day + 1}`, summary: `Day ${day}`, status: 'To Do', updated: base + day * DAY + HOUR });
      const id = await startJob(orgId, jiraId, base, { to: new Date(base + 8 * DAY).toISOString(), max_concurrency: 3, max_requests_per_minute: 6000 });
      jiraApi.latencyMs = 30;
      jiraApi.peakInFlight = 0;

      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');
      expect(jiraApi.peakInFlight).toBeGreaterThanOrEqual(2);
      expect(jiraApi.peakInFlight).toBeLessThanOrEqual(3);
      expect((await getJob(orgId, id)).limiter.concurrency).toBeGreaterThanOrEqual(2);
      expect((await getJob(orgId, id)).limiter.throttle_events).toBe(0);
    });

    it('spaces request starts to the job rate limit, even across concurrent workers', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      for (let day = 0; day < 6; day++) jiraApi.addIssue({ key: `CAD-${day + 1}`, summary: `Day ${day}`, status: 'To Do', updated: base + day * DAY + HOUR });
      // 600 requests a minute is one every 100ms. Three workers would otherwise start together.
      const id = await startJob(orgId, jiraId, base, { to: new Date(base + 6 * DAY).toISOString(), max_concurrency: 3, max_requests_per_minute: 600 });
      await database.db.query(`UPDATE integration_backfill_jobs SET concurrency = 3 WHERE id = $1`, [id]);
      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');

      const starts = searches(jiraApi).map((entry) => entry.at).sort((a, b) => a - b);
      expect(starts).toHaveLength(6);
      for (let index = 1; index < starts.length; index++) expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(90);
    });

    it('commits an in-flight page when paused, and a resume finishes exactly once', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base);

      const release = jiraApi.hold();
      const inFlight = act(orgId, id, 'run').then((response) => response);
      for (let attempt = 0; attempt < 100 && searches(jiraApi).length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(searches(jiraApi)).toHaveLength(1);
      await act(orgId, id, 'pause').expect(201);
      release();

      const paused = (await inFlight).body;
      expect(paused.status).toBe('paused');
      const midway = await getJob(orgId, id);
      expect(midway.counts.chunks.done).toBe(1);
      expect(midway.counts.records.enqueued).toBe(3);

      await act(orgId, id, 'resume').expect(201);
      expect((await act(orgId, id, 'run').expect(201)).body.status).toBe('completed');
      const done = await getJob(orgId, id);
      expect(done.counts.records).toEqual({ fetched: 9, enqueued: 9, duplicates: 0 });
      expect(searches(jiraApi)).toHaveLength(3);
    });

    it('commits nothing from a page that returns after the job is cancelled', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base);

      const release = jiraApi.hold();
      const inFlight = act(orgId, id, 'run').then((response) => response);
      for (let attempt = 0; attempt < 100 && searches(jiraApi).length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      await act(orgId, id, 'cancel').expect(201);
      release();
      expect((await inFlight).body.status).toBe('cancelled');

      const job = await getJob(orgId, id);
      expect(job.status).toBe('cancelled');
      expect(job.counts.records).toEqual({ fetched: 0, enqueued: 0, duplicates: 0 });
      expect(job.counts.queue).toEqual({ queued: 0, processed: 0, failed: 0 });
      expect(await twinCount(jiraId)).toBe(0);
    });

    it('waits, without failing, while its connector is paused', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base);
      await http().post(`/integrations/connectors/${jiraId}/pause`).set(headers(orgId)).send({}).expect(201);

      const waiting = (await act(orgId, id, 'run').expect(201)).body;
      expect(waiting).toMatchObject({ status: 'waiting', message: 'The connector is paused' });
      expect(searches(jiraApi)).toHaveLength(0);
      expect((await getJob(orgId, id)).status).toBe('running');
    });

    it('reads queued and failed counts from the real ingestion queue', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      // Hold the connector's sync lease so the queue is not drained while the job runs.
      await database.db.query(
        `INSERT INTO integration_connector_sync_leases (connector_id, org_id, lease_owner, expires_at)
         VALUES ($1, $2, 'busy-sync', CURRENT_TIMESTAMP + interval '10 minutes')`, [jiraId, orgId],
      );
      const id = await startJob(orgId, jiraId, base);
      await act(orgId, id, 'run').expect(201);
      expect((await getJob(orgId, id)).counts.queue).toEqual({ queued: 9, processed: 0, failed: 0 });
      expect(await twinCount(jiraId)).toBe(0);

      await database.db.query(`DELETE FROM integration_connector_sync_leases WHERE connector_id = $1`, [jiraId]);
      expect(await connectors.drainIngestionQueue(orgId, jiraId)).toBe(true);
      expect((await getJob(orgId, id)).counts.queue).toEqual({ queued: 0, processed: 9, failed: 0 });

      await database.db.query(
        `UPDATE integration_connector_ingestion_queue SET status = 'dead', last_error = 'Needs operator review'
         WHERE id = (SELECT id FROM integration_connector_ingestion_queue WHERE backfill_job_id = $1 ORDER BY queue_position LIMIT 1)`, [id],
      );
      expect((await getJob(orgId, id)).counts.queue).toEqual({ queued: 0, processed: 8, failed: 1 });
      const report = parseCsv((await http().get(`/integrations/backfill-jobs/${id}/report.csv`).set(headers(orgId)).expect(200)).text);
      expect(report.filter((row) => row[10] === 'dead')).toHaveLength(1);
      expect(report.find((row) => row[10] === 'dead')![12]).toBe('Needs operator review');
    });

    it('exports a CSV audit report with one row per record, linked twins, and safe cells', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const first = await startJob(orgId, jiraId, base, { name: 'First pass' });
      await act(orgId, first, 'run').expect(201);
      const name = '=HYPERLINK("http://example.test"), "quoted"';
      const second = await startJob(orgId, jiraId, base, { name });
      await act(orgId, second, 'run').expect(201);

      const response = await http().get(`/integrations/backfill-jobs/${first}/report.csv`).set(headers(orgId, 'auditor')).expect(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe(`attachment; filename="backfill-${first}.csv"`);
      expect(response.headers['x-report-rows']).toBe('9');
      const rows = parseCsv(response.text);
      expect(rows[0]).toEqual([
        'job_id', 'job_name', 'chunk', 'window_start', 'window_end', 'external_id', 'native_key', 'twin_id', 'record_updated_at',
        'outcome', 'queue_status', 'attempts', 'error', 'recorded_at',
      ]);
      expect(rows).toHaveLength(10);
      const data = rows.slice(1);
      expect(new Set(data.map((row) => row[0]))).toEqual(new Set([first]));
      expect(data.every((row) => row[9] === 'enqueued' && row[10] === 'completed' && /^CAD-\d+$/.test(row[6]) && row[7].length === 36)).toBe(true);
      expect(new Set(data.map((row) => row[5])).size).toBe(9);

      const dup = parseCsv((await http().get(`/integrations/backfill-jobs/${second}/report.csv`).set(headers(orgId)).expect(200)).text).slice(1);
      expect(dup).toHaveLength(9);
      expect(dup.every((row) => row[9] === 'duplicate')).toBe(true);
      // A spreadsheet would run a leading "=" as a formula, so it is neutralised; quotes and commas survive.
      expect(dup[0][1]).toBe(`'${name}`);
      expect(response.text).not.toMatch(/(^|,)=/m);

      const exported = await database.db.query<any>(
        `SELECT actor_id, payload FROM domain_events WHERE event_type = 'BackfillReportExported' AND work_item_id = $1`, [first],
      );
      expect(exported.rows).toHaveLength(1);
      expect(exported.rows[0].actor_id).toBe('auditor');
      expect(Number(exported.rows[0].payload.rows)).toBe(9);
    });

    it('is driven by the scheduler and refuses cross-tenant access', async () => {
      const { orgId, jiraId, jiraApi } = await tenant();
      const base = minuteBase();
      seedNine(jiraApi, base);
      const id = await startJob(orgId, jiraId, base);
      const other = randomUUID();
      await act(other, id, 'run').expect(404);
      await http().get(`/integrations/backfill-jobs/${id}/report.csv`).set(headers(other)).expect(404);

      const results = (await app.get(BackfillScheduler).tick()).filter((result) => result.job_id === id);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('completed');
      expect((await getJob(orgId, id)).counts.records.enqueued).toBe(9);
      expect((await app.get(BackfillScheduler).tick()).filter((result) => result.job_id === id)).toHaveLength(0);
    });
  });
});
