import { BackfillPage, BackfillWindow, ConnectorAdapter, ConnectorCommentTarget, ConnectorContext, ConnectorFetchPage, ConnectorRecordUpdate } from './connector.interface';
import {
  ConnectorFetch,
  ConnectorConfigurationError,
  ConnectorCredentialError,
  ConnectorRemoteError,
  assertTimeZone,
  basicAuthHeader,
  createLiveConnectorFetch,
  formatInTimeZone,
  requestJson,
  trimBaseUrl,
} from './connector-http';
import {
  ConnectorCapability,
  ConnectorDiscoveryResult,
  ConnectorFieldSchema,
  ConnectorProviderDescriptor,
  ExternalPublicComment,
  ExternalRecordPayload,
  WatermarkCursor,
} from './connector.types';
import { optionNumber, optionString, stringList } from './connector-config';
import { ConnectorRateGovernor, getConnectorRateGovernor } from './rate-governor';

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;
const STANDARD_FIELDS = ['summary', 'status', 'created', 'updated', 'priority', 'assignee', 'issuetype', 'project', 'description', 'resolution'];
const PAGE_SIZE = 100;
/** JQL datetimes have minute precision, so the query overlaps the watermark by one minute. */
const JQL_OVERLAP_MS = 60_000;

/**
 * Native Jira Cloud connector (REST API v3).
 *
 * - Connection: `GET /rest/api/3/myself`
 * - Discovery: `GET /rest/api/3/project/search`, `/rest/api/3/field`, `/rest/api/3/status`
 * - Incremental ingestion: `POST /rest/api/3/search/jql` ordered by `updated`, token-paginated
 * - State write: `GET|POST /rest/api/3/issue/{id}/transitions`
 *
 * Authentication is Basic (account email + API token) or Bearer (OAuth/PAT access token).
 */
export class JiraConnectorAdapter implements ConnectorAdapter {
  public readonly provider = 'jira' as const;
  public readonly capabilities: readonly ConnectorCapability[] = [
    'connection_test',
    'scope_discovery',
    'field_discovery',
    'custom_field_discovery',
    'state_discovery',
    'incremental_query',
    'state_write',
    'comment_read',
    'comment_write',
  ];
  public readonly descriptor: ConnectorProviderDescriptor = {
    provider: 'jira',
    displayName: 'Jira Cloud',
    scopeLabel: 'Project keys',
    authTypes: ['basic', 'bearer'],
    capabilities: [...this.capabilities],
  };

  constructor(
    private readonly http: ConnectorFetch = createLiveConnectorFetch(),
    private readonly rateGovernor: ConnectorRateGovernor = getConnectorRateGovernor(),
  ) {}

  public validateConfig(config: Record<string, unknown>): void {
    const baseUrl = optionString(config, 'baseUrl');
    if (!baseUrl || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
      throw new ConnectorConfigurationError('Jira connectors require an http(s) baseUrl such as https://acme.atlassian.net');
    }
    const keys = stringList(config.projectKeys);
    if (keys.length === 0) throw new ConnectorConfigurationError('Jira connectors require at least one project key');
    const invalid = keys.filter((key) => !PROJECT_KEY.test(key));
    if (invalid.length) throw new ConnectorConfigurationError(`Invalid Jira project keys: ${invalid.join(', ')}`);
    assertTimeZone(this.timeZone(config));

    const credentials = (config.credentials || {}) as Record<string, string>;
    const authType = config.authType || 'basic';
    if (authType === 'basic') {
      if (!credentials.apiToken) throw new ConnectorCredentialError('Basic Jira auth requires credentials.apiToken');
      if (!optionString(config.options, 'accountEmail')) {
        throw new ConnectorConfigurationError('Basic Jira auth requires options.accountEmail');
      }
    } else if (authType === 'bearer') {
      if (!credentials.accessToken) throw new ConnectorCredentialError('Bearer Jira auth requires credentials.accessToken');
    } else {
      throw new ConnectorConfigurationError(`Unsupported Jira authType '${String(authType)}'`);
    }
  }

  public entityTypes(): string[] {
    return ['issue'];
  }

  public async testConnection(ctx: ConnectorContext): Promise<{ account: string }> {
    const me = await this.get(ctx, '/rest/api/3/myself');
    return { account: me?.displayName || me?.emailAddress || me?.accountId || 'unknown' };
  }

  public async discoverSchema(ctx: ConnectorContext): Promise<ConnectorDiscoveryResult> {
    const keys = stringList(ctx.connector.config.projectKeys);
    const query = keys.map((key) => `keys=${encodeURIComponent(key)}`).join('&');
    const projectPage = await this.get(ctx, `/rest/api/3/project/search?${query}&maxResults=${Math.max(keys.length, 1)}`);
    const projects: any[] = Array.isArray(projectPage?.values) ? projectPage.values : [];
    const fieldsRaw: any[] = (await this.get(ctx, '/rest/api/3/field')) || [];
    const statusesRaw: any[] = (await this.get(ctx, '/rest/api/3/status')) || [];

    const statusNames = Array.from(new Set(statusesRaw.map((status) => String(status?.name || '')).filter(Boolean)));
    const fields: ConnectorFieldSchema[] = fieldsRaw
      .filter((field) => field && typeof field.id === 'string')
      .map((field) => ({
        id: field.id,
        name: String(field.name || field.id),
        type: this.fieldType(field.schema?.type),
        required: field.id === 'summary' || field.id === 'status' || field.id === 'issuetype' || field.id === 'project',
        custom: Boolean(field.custom),
        ...(field.id === 'status' && statusNames.length ? { allowedValues: statusNames } : {}),
      }));

    return {
      provider: 'jira',
      entities: [{ entityType: 'issue', name: 'Jira issue', fields }],
      scopes: keys.map((key) => {
        const project = projects.find((candidate) => String(candidate?.key).toUpperCase() === key.toUpperCase());
        return { id: key, name: project?.name || key, entityType: 'issue', found: Boolean(project) };
      }),
      discoveredAt: new Date().toISOString(),
      supportedCapabilities: [...this.capabilities],
    };
  }

  public async fetchChanges(ctx: ConnectorContext, entityType: string, cursor?: WatermarkCursor): Promise<ConnectorFetchPage> {
    if (entityType !== 'issue') throw new ConnectorConfigurationError(`Jira does not expose entity type '${entityType}'`);
    const projectClause = this.projectClause(ctx);
    const since = cursor?.cursorValue ? new Date(Date.parse(cursor.cursorValue) - JQL_OVERLAP_MS) : null;
    const jql = since
      ? `${projectClause} AND ${this.updatedSince(ctx, since)} ORDER BY updated ASC, key ASC`
      : `${projectClause} ORDER BY updated ASC, key ASC`;
    return this.searchPages(ctx, jql, cursor);
  }

  /**
   * A scheduled JQL query (US17.3). The operator's text is parenthesised and ANDed with the
   * connector's own project scope and the watermark, so it can neither read another project nor
   * reach history older than the saved watermark, whatever the query says.
   */
  public async fetchNativeQuery(ctx: ConnectorContext, entityType: string, query: string, cursor: WatermarkCursor): Promise<ConnectorFetchPage> {
    if (entityType !== 'issue') throw new ConnectorConfigurationError(`Jira does not expose entity type '${entityType}'`);
    if (!cursor?.cursorValue || Number.isNaN(Date.parse(cursor.cursorValue))) {
      throw new ConnectorConfigurationError('A scheduled query needs a watermark; refusing to run it unbounded');
    }
    const since = new Date(Date.parse(cursor.cursorValue) - JQL_OVERLAP_MS);
    const jql = `(${query}) AND ${this.projectClause(ctx)} AND ${this.updatedSince(ctx, since)} ORDER BY updated ASC, key ASC`;
    return this.searchPages(ctx, jql, cursor);
  }

  /**
   * One page of a backfill window (US17.4): `updated >= from AND updated < to`, half-open so
   * neighbouring windows never overlap, ANDed with the connector's project scope and any validated
   * operator query. Jira's own continuation token resumes the window on the next call.
   */
  public async fetchBackfillPage(
    ctx: ConnectorContext,
    entityType: string,
    window: BackfillWindow,
    query: string | undefined,
    pageToken?: string,
  ): Promise<BackfillPage> {
    if (entityType !== 'issue') throw new ConnectorConfigurationError(`Jira does not expose entity type '${entityType}'`);
    const customFields = stringList((ctx.connector.config.options as any)?.customFieldIds).filter((id) => /^customfield_\d+$/.test(id));
    const scope = query ? `(${query}) AND ${this.projectClause(ctx)}` : this.projectClause(ctx);
    const jql = `${scope} AND ${this.updatedSince(ctx, window.from)} AND ${this.updatedClause(ctx, '<', window.to)} ORDER BY updated ASC, key ASC`;
    const page = await this.post(ctx, '/rest/api/3/search/jql', {
      jql,
      maxResults: PAGE_SIZE,
      fields: [...STANDARD_FIELDS, ...customFields],
      ...(pageToken ? { nextPageToken: pageToken } : {}),
    });
    const records = (Array.isArray(page?.issues) ? page.issues : []).map((issue: any) => this.toRecord(ctx, issue, customFields));
    const next = typeof page?.nextPageToken === 'string' && page.nextPageToken && page?.isLast !== true ? page.nextPageToken : undefined;
    return { records, nextPageToken: next };
  }

  private projectClause(ctx: ConnectorContext): string {
    const keys = stringList(ctx.connector.config.projectKeys);
    return `project in (${keys.map((key) => `"${key}"`).join(', ')})`;
  }

  private updatedSince(ctx: ConnectorContext, since: Date): string {
    return this.updatedClause(ctx, '>=', since);
  }

  private updatedClause(ctx: ConnectorContext, operator: '>=' | '<', instant: Date): string {
    return `updated ${operator} "${formatInTimeZone(instant, this.timeZone(ctx.connector.config)).slice(0, 16).replace(/-/g, '/')}"`;
  }

  private async searchPages(ctx: ConnectorContext, jql: string, cursor?: WatermarkCursor): Promise<ConnectorFetchPage> {
    const config = ctx.connector.config;
    const maxPages = optionNumber(config.options, 'maxPagesPerPoll', 10, 1, 100);
    const customFields = stringList((config.options as any)?.customFieldIds).filter((id) => /^customfield_\d+$/.test(id));

    const records: ExternalRecordPayload[] = [];
    const priorWatermark = cursor?.cursorValue ? Date.parse(cursor.cursorValue) : -Infinity;
    let nextPageToken: string | undefined;
    let pages = 0;
    let exhausted = false;
    let advanced = false;
    // The page budget only applies once the watermark has moved; otherwise a busy overlap
    // window larger than the budget would be re-read forever without progress.
    do {
      const page = await this.post(ctx, '/rest/api/3/search/jql', {
        jql,
        maxResults: PAGE_SIZE,
        fields: [...STANDARD_FIELDS, ...customFields],
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      for (const issue of Array.isArray(page?.issues) ? page.issues : []) {
        const record = this.toRecord(ctx, issue, customFields);
        records.push(record);
        if (Date.parse(record.updatedAt) > priorWatermark) advanced = true;
      }
      nextPageToken = typeof page?.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : undefined;
      exhausted = page?.isLast === true || !nextPageToken;
      pages++;
    } while (!exhausted && (pages < maxPages || !advanced));

    let watermark = cursor?.cursorValue ? Date.parse(cursor.cursorValue) : 0;
    for (const record of records) watermark = Math.max(watermark, Date.parse(record.updatedAt));
    return {
      records,
      hasMore: !exhausted,
      nextCursor: { entityType: 'issue', cursorValue: new Date(watermark).toISOString(), updatedAt: new Date().toISOString() },
    };
  }

  public async pushUpdate(ctx: ConnectorContext, update: ConnectorRecordUpdate): Promise<{ nativeKey?: string; message: string }> {
    const hasFields = Boolean(update.fields && Object.keys(update.fields).length);
    if (!update.targetState && !hasFields) {
      throw new ConnectorConfigurationError('pushUpdate requires a target state, at least one field, or both');
    }
    const issuePath = `/rest/api/3/issue/${encodeURIComponent(update.externalId)}`;
    const jiraFields = hasFields ? this.toJiraWriteFields(update.fields!) : undefined;

    if (update.targetState) {
      const available = await this.get(ctx, `${issuePath}/transitions`);
      const transitions: any[] = Array.isArray(available?.transitions) ? available.transitions : [];
      const target = update.targetState.trim().toLowerCase();
      const transition = transitions.find((candidate) => String(candidate?.to?.name || '').trim().toLowerCase() === target);
      if (!transition) {
        throw new ConnectorRemoteError(
          `Jira issue ${update.externalId} has no available transition to '${update.targetState}'`,
          null,
          false,
        );
      }
      // Jira accepts field values alongside a transition in the same call, so a composite
      // state-plus-fields propagation reaches the provider as one write, not two.
      await this.post(ctx, `${issuePath}/transitions`, { transition: { id: String(transition.id) }, ...(jiraFields ? { fields: jiraFields } : {}) });
      return { nativeKey: update.externalId, message: `Transitioned Jira issue ${update.externalId} to ${update.targetState}` };
    }

    await this.put(ctx, issuePath, { fields: jiraFields });
    return { nativeKey: update.externalId, message: `Updated fields on Jira issue ${update.externalId}` };
  }

  public async fetchPublicComments(ctx: ConnectorContext, target: ConnectorCommentTarget): Promise<ExternalPublicComment[]> {
    if (target.entityType !== 'issue') throw new ConnectorConfigurationError(`Jira does not expose comments for '${target.entityType}'`);
    const page = await this.get(ctx, `/rest/api/3/issue/${encodeURIComponent(target.externalId)}/comment?maxResults=1000&orderBy=created`);
    const comments: any[] = Array.isArray(page?.comments) ? page.comments : [];
    return comments.filter((comment) => {
      // Jira restricted visibility and JSM internal comments are private at the adapter boundary.
      const internalProperty = Array.isArray(comment?.properties) && comment.properties.some(
        (property: any) => property?.key === 'sd.public.comment' && property?.value?.internal === true,
      );
      return !comment?.visibility && comment?.jsdPublic !== false && !internalProperty;
    }).map((comment) => {
      const body = jiraCommentText(comment?.body);
      return {
        externalId: String(comment.id),
        body,
        authorId: String(comment.author?.accountId || 'jira:unattributed'),
        authorName: String(comment.author?.displayName || comment.author?.accountId || 'Unknown Jira author'),
        createdAt: normalizeJiraTimestamp(comment.created),
        originMarker: commentMarker(body),
      } satisfies ExternalPublicComment;
    });
  }

  public async pushPublicComment(
    ctx: ConnectorContext,
    target: ConnectorCommentTarget,
    body: string,
  ): Promise<{ externalId: string; message: string }> {
    if (target.entityType !== 'issue') throw new ConnectorConfigurationError(`Jira does not expose comments for '${target.entityType}'`);
    const created = await this.post(ctx, `/rest/api/3/issue/${encodeURIComponent(target.externalId)}/comment`, {
      body: jiraCommentAdf(body),
    });
    if (!created?.id) throw new ConnectorRemoteError('Jira did not return an id for the created comment', null, false);
    return { externalId: String(created.id), message: `Added a public comment to Jira issue ${target.externalId}` };
  }

  /**
   * Wraps a canonical field value into the shape the Jira issue-write API expects for that field
   * id. Priority and assignee are reference-like fields Jira represents as objects even though
   * discovery and ingestion surface them as flat values; every other field (including custom
   * fields, already validated against discovery before a mapping publishes) passes through as-is.
   */
  private toJiraWriteFields(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === 'priority') out.priority = { name: String(value) };
      else if (key === 'assignee' || key === 'assigneeAccountId') out.assignee = { accountId: String(value) };
      else out[key] = value;
    }
    return out;
  }

  private toRecord(ctx: ConnectorContext, issue: any, customFields: string[]): ExternalRecordPayload {
    const f = issue?.fields || {};
    const key = String(issue?.key || issue?.id);
    const custom: Record<string, unknown> = {};
    for (const id of customFields) if (f[id] !== undefined) custom[id] = f[id];
    const status = String(f.status?.name || '');
    return {
      externalId: String(issue.id),
      artifactType: 'issue',
      title: String(f.summary || ''),
      nativeKey: key,
      nativeUrl: `${trimBaseUrl(ctx.baseUrl)}/browse/${key}`,
      status,
      fields: {
        summary: f.summary ?? '',
        status,
        priority: f.priority?.name ?? null,
        assignee: f.assignee?.displayName ?? null,
        assigneeAccountId: f.assignee?.accountId ?? null,
        assigneeEmail: f.assignee?.emailAddress ?? null,
        issueType: f.issuetype?.name ?? null,
        createdAt: f.created ? normalizeJiraTimestamp(f.created) : null,
        projectKey: f.project?.key ?? key.split('-')[0],
        description: f.description ?? null,
        // US13.5: present only once the issue is resolved, so records that never resolve keep their earlier shape.
        ...(f.resolution?.name ? { resolution: String(f.resolution.name) } : {}),
        ...custom,
      },
      fieldAuthority: { summary: 'jira', status: 'jira', priority: 'jira', assignee: 'jira', description: 'jira' },
      updatedAt: normalizeJiraTimestamp(f.updated),
    };
  }

  private fieldType(schemaType: unknown): ConnectorFieldSchema['type'] {
    switch (schemaType) {
      case 'number': return 'number';
      case 'date':
      case 'datetime': return 'date';
      case 'array': return 'array';
      case 'string':
      case undefined: return 'string';
      default: return 'object';
    }
  }

  private timeZone(config: Record<string, unknown>): string {
    return optionString(config.options, 'queryTimeZone') || 'UTC';
  }

  private headers(ctx: ConnectorContext): Record<string, string> {
    const authType = ctx.connector.config.authType || 'basic';
    const authorization = authType === 'bearer'
      ? `Bearer ${ctx.credentials.accessToken}`
      : basicAuthHeader(optionString(ctx.connector.config.options, 'accountEmail') || '', ctx.credentials.apiToken || '');
    return { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  private get(ctx: ConnectorContext, path: string): Promise<any> {
    return this.rateGovernor.execute(ctx, () => requestJson(
      this.http, `${trimBaseUrl(ctx.baseUrl)}${path}`, { method: 'GET', headers: this.headers(ctx) },
    ));
  }

  private post(ctx: ConnectorContext, path: string, body: unknown): Promise<any> {
    return this.rateGovernor.execute(ctx, () => requestJson(this.http, `${trimBaseUrl(ctx.baseUrl)}${path}`, {
      method: 'POST', headers: this.headers(ctx), body: JSON.stringify(body),
    }));
  }

  private put(ctx: ConnectorContext, path: string, body: unknown): Promise<any> {
    return this.rateGovernor.execute(ctx, () => requestJson(this.http, `${trimBaseUrl(ctx.baseUrl)}${path}`, {
      method: 'PUT', headers: this.headers(ctx), body: JSON.stringify(body),
    }));
  }
}

/** Jira emits `2026-09-22T10:00:00.000+0000`; ECMAScript requires a colon in the offset. */
export function normalizeJiraTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return new Date(0).toISOString();
  const parsed = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function jiraCommentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as any;
  if (node.type === 'text') return String(node.text || '');
  const children = Array.isArray(node.content) ? node.content.map(jiraCommentText).join('') : '';
  return ['paragraph', 'heading', 'blockquote', 'listItem'].includes(node.type) ? `${children}\n` : children;
}

function jiraCommentAdf(value: string): Record<string, unknown> {
  return {
    type: 'doc', version: 1,
    content: value.split(/\r?\n/).map((line) => ({
      type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

function commentMarker(body: string): string | undefined {
  return /\[cadena-comment:([0-9a-f-]{36})\]/i.exec(body)?.[1]?.toLowerCase();
}
