import { ConnectorFetch, ConnectorHttpRequest, ConnectorHttpResponse } from '../../src/modules/connectors/connector-http';

/**
 * Deterministic in-process fakes of the Jira Cloud REST v3 and ServiceNow Table APIs.
 *
 * They implement only the endpoints the native adapters call, enforce authentication, apply the
 * watermark filters the adapters send, paginate, and record every request so tests can assert
 * the exact native calls. Nothing here touches the network.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: any;
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
  protected clock = Date.parse('2026-09-22T09:00:00.000Z');

  constructor(public readonly baseUrl: string, private readonly expectedAuthorization: string) {}

  public readonly fetch: ConnectorFetch = async (url: string, init: ConnectorHttpRequest) => {
    const parsed = new URL(url);
    const request: RecordedRequest = {
      method: init.method,
      url,
      path: parsed.pathname,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    this.requests.push(request);
    if (this.gate) await this.gate;
    if (!url.startsWith(this.baseUrl)) return respond(404, { error: { message: 'unknown host' } });
    if (init.headers.Authorization !== this.expectedAuthorization) {
      return respond(401, { errorMessages: ['Authentication failed'] });
    }
    const failure = this.failures.find((rule) =>
      rule.remaining > 0 && rule.method === init.method && parsed.pathname.startsWith(rule.pathPrefix));
    if (failure) {
      failure.remaining--;
      return respond(failure.status, { errorMessages: [`Injected ${failure.status}`] }, failure.headers);
    }
    return this.route(init.method, parsed, request.body);
  };

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

  constructor(baseUrl = 'https://acme.atlassian.net', email = 'sync@acme.test', token = 'jira-token-value') {
    super(baseUrl, `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`);
  }

  public addIssue(input: Partial<FakeJiraIssue> & { key: string; summary: string; status: string }): FakeJiraIssue {
    const issue: FakeJiraIssue = { id: input.id || String(this.nextId++), updated: input.updated ?? this.tick(1000), ...input } as FakeJiraIssue;
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
        issue.updated = this.tick(1000);
        return respond(204);
      }
    }
    return respond(404, { errorMessages: [`No route for ${method} ${path}`] });
  }

  private findIssue(idOrKey: string): FakeJiraIssue | undefined {
    return this.issues.get(idOrKey) || Array.from(this.issues.values()).find((issue) => issue.key === idOrKey);
  }

  private search(body: any): ConnectorHttpResponse {
    const jql = String(body?.jql || '');
    const projectMatch = /project in \(([^)]*)\)/.exec(jql);
    const projects = projectMatch ? projectMatch[1].split(',').map((key) => key.trim().replace(/"/g, '')) : [];
    const sinceMatch = /updated >= "(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})"/.exec(jql);
    // The fake integration account's profile time zone is UTC.
    const since = sinceMatch
      ? Date.UTC(+sinceMatch[1], +sinceMatch[2] - 1, +sinceMatch[3], +sinceMatch[4], +sinceMatch[5])
      : -Infinity;
    const matching = Array.from(this.issues.values())
      .filter((issue) => projects.includes(issue.key.split('-')[0]) && issue.updated >= since)
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
          assignee: null,
          issuetype: { name: 'Story' },
          project: { key: issue.key.split('-')[0] },
          description: null,
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
  sys_updated_by: string;
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

  constructor(baseUrl = 'https://acme.service-now.com', private readonly username = 'svc.cadena', password = 'snow-password-value') {
    super(baseUrl, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  }

  public addRecord(table: string, input: Partial<FakeServiceNowRecord> & { short_description: string; state: string }): FakeServiceNowRecord {
    const record: FakeServiceNowRecord = {
      sys_id: input.sys_id || `sys${this.sequence}`,
      number: input.number || `${table === 'incident' ? 'INC' : 'CHG'}00${this.sequence++}`,
      sys_updated_on: input.sys_updated_on ?? this.tick(1000),
      sys_updated_by: input.sys_updated_by || 'agent.smith',
      ...input,
    } as FakeServiceNowRecord;
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
      if (body?.state !== undefined) record.state = String(body.state);
      record.sys_updated_on = this.tick(1000);
      record.sys_updated_by = this.username;
      return respond(200, { result: { sys_id: record.sys_id, number: record.number, state: record.state } });
    }
    if (method === 'GET') {
      const sinceMatch = /sys_updated_on>=(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(query);
      const since = sinceMatch
        ? Date.UTC(+sinceMatch[1], +sinceMatch[2] - 1, +sinceMatch[3], +sinceMatch[4], +sinceMatch[5], +sinceMatch[6])
        : -Infinity;
      const limit = Number(url.searchParams.get('sysparm_limit') || 100);
      const offset = Number(url.searchParams.get('sysparm_offset') || 0);
      const matching = Array.from(rows.values())
        .filter((record) => Math.floor(record.sys_updated_on / 1000) * 1000 >= since)
        .sort((a, b) => a.sys_updated_on - b.sys_updated_on || a.sys_id.localeCompare(b.sys_id))
        .slice(offset, offset + limit);
      const pair = (value: string, display = value) => ({ value, display_value: display });
      return respond(200, {
        result: matching.map((record) => ({
          sys_id: pair(record.sys_id),
          number: pair(record.number),
          short_description: pair(record.short_description),
          state: pair(record.state, this.stateLabel(record.state)),
          priority: pair(record.priority || '3', record.priority ? `${record.priority} - Custom` : '3 - Moderate'),
          assigned_to: pair('', ''),
          sys_updated_on: pair(new Date(record.sys_updated_on).toISOString().slice(0, 19).replace('T', ' ')),
          sys_updated_by: pair(record.sys_updated_by),
        })),
      });
    }
    return respond(405, { error: { message: 'Method not allowed' } });
  }
}
