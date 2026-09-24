import {
  ConnectorCapability,
  ConnectorDiscoveryResult,
  ConnectorProviderDescriptor,
  ConnectorProviderType,
  ConnectorRecord,
  ExternalRecordPayload,
  WatermarkCursor,
} from './connector.types';

/**
 * Everything an adapter needs for one operation. Credentials arrive already resolved from
 * their secret references; adapters never see or persist the references themselves.
 */
export interface ConnectorContext {
  connector: ConnectorRecord;
  baseUrl: string;
  credentials: Record<string, string>;
}

/** A half-open time range `[from, to)` a backfill chunk reads, aligned to whole minutes. */
export interface BackfillWindow {
  from: Date;
  to: Date;
}

export interface BackfillPage {
  records: ExternalRecordPayload[];
  /** Opaque continuation for the next page of the same window; absent when the window is exhausted. */
  nextPageToken?: string;
}

/** What happened to one record of an enqueued page: newly queued, or already queued/ingested. */
export interface EnqueuedRecordOutcome {
  externalId: string;
  updatedAt: string;
  queueEntryId: string | null;
  outcome: 'enqueued' | 'duplicate';
}

export interface ConnectorFetchPage {
  records: ExternalRecordPayload[];
  /** Watermark to persist after these records are durably materialized. */
  nextCursor: WatermarkCursor;
  /** True when the per-poll page budget was exhausted before the provider ran out of changes. */
  hasMore: boolean;
}

/**
 * One write to a native record: a state transition, a set of mapped field values, or both in one
 * request (US17.2 generalizes the former state-only write so a composite propagation — a state
 * change and its mapped fields together — reaches the provider as a single call where the
 * provider's own API allows it, e.g. Jira sets fields alongside a transition).
 */
export interface ConnectorRecordUpdate {
  entityType: string;
  externalId: string;
  /** Native state name. Omitted for a fields-only update. */
  targetState?: string;
  /** Canonical field names, the same shape as `ExternalRecordPayload.fields`. */
  fields?: Record<string, unknown>;
}

export interface ConnectorAdapter {
  readonly provider: ConnectorProviderType;
  readonly descriptor: ConnectorProviderDescriptor;
  readonly capabilities: readonly ConnectorCapability[];

  /**
   * Static validation performed at registration. Throws ConnectorConfigurationError or
   * ConnectorCredentialError so an unusable configuration is refused before any sync.
   */
  validateConfig(config: Record<string, unknown>): void;

  /** Entity types this connector synchronizes, derived from its configuration. */
  entityTypes(config: Record<string, unknown>): string[];

  /** Verify credentials and reachability. Throws on failure; returns the authenticated identity. */
  testConnection(ctx: ConnectorContext): Promise<{ account: string }>;

  /** Enumerate configured scopes, entity types, and standard/custom fields via the native API. */
  discoverSchema(ctx: ConnectorContext): Promise<ConnectorDiscoveryResult>;

  /** Fetch records of one entity type changed at or after the cursor, oldest first. */
  fetchChanges(ctx: ConnectorContext, entityType: string, cursor?: WatermarkCursor): Promise<ConnectorFetchPage>;

  /**
   * Runs a validated native query (JQL or an encoded query, US17.3) for records changed at or
   * after `cursor`, oldest first. Optional: only providers with a query language implement it. The
   * cursor is required, so a scheduled query can never read history before its saved watermark, and
   * the adapter confines the query to the connector's configured scope.
   */
  fetchNativeQuery?(ctx: ConnectorContext, entityType: string, query: string, cursor: WatermarkCursor): Promise<ConnectorFetchPage>;

  /**
   * Reads ONE page of the records last updated inside `window` (US17.4 backfill), optionally
   * narrowed by a validated native query. The window is half-open and applied by the adapter, along
   * with the connector's own scope, so a job can never read outside either. `pageToken` resumes a
   * window mid-way, which is what makes a chunk resumable at page granularity.
   */
  fetchBackfillPage?(
    ctx: ConnectorContext,
    entityType: string,
    window: BackfillWindow,
    query: string | undefined,
    pageToken?: string,
  ): Promise<BackfillPage>;

  /**
   * Writes a state, a set of fields, or both to one native record. Throws ConnectorRemoteError on
   * failure, and ConnectorConfigurationError if neither `targetState` nor `fields` is given.
   */
  pushUpdate(ctx: ConnectorContext, update: ConnectorRecordUpdate): Promise<{ nativeKey?: string; message: string }>;
}
