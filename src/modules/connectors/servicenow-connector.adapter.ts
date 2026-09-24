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
  ConnectorEntitySchema,
  ConnectorFieldSchema,
  ConnectorProviderDescriptor,
  ExternalPublicComment,
  ExternalRecordPayload,
  WatermarkCursor,
} from './connector.types';
import { optionNumber, optionString, stringList } from './connector-config';

const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/;
/** Core ITSM tables extend `task`, whose dictionary rows hold the shared columns such as `state`. */
const TASK_TABLES = new Set(['incident', 'change_request', 'problem', 'sc_req_item', 'sc_task']);
const SYNC_FIELDS = ['sys_id', 'number', 'short_description', 'state', 'priority', 'assigned_to', 'assigned_to.email', 'sys_created_on', 'sys_updated_on', 'sys_updated_by'];
const PAGE_SIZE = 100;

/**
 * Native ServiceNow connector (Table API).
 *
 * - Connection: `GET /api/now/table/{table}?sysparm_limit=1`
 * - Discovery: `sys_dictionary` for columns (including inherited `task` columns) and
 *   `sys_choice` for state labels and codes
 * - Incremental ingestion: `sys_updated_on>=<watermark>^ORDERBYsys_updated_on`, offset-paginated
 * - State write: `PATCH /api/now/table/{table}/{sys_id}` with the discovered state code
 */
export class ServiceNowConnectorAdapter implements ConnectorAdapter {
  public readonly provider = 'servicenow' as const;
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
    provider: 'servicenow',
    displayName: 'ServiceNow ITSM',
    scopeLabel: 'Tables',
    authTypes: ['basic', 'bearer'],
    capabilities: [...this.capabilities],
  };

  constructor(private readonly http: ConnectorFetch = createLiveConnectorFetch()) {}

  public validateConfig(config: Record<string, unknown>): void {
    const baseUrl = optionString(config, 'baseUrl');
    if (!baseUrl || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
      throw new ConnectorConfigurationError('ServiceNow connectors require an http(s) baseUrl such as https://acme.service-now.com');
    }
    const tables = stringList(config.tableNames);
    if (tables.length === 0) throw new ConnectorConfigurationError('ServiceNow connectors require at least one table name');
    const invalid = tables.filter((table) => !TABLE_NAME.test(table));
    if (invalid.length) throw new ConnectorConfigurationError(`Invalid ServiceNow table names: ${invalid.join(', ')}`);
    assertTimeZone(this.timeZone(config));

    const credentials = (config.credentials || {}) as Record<string, string>;
    const authType = config.authType || 'basic';
    if (authType === 'basic') {
      if (!credentials.password) throw new ConnectorCredentialError('Basic ServiceNow auth requires credentials.password');
      if (!optionString(config.options, 'username')) {
        throw new ConnectorConfigurationError('Basic ServiceNow auth requires options.username');
      }
    } else if (authType === 'bearer') {
      if (!credentials.accessToken) throw new ConnectorCredentialError('Bearer ServiceNow auth requires credentials.accessToken');
    } else {
      throw new ConnectorConfigurationError(`Unsupported ServiceNow authType '${String(authType)}'`);
    }
  }

  public entityTypes(config: Record<string, unknown>): string[] {
    return stringList(config.tableNames);
  }

  public async testConnection(ctx: ConnectorContext): Promise<{ account: string }> {
    const [table] = this.entityTypes(ctx.connector.config);
    await this.get(ctx, `/api/now/table/${table}?sysparm_limit=1&sysparm_fields=sys_id`);
    return { account: optionString(ctx.connector.config.options, 'username') || 'oauth-client' };
  }

  public async discoverSchema(ctx: ConnectorContext): Promise<ConnectorDiscoveryResult> {
    const tables = this.entityTypes(ctx.connector.config);
    const entities: ConnectorEntitySchema[] = [];
    const scopes: ConnectorDiscoveryResult['scopes'] = [];

    for (const table of tables) {
      const dictionaryNames = TASK_TABLES.has(table) ? `${table},task` : table;
      const dictionary = await this.get(
        ctx,
        `/api/now/table/sys_dictionary?sysparm_query=${encodeURIComponent(`nameIN${dictionaryNames}^elementISNOTEMPTY`)}`
          + '&sysparm_fields=name,element,column_label,internal_type,mandatory&sysparm_limit=2000',
      );
      const rows: any[] = Array.isArray(dictionary?.result) ? dictionary.result : [];
      const ownRows = rows.filter((row) => row?.name === table);
      scopes.push({ id: table, name: table, entityType: table, found: ownRows.length > 0 });
      if (ownRows.length === 0) continue;

      const choices = await this.get(
        ctx,
        `/api/now/table/sys_choice?sysparm_query=${encodeURIComponent(`name=${table}^element=state^inactive=false^ORDERBYsequence`)}`
          + '&sysparm_fields=label,value&sysparm_limit=200',
      );
      const stateChoices: any[] = Array.isArray(choices?.result) ? choices.result : [];

      const byElement = new Map<string, ConnectorFieldSchema>();
      // Table-specific columns override inherited task columns of the same name.
      for (const row of [...rows.filter((r) => r?.name !== table), ...ownRows]) {
        const element = String(row?.element || '');
        if (!element) continue;
        const field: ConnectorFieldSchema = {
          id: element,
          name: String(row.column_label || element),
          type: this.fieldType(String(row.internal_type || '')),
          required: String(row.mandatory) === 'true',
          custom: element.startsWith('u_'),
        };
        if (element === 'state' && stateChoices.length) {
          field.allowedValues = stateChoices.map((choice) => String(choice.label));
          field.allowedValueCodes = stateChoices.map((choice) => String(choice.value));
        }
        byElement.set(element, field);
      }
      entities.push({ entityType: table, name: `ServiceNow ${table}`, fields: Array.from(byElement.values()) });
    }

    return {
      provider: 'servicenow',
      entities,
      scopes,
      discoveredAt: new Date().toISOString(),
      supportedCapabilities: [...this.capabilities],
    };
  }

  public async fetchChanges(ctx: ConnectorContext, entityType: string, cursor?: WatermarkCursor): Promise<ConnectorFetchPage> {
    const since = cursor?.cursorValue ? formatInTimeZone(new Date(cursor.cursorValue), this.timeZone(ctx.connector.config)) : null;
    return this.queryPages(ctx, entityType, `${since ? `sys_updated_on>=${since}^` : ''}ORDERBYsys_updated_on^ORDERBYsys_id`, cursor);
  }

  /**
   * A scheduled encoded query (US17.3). The watermark is appended to *every* `^NQ` part, since a
   * bare trailing condition would only bound the last one, and ordering is applied once at the end.
   * The table in the request path already confines the query to one configured table.
   */
  public async fetchNativeQuery(ctx: ConnectorContext, entityType: string, query: string, cursor: WatermarkCursor): Promise<ConnectorFetchPage> {
    if (!cursor?.cursorValue || Number.isNaN(Date.parse(cursor.cursorValue))) {
      throw new ConnectorConfigurationError('A scheduled query needs a watermark; refusing to run it unbounded');
    }
    const since = formatInTimeZone(new Date(cursor.cursorValue), this.timeZone(ctx.connector.config));
    const bounded = query.split('^NQ').map((part) => `${part}^sys_updated_on>=${since}`).join('^NQ');
    return this.queryPages(ctx, entityType, `${bounded}^ORDERBYsys_updated_on^ORDERBYsys_id`, cursor);
  }

  /**
   * One page of a backfill window (US17.4): `sys_updated_on>=from^sys_updated_on<to`, applied to
   * every `^NQ` part of an optional operator query. Paging is keyset-like rather than a raw
   * offset: the token is the last timestamp read plus how many rows at exactly that second were
   * already consumed, and the next page restarts from that timestamp. A record edited mid-run
   * therefore can only shift a neighbour within the same second, not across a whole page boundary.
   */
  public async fetchBackfillPage(
    ctx: ConnectorContext,
    entityType: string,
    window: BackfillWindow,
    query: string | undefined,
    pageToken?: string,
  ): Promise<BackfillPage> {
    if (!this.entityTypes(ctx.connector.config).includes(entityType)) {
      throw new ConnectorConfigurationError(`Table '${entityType}' is not configured on this connector`);
    }
    const zone = this.timeZone(ctx.connector.config);
    let start = window.from;
    let skip = 0;
    if (pageToken) {
      const [stamp, consumed] = pageToken.split('|');
      const resumeAt = new Date(stamp);
      if (Number.isNaN(resumeAt.getTime()) || !/^\d+$/.test(consumed || '')) {
        throw new ConnectorConfigurationError('The backfill page token is malformed');
      }
      start = resumeAt;
      skip = Number(consumed);
    }
    const bound = `sys_updated_on>=${formatInTimeZone(start, zone)}^sys_updated_on<${formatInTimeZone(window.to, zone)}`;
    const scoped = query ? query.split('^NQ').map((part) => `${part}^${bound}`).join('^NQ') : bound;
    const page = await this.get(
      ctx,
      `/api/now/table/${entityType}?sysparm_query=${encodeURIComponent(`${scoped}^ORDERBYsys_updated_on^ORDERBYsys_id`)}`
        + `&sysparm_display_value=all&sysparm_fields=${SYNC_FIELDS.join(',')}&sysparm_limit=${PAGE_SIZE}&sysparm_offset=${skip}`,
    );
    const rows: any[] = Array.isArray(page?.result) ? page.result : [];
    const records = rows.map((row) => this.toRecord(ctx, entityType, row));
    if (rows.length < PAGE_SIZE) return { records };
    const lastStamp = records[records.length - 1].updatedAt;
    const atLast = records.filter((record) => record.updatedAt === lastStamp).length;
    // If the whole page sits at the timestamp we resumed from, its rows add to those already skipped.
    const carried = pageToken && atLast === records.length && new Date(pageToken.split('|')[0]).toISOString() === lastStamp ? skip : 0;
    return { records, nextPageToken: `${lastStamp}|${atLast + carried}` };
  }

  private async queryPages(ctx: ConnectorContext, entityType: string, query: string, cursor?: WatermarkCursor): Promise<ConnectorFetchPage> {
    const config = ctx.connector.config;
    if (!this.entityTypes(config).includes(entityType)) {
      throw new ConnectorConfigurationError(`Table '${entityType}' is not configured on this connector`);
    }
    const maxPages = optionNumber(config.options, 'maxPagesPerPoll', 10, 1, 100);

    const records: ExternalRecordPayload[] = [];
    const priorWatermark = cursor?.cursorValue ? Date.parse(cursor.cursorValue) : -Infinity;
    let offset = 0;
    let pages = 0;
    let exhausted = false;
    let advanced = false;
    // As in the Jira adapter, the page budget applies only after the watermark has moved.
    do {
      const page = await this.get(
        ctx,
        `/api/now/table/${entityType}?sysparm_query=${encodeURIComponent(query)}&sysparm_display_value=all`
          + `&sysparm_fields=${SYNC_FIELDS.join(',')}&sysparm_limit=${PAGE_SIZE}&sysparm_offset=${offset}`,
      );
      const rows: any[] = Array.isArray(page?.result) ? page.result : [];
      for (const row of rows) {
        const record = this.toRecord(ctx, entityType, row);
        records.push(record);
        if (Date.parse(record.updatedAt) > priorWatermark) advanced = true;
      }
      offset += rows.length;
      exhausted = rows.length < PAGE_SIZE;
      pages++;
    } while (!exhausted && (pages < maxPages || !advanced));

    let watermark = cursor?.cursorValue ? Date.parse(cursor.cursorValue) : 0;
    for (const record of records) watermark = Math.max(watermark, Date.parse(record.updatedAt));
    return {
      records,
      hasMore: !exhausted,
      nextCursor: { entityType, cursorValue: new Date(watermark).toISOString(), updatedAt: new Date().toISOString() },
    };
  }

  public async pushUpdate(ctx: ConnectorContext, update: ConnectorRecordUpdate): Promise<{ nativeKey?: string; message: string }> {
    const hasFields = Boolean(update.fields && Object.keys(update.fields).length);
    if (!update.targetState && !hasFields) {
      throw new ConnectorConfigurationError('pushUpdate requires a target state, at least one field, or both');
    }
    // The Table API accepts field values as flat values in the same PATCH body as a state change,
    // so a composite state-plus-fields propagation reaches the provider as one write.
    const body: Record<string, unknown> = { ...(update.fields || {}) };
    if (update.targetState) {
      const entity = ctx.connector.discoveryMetadata?.entities?.find((candidate) => candidate.entityType === update.entityType);
      const stateField = entity?.fields.find((field) => field.id === 'state');
      const labels = stateField?.allowedValues || [];
      const codes = stateField?.allowedValueCodes || [];
      const index = labels.findIndex((label) => label.trim().toLowerCase() === update.targetState!.trim().toLowerCase());
      if (index < 0 || !codes[index]) {
        throw new ConnectorRemoteError(
          `ServiceNow ${update.entityType} has no discovered state choice '${update.targetState}'`,
          null,
          false,
        );
      }
      body.state = codes[index];
    }
    const updated = await requestJson(
      this.http,
      `${trimBaseUrl(ctx.baseUrl)}/api/now/table/${update.entityType}/${encodeURIComponent(update.externalId)}`,
      { method: 'PATCH', headers: this.headers(ctx), body: JSON.stringify(body) },
    );
    const number = updated?.result?.number;
    return {
      nativeKey: typeof number === 'string' ? number : number?.value,
      message: update.targetState
        ? `Updated ServiceNow ${update.entityType} ${update.externalId} to ${update.targetState}`
        : `Updated fields on ServiceNow ${update.entityType} ${update.externalId}`,
    };
  }

  public async fetchPublicComments(ctx: ConnectorContext, target: ConnectorCommentTarget): Promise<ExternalPublicComment[]> {
    if (!this.entityTypes(ctx.connector.config).includes(target.entityType)) {
      throw new ConnectorConfigurationError(`Table '${target.entityType}' is not configured on this connector`);
    }
    // Only customer-visible `comments` are requested: internal `work_notes` never leave ServiceNow at all.
    const query = `element_id=${target.externalId}^elementINcomments^ORDERBYsys_created_on`;
    const page = await this.get(
      ctx,
      `/api/now/table/sys_journal_field?sysparm_query=${encodeURIComponent(query)}`
        + '&sysparm_display_value=all&sysparm_fields=sys_id,element,element_id,value,sys_created_on,sys_created_by&sysparm_limit=1000',
    );
    const rows: any[] = Array.isArray(page?.result) ? page.result : [];
    // Defence in depth: even if the provider ignored the element filter, anything but `comments` is discarded here.
    return rows.filter((row) => fieldValue(row?.element) === 'comments').map((row) => {
      const body = fieldDisplay(row?.value);
      return {
        externalId: fieldValue(row?.sys_id),
        body,
        authorId: fieldValue(row?.sys_created_by) || 'servicenow:unattributed',
        authorName: fieldDisplay(row?.sys_created_by) || fieldValue(row?.sys_created_by) || 'Unknown ServiceNow author',
        createdAt: parseServiceNowUtc(fieldValue(row?.sys_created_on)),
        originMarker: commentMarker(body),
      } satisfies ExternalPublicComment;
    });
  }

  public async pushPublicComment(
    ctx: ConnectorContext,
    target: ConnectorCommentTarget,
    body: string,
  ): Promise<{ externalId: string; message: string }> {
    if (!this.entityTypes(ctx.connector.config).includes(target.entityType)) {
      throw new ConnectorConfigurationError(`Table '${target.entityType}' is not configured on this connector`);
    }
    const updated = await requestJson(
      this.http,
      `${trimBaseUrl(ctx.baseUrl)}/api/now/table/${target.entityType}/${encodeURIComponent(target.externalId)}`,
      { method: 'PATCH', headers: this.headers(ctx), body: JSON.stringify({ comments: body }) },
    );
    const id = fieldValue(updated?.result?.comment_sys_id || updated?.result?.sys_id);
    if (!id) throw new ConnectorRemoteError('ServiceNow did not return an id for the created public comment', null, false);
    return { externalId: id, message: `Added a public comment to ServiceNow ${target.entityType} ${target.externalId}` };
  }

  private toRecord(ctx: ConnectorContext, table: string, row: any): ExternalRecordPayload {
    const value = (field: string) => fieldValue(row?.[field]);
    const display = (field: string) => fieldDisplay(row?.[field]);
    const sysId = value('sys_id');
    const status = display('state') || value('state');
    return {
      externalId: sysId,
      artifactType: table,
      title: display('short_description'),
      nativeKey: value('number') || sysId,
      nativeUrl: `${trimBaseUrl(ctx.baseUrl)}/nav_to.do?uri=${encodeURIComponent(`${table}.do?sys_id=${sysId}`)}`,
      status,
      fields: {
        number: value('number'),
        short_description: display('short_description'),
        state: status,
        stateCode: value('state'),
        createdAt: value('sys_created_on') ? parseServiceNowUtc(value('sys_created_on')) : null,
        priority: display('priority') || null,
        assigned_to: display('assigned_to') || null,
        // Dot-walked reference field; ServiceNow does not expose email on the base `assigned_to` value.
        assignedToEmail: value('assigned_to.email') || null,
      },
      fieldAuthority: { short_description: 'servicenow', state: 'servicenow', priority: 'servicenow', assigned_to: 'servicenow' },
      // With sysparm_display_value=all, `value` is the UTC system value; `display_value` is user-local.
      updatedAt: parseServiceNowUtc(value('sys_updated_on')),
      updatedBy: value('sys_updated_by') || undefined,
    };
  }

  private fieldType(internalType: string): ConnectorFieldSchema['type'] {
    if (['integer', 'decimal', 'float', 'longint', 'currency'].includes(internalType)) return 'number';
    if (internalType === 'boolean') return 'boolean';
    if (['glide_date_time', 'glide_date', 'due_date'].includes(internalType)) return 'date';
    if (internalType === 'glide_list') return 'array';
    if (internalType === 'reference') return 'object';
    return 'string';
  }

  private timeZone(config: Record<string, unknown>): string {
    return optionString(config.options, 'queryTimeZone') || 'UTC';
  }

  private headers(ctx: ConnectorContext): Record<string, string> {
    const authType = ctx.connector.config.authType || 'basic';
    const authorization = authType === 'bearer'
      ? `Bearer ${ctx.credentials.accessToken}`
      : basicAuthHeader(optionString(ctx.connector.config.options, 'username') || '', ctx.credentials.password || '');
    return { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  private get(ctx: ConnectorContext, path: string): Promise<any> {
    return requestJson(this.http, `${trimBaseUrl(ctx.baseUrl)}${path}`, { method: 'GET', headers: this.headers(ctx) });
  }
}

function fieldValue(field: unknown): string {
  if (field && typeof field === 'object') return String((field as any).value ?? '');
  return field === undefined || field === null ? '' : String(field);
}

function fieldDisplay(field: unknown): string {
  if (field && typeof field === 'object') return String((field as any).display_value ?? (field as any).value ?? '');
  return field === undefined || field === null ? '' : String(field);
}

export function parseServiceNowUtc(value: string): string {
  const parsed = Date.parse(value ? `${value.replace(' ', 'T')}Z` : '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function commentMarker(body: string): string | undefined {
  return /\[cadena-comment:([0-9a-f-]{36})\]/i.exec(body)?.[1]?.toLowerCase();
}
