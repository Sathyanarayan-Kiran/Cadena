import { ConnectorFetch, ConnectorHttpRequest, ConnectorHttpResponse } from '../connector-http';

/**
 * Deterministic in-process stand-ins for the Jira Cloud REST v3 and ServiceNow Table APIs.
 *
 * They implement only the endpoints the native adapters call, enforce authentication, apply the
 * watermark filters the adapters send, paginate, and record every request. Nothing here touches
 * the network. Acceptance tests use them directly; local demonstrations reach them through
 * `CADENA_CONNECTOR_SANDBOX=enabled`, which runtime configuration refuses outside local mode.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: any;
  /** When the request reached the fake (epoch ms), so tests can assert how requests were spaced. */
  at: number;
}

interface FailureRule {
  method: string;
  pathPrefix: string;
  status: number;
  remaining: number;
  headers?: Record<string, string>;
}

function respond(status: number, body?: unknown, headers: Record<string, string> = {}): ConnectorHttpResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

abstract class FakeProviderApi {
  public readonly requests: RecordedRequest[] = [];
  private failures: FailureRule[] = [];
  private gate: Promise<void> | null = null;
  /** Simulated response time. Non-zero makes requests genuinely overlap, so concurrency is observable. */
  public latencyMs = 0;
  private inFlight = 0;
  /** The most requests ever in flight at once, for asserting a backfill's concurrency limit. */
  public peakInFlight = 0;
  protected clock = Date.parse('2026-09-22T09:00:00.000Z');

  /** With no expected authorization, any Basic or Bearer header carrying a secret is accepted. */
  constructor(public readonly baseUrl: string, private readonly expectedAuthorization?: string) {}

  public readonly fetch: ConnectorFetch = async (url: string, init: ConnectorHttpRequest) => {
    const parsed = new URL(url);
    const request: RecordedRequest = {
      method: init.method,
      url,
      path: parsed.pathname,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
      at: Date.now(),
    };
    this.requests.push(request);
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      return await this.handle(url, init, parsed, request);
    } finally {
      this.inFlight -= 1;
    }
  };

  private async handle(url: string, init: ConnectorHttpRequest, parsed: URL, request: RecordedRequest): Promise<ConnectorHttpResponse> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    if (this.gate) await this.gate;
    if (!url.startsWith(this.baseUrl)) return respond(404, { error: { message: 'unknown host' } });
    const authorization = init.headers.Authorization || '';
    const authorized = this.expectedAuthorization
      ? authorization === this.expectedAuthorization
      : /^Bearer \S+$/.test(authorization)
        || (/^Basic /.test(authorization) && /:.+$/.test(Buffer.from(authorization.slice(6), 'base64').toString('utf8')));
    if (!authorized) {
      return respond(401, { errorMessages: ['Authentication failed'] });
    }
    const failure = this.failures.find((rule) =>
      rule.remaining > 0 && rule.method === init.method && parsed.pathname.startsWith(rule.pathPrefix));
    if (failure) {
      failure.remaining--;
      return respond(failure.status, { errorMessages: [`Injected ${failure.status}`] }, failure.headers);
    }
    return this.route(init.method, parsed, request.body);
  }

  /** Fail the next `count` matching requests with `status`. */
  public failNext(method: string, pathPrefix: string, status: number, count = 1, headers?: Record<string, string>): void {
    this.failures.push({ method, pathPrefix, status, remaining: count, headers });
  }

  /** Hold every request until the returned release function is called. */
  public hold(): () => void {
    let release!: () => void;
    this.gate = new Promise((resolve) => { release = resolve; });
    return () => { this.gate = null; release(); };
  }

  public tick(ms = 60_000): number {
    this.clock += ms;
    return this.clock;
  }

  public countRequests(method: string, pathFragment: string): number {
    return this.requests.filter((request) => request.method === method && request.path.includes(pathFragment)).length;
  }

  protected abstract route(method: string, url: URL, body: any): ConnectorHttpResponse;
}

// ─── Jira ────────────────────────────────────────────────────────────────────

export interface FakeJiraIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  priority?: string;
  updated: number;
  created?: number;
  issueType?: string;
  assigneeAccountId?: string;
  assigneeEmail?: string;
  custom?: Record<string, unknown>;
}

export class FakeJiraApi extends FakeProviderApi {
  public projects = [
    { id: '10000', key: 'CAD', name: 'Cadena Delivery' },
    { id: '10001', key: 'OPS', name: 'Operations' },
  ];
  public statuses = ['To Do', 'In Progress', 'In Review', 'Done'];
  /** Target statuses that the workflow does not offer from any status. */
  public unavailableTransitions = new Set<string>();
  public issues = new Map<string, FakeJiraIssue>();
  private nextId = 20000;

  constructor(baseUrl = 'https://acme.atlassian.net', email = 'sync@acme.test', token: string | null = 'jira-token-value') {
    super(baseUrl, token === null ? undefined : `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`);
  }

  public addIssue(input: Partial<FakeJiraIssue> & { key: string; summary: string; status: string }): FakeJiraIssue {
    const issue: FakeJiraIssue = { id: input.id || String(this.nextId++), updated: input.updated ?? this.tick(1000), ...input } as FakeJiraIssue;
    issue.created = issue.created ?? issue.updated;
    this.issues.set(issue.id, issue);
    return issue;
  }

  public editIssue(id: string, changes: Partial<FakeJiraIssue>): FakeJiraIssue {
    const issue = this.issues.get(id)!;
    Object.assign(issue, changes, { updated: this.tick(60_000) });
    return issue;
  }

  protected route(method: string, url: URL, body: any): ConnectorHttpResponse {
    const path = url.pathname;
    if (method === 'GET' && path === '/rest/api/3/myself') {
      return respond(200, { accountId: 'svc-1', displayName: 'Cadena Sync', emailAddress: 'sync@acme.test' });
    }
    if (method === 'GET' && path === '/rest/api/3/project/search') {
      const keys = url.searchParams.getAll('keys');
      return respond(200, { values: this.projects.filter((project) => keys.includes(project.key)), isLast: true });
    }
    if (method === 'GET' && path === '/rest/api/3/field') {
      return respond(200, [
        { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
        { id: 'status', name: 'Status', custom: false, schema: { type: 'status' } },
        { id: 'priority', name: 'Priority', custom: false, schema: { type: 'priority' } },
        { id: 'assignee', name: 'Assignee', custom: false, schema: { type: 'user' } },
        { id: 'updated', name: 'Updated', custom: false, schema: { type: 'datetime' } },
        { id: 'customfield_10014', name: 'Epic Link', custom: true, schema: { type: 'string' } },
        { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { type: 'array' } },
      ]);
    }
    if (method === 'GET' && path === '/rest/api/3/status') {
      return respond(200, this.statuses.map((name, index) => ({ id: String(index + 1), name })));
    }
    if (method === 'POST' && path === '/rest/api/3/search/jql') return this.search(body);

    const transitions = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(path);
    if (transitions) {
      const issue = this.findIssue(decodeURIComponent(transitions[1]));
      if (!issue) return respond(404, { errorMessages: ['Issue does not exist'] });
      const available = this.statuses
        .filter((status) => status !== issue.status && !this.unavailableTransitions.has(status))
        .map((status) => ({ id: String(this.statuses.indexOf(status) + 11), name: `Move to ${status}`, to: { name: status } }));
      if (method === 'GET') return respond(200, { transitions: available });
      if (method === 'POST') {
        const chosen = available.find((candidate) => candidate.id === body?.transition?.id);
        if (!chosen) return respond(400, { errorMessages: ['Transition is not valid'] });
        issue.status = chosen.to.name;
        this.applyJiraFieldWrite(issue, body?.fields);
        issue.updated = this.tick(1000);
        return respond(204);
      }
    }

    const bareIssue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (bareIssue && method === 'PUT') {
      const issue = this.findIssue(decodeURIComponent(bareIssue[1]));
      if (!issue) return respond(404, { errorMessages: ['Issue does not exist'] });
      this.applyJiraFieldWrite(issue, body?.fields);
      issue.updated = this.tick(1000);
      return respond(204);
    }
    return respond(404, { errorMessages: [`No route for ${method} ${path}`] });
  }

  /** Applies a governed field write in the same wrapped shape the real adapter sends. */
  private applyJiraFieldWrite(issue: FakeJiraIssue, fields: Record<string, any> | undefined): void {
    if (!fields) return;
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'priority') issue.priority = value?.name ?? value;
      else if (key === 'assignee') issue.assigneeAccountId = value?.accountId ?? value;
      else if (key === 'summary') issue.summary = String(value);
      else {
        issue.custom = issue.custom || {};
        issue.custom[key] = value;
      }
    }
  }

  private findIssue(idOrKey: string): FakeJiraIssue | undefined {
    return this.issues.get(idOrKey) || Array.from(this.issues.values()).find((issue) => issue.key === idOrKey);
  }

  private search(body: any): ConnectorHttpResponse {
    const jql = String(body?.jql || '');
    // Every project clause must hold, as in Jira: a scheduled query's own `project` condition is
    // ANDed with the connector's configured scope, so it can narrow that scope but never widen it.
    const projectSets = Array.from(jql.matchAll(/project\s*in\s*\(([^)]*)\)|project\s*=\s*"?([A-Za-z0-9_-]+)"?/gi))
      .map((match) => (match[1] !== undefined ? match[1].split(',').map((key) => key.trim().replace(/"/g, '')) : [match[2]]));
    const inProjects = (issue: FakeJiraIssue) => projectSets.length > 0
      && projectSets.every((keys) => keys.includes(issue.key.split('-')[0]));
    // Scheduled queries (US17.3) also carry the operator's own equality conditions.
    const equalities = Array.from(jql.matchAll(/\b(status|issuetype|priority)\s*=\s*(?:"([^"]*)"|([^\s")]+))/gi));
    const satisfiesQuery = (issue: FakeJiraIssue) => equalities.every(([, field, quoted, bare]) => {
      const wanted = (quoted ?? bare).toLowerCase();
      const actual = field.toLowerCase() === 'status' ? issue.status
        : field.toLowerCase() === 'issuetype' ? issue.issueType || 'Story'
          : issue.priority || '';
      return actual.toLowerCase() === wanted;
    });
    const sinceMatch = /updated >= "(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})"/.exec(jql);
    // The fake integration account's profile time zone is UTC.
    const since = sinceMatch
      ? Date.UTC(+sinceMatch[1], +sinceMatch[2] - 1, +sinceMatch[3], +sinceMatch[4], +sinceMatch[5])
      : -Infinity;
    // Backfill windows (US17.4) are half-open: `updated < "..."` is an exclusive upper bound.
    const untilMatch = /updated < "(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})"/.exec(jql);
    const until = untilMatch
      ? Date.UTC(+untilMatch[1], +untilMatch[2] - 1, +untilMatch[3], +untilMatch[4], +untilMatch[5])
      : Infinity;
    const matching = Array.from(this.issues.values())
      .filter((issue) => inProjects(issue) && issue.updated >= since && issue.updated < until && satisfiesQuery(issue))
      .sort((a, b) => a.updated - b.updated || a.key.localeCompare(b.key));
    const offset = Number(body?.nextPageToken || 0);
    const size = Number(body?.maxResults || 50);
    const page = matching.slice(offset, offset + size);
    const isLast = offset + size >= matching.length;
    const customIds: string[] = (body?.fields || []).filter((field: string) => field.startsWith('customfield_'));
    return respond(200, {
      issues: page.map((issue) => ({
        id: issue.id,
        key: issue.key,
        fields: {
          summary: issue.summary,
          status: { name: issue.status },
          priority: issue.priority ? { name: issue.priority } : null,
          assignee: (issue.assigneeEmail || issue.assigneeAccountId)
            ? { displayName: null, accountId: issue.assigneeAccountId ?? null, emailAddress: issue.assigneeEmail ?? null }
            : null,
          issuetype: { name: issue.issueType || 'Story' },
          project: { key: issue.key.split('-')[0] },
          description: null,
          created: new Date(issue.created ?? issue.updated).toISOString().replace('Z', '+0000'),
          updated: new Date(issue.updated).toISOString().replace('Z', '+0000'),
          ...Object.fromEntries(customIds.map((id) => [id, issue.custom?.[id] ?? null])),
        },
      })),
      ...(isLast ? { isLast: true } : { nextPageToken: String(offset + size), isLast: false }),
    });
  }
}

// ─── ServiceNow ──────────────────────────────────────────────────────────────

export interface FakeServiceNowRecord {
  sys_id: string;
  number: string;
  short_description: string;
  state: string; // choice code
  priority?: string;
  sys_updated_on: number;
  sys_created_on?: number;
  assigned_to?: string;
  assigned_to_email?: string;
  assignment_group?: string;
  sys_updated_by: string;
  /** Any other governed field a mapping/write-back writes; round-trips through GET/PATCH as-is. */
  [extra: string]: unknown;
}

const INCIDENT_STATES: Array<[string, string]> = [
  ['1', 'New'], ['2', 'In Progress'], ['3', 'On Hold'], ['6', 'Resolved'], ['7', 'Closed'],
];

export class FakeServiceNowApi extends FakeProviderApi {
  public tables = new Map<string, Map<string, FakeServiceNowRecord>>([
    ['incident', new Map()],
    ['change_request', new Map()],
  ]);
  private sequence = 10000;

  constructor(baseUrl = 'https://acme.service-now.com', private readonly username = 'svc.cadena', password: string | null = 'snow-password-value') {
    super(baseUrl, password === null ? undefined : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  }

  public addRecord(table: string, input: Partial<FakeServiceNowRecord> & { short_description: string; state: string }): FakeServiceNowRecord {
    const record: FakeServiceNowRecord = {
      sys_id: input.sys_id || `sys${this.sequence}`,
      number: input.number || `${table === 'incident' ? 'INC' : 'CHG'}00${this.sequence++}`,
      sys_updated_on: input.sys_updated_on ?? this.tick(1000),
      sys_updated_by: input.sys_updated_by || 'agent.smith',
      ...input,
    } as FakeServiceNowRecord;
    record.sys_created_on = record.sys_created_on ?? record.sys_updated_on;
    this.tables.get(table)!.set(record.sys_id, record);
    return record;
  }

  public editRecord(table: string, sysId: string, changes: Partial<FakeServiceNowRecord>): FakeServiceNowRecord {
    const record = this.tables.get(table)!.get(sysId)!;
    Object.assign(record, { sys_updated_by: 'agent.smith' }, changes, { sys_updated_on: this.tick(60_000) });
    return record;
  }

  public stateLabel(code: string): string {
    return INCIDENT_STATES.find(([value]) => value === code)?.[1] || code;
  }

  /**
   * Evaluates the equality and IN conditions of an encoded query, with `^OR` and `^NQ`. Ordering
   * and the watermark are handled elsewhere; any other operator is ignored, so this fake never
   * hides a record the real instance would return.
   */
  private matchesEncodedQuery(record: FakeServiceNowRecord, query: string): boolean {
    const groups = query.split('^NQ').map((group) => group.split('^').filter((term) => {
      const body = term.replace(/^OR/, '');
      return /^[a-z_.]+(=|IN)/.test(body);
    }).filter((term) => !/^(OR)?sys_updated_on/.test(term)));
    if (groups.every((group) => group.length === 0)) return true;
    const holds = (term: string) => {
      const [, field, operator, value] = /^(?:OR)?([a-z_.]+)(=|IN)(.*)$/.exec(term)!;
      const actual = String(record[field] ?? '');
      return operator === '=' ? actual === value : value.split(',').includes(actual);
    };
    return groups.some((group) => {
      const clauses: string[][] = [];
      for (const term of group) {
        if (term.startsWith('OR') && clauses.length) clauses[clauses.length - 1].push(term);
        else clauses.push([term]);
      }
      return clauses.every((clause) => clause.some(holds));
    });
  }

  protected route(method: string, url: URL, body: any): ConnectorHttpResponse {
    const match = /^\/api\/now\/table\/([a-z_]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return respond(404, { error: { message: 'No route' } });
    const [, table, sysId] = match;
    const query = url.searchParams.get('sysparm_query') || '';

    if (method === 'GET' && table === 'sys_dictionary') {
      const names = (/nameIN([^^]+)/.exec(query)?.[1] || '').split(',');
      const rows: any[] = [];
      if (names.includes('task')) {
        rows.push(
          { name: 'task', element: 'number', column_label: 'Number', internal_type: 'string', mandatory: 'false' },
          { name: 'task', element: 'short_description', column_label: 'Short description', internal_type: 'string', mandatory: 'false' },
          { name: 'task', element: 'state', column_label: 'State', internal_type: 'integer', mandatory: 'false' },
          { name: 'task', element: 'priority', column_label: 'Priority', internal_type: 'integer', mandatory: 'false' },
          { name: 'task', element: 'assigned_to', column_label: 'Assigned to', internal_type: 'reference', mandatory: 'false' },
          { name: 'task', element: 'assignment_group', column_label: 'Assignment group', internal_type: 'reference', mandatory: 'false' },
          { name: 'task', element: 'sys_updated_on', column_label: 'Updated', internal_type: 'glide_date_time', mandatory: 'false' },
        );
      }
      for (const name of names) {
        if (name === 'task' || !this.tables.has(name)) continue;
        rows.push(
          { name, element: 'short_description', column_label: 'Short description', internal_type: 'string', mandatory: 'true' },
          { name, element: 'u_business_service', column_label: 'Business service', internal_type: 'reference', mandatory: 'false' },
        );
        if (name === 'incident') rows.push({ name, element: 'close_code', column_label: 'Resolution code', internal_type: 'string', mandatory: 'false' });
      }
      return respond(200, { result: rows });
    }
    if (method === 'GET' && table === 'sys_choice') {
      const name = /name=([a-z_]+)/.exec(query)?.[1];
      return respond(200, {
        result: name && this.tables.has(name) ? INCIDENT_STATES.map(([value, label]) => ({ value, label })) : [],
      });
    }

    const rows = this.tables.get(table);
    if (!rows) return respond(400, { error: { message: `Invalid table ${table}` } });

    if (method === 'PATCH' && sysId) {
      const record = rows.get(decodeURIComponent(sysId));
      if (!record) return respond(404, { error: { message: 'No Record found' } });
      // Any governed field write (e.g. priority, assignment_group) round-trips as a flat value,
      // matching the real Table API's PATCH contract; `state` alone gets its usual special case.
      for (const [key, value] of Object.entries(body || {})) {
        if (key === 'state') record.state = String(value);
        else record[key] = value;
      }
      record.sys_updated_on = this.tick(1000);
      record.sys_updated_by = this.username;
      return respond(200, { result: { sys_id: record.sys_id, number: record.number, state: record.state } });
    }
    if (method === 'GET') {
      const sinceMatch = /sys_updated_on>=(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(query);
      const since = sinceMatch
        ? Date.UTC(+sinceMatch[1], +sinceMatch[2] - 1, +sinceMatch[3], +sinceMatch[4], +sinceMatch[5], +sinceMatch[6])
        : -Infinity;
      const untilMatch = /sys_updated_on<(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(query);
      const until = untilMatch
        ? Date.UTC(+untilMatch[1], +untilMatch[2] - 1, +untilMatch[3], +untilMatch[4], +untilMatch[5], +untilMatch[6])
        : Infinity;
      const limit = Number(url.searchParams.get('sysparm_limit') || 100);
      const offset = Number(url.searchParams.get('sysparm_offset') || 0);
      const matching = Array.from(rows.values())
        .filter((record) => {
          const stamp = Math.floor(record.sys_updated_on / 1000) * 1000;
          return stamp >= since && stamp < until && this.matchesEncodedQuery(record, query);
        })
        .sort((a, b) => a.sys_updated_on - b.sys_updated_on || a.sys_id.localeCompare(b.sys_id))
        .slice(offset, offset + limit);
      const pair = (value: string, display = value) => ({ value, display_value: display });
      return respond(200, {
        result: matching.map((record) => ({
          sys_id: pair(record.sys_id),
          number: pair(record.number),
          short_description: pair(record.short_description),
          state: pair(record.state, this.stateLabel(record.state)),
          priority: pair(record.priority || '3', record.priority || '3 - Moderate'),
          assigned_to: pair(record.assigned_to || '', record.assigned_to || ''),
          'assigned_to.email': pair(record.assigned_to_email || '', record.assigned_to_email || ''),
          sys_created_on: pair(new Date(record.sys_created_on ?? record.sys_updated_on).toISOString().slice(0, 19).replace('T', ' ')),
          sys_updated_on: pair(new Date(record.sys_updated_on).toISOString().slice(0, 19).replace('T', ' ')),
          sys_updated_by: pair(record.sys_updated_by),
        })),
      });
    }
    return respond(405, { error: { message: 'Method not allowed' } });
  }
}

// ─── Local sandbox ───────────────────────────────────────────────────────────

export const SANDBOX_JIRA_URL = 'https://jira.sandbox.cadena.local';
export const SANDBOX_SERVICENOW_URL = 'https://servicenow.sandbox.cadena.local';

export interface ProviderSandbox {
  jira: FakeJiraApi;
  servicenow: FakeServiceNowApi;
  fetch: ConnectorFetch;
}

let sandbox: ProviderSandbox | null = null;

/** Process-wide sandbox with a small seeded Jira project and ServiceNow incident queue. */
export function getProviderSandbox(): ProviderSandbox {
  if (sandbox) return sandbox;
  const jira = new FakeJiraApi(SANDBOX_JIRA_URL, 'any', null);
  const servicenow = new FakeServiceNowApi(SANDBOX_SERVICENOW_URL, 'svc.cadena', null);
  jira.addIssue({ key: 'CAD-101', summary: 'Checkout latency regression', status: 'In Progress', priority: 'High' });
  jira.addIssue({ key: 'CAD-102', summary: 'Retry payment webhook deliveries', status: 'To Do', priority: 'Medium' });
  jira.addIssue({ key: 'CAD-103', summary: 'Publish incident runbook links', status: 'Done', priority: 'Low' });
  servicenow.addRecord('incident', { short_description: 'Checkout pages slow for EU customers', state: '2', priority: '2' });
  servicenow.addRecord('incident', { short_description: 'Payment confirmation emails delayed', state: '1', priority: '3' });
  const fetch: ConnectorFetch = (url, init) => {
    if (url.startsWith(SANDBOX_JIRA_URL)) return jira.fetch(url, init);
    if (url.startsWith(SANDBOX_SERVICENOW_URL)) return servicenow.fetch(url, init);
    return Promise.resolve(respond(404, { errorMessages: [`Sandbox has no provider at ${new URL(url).host}`] }));
  };
  sandbox = { jira, servicenow, fetch };
  return sandbox;
}
