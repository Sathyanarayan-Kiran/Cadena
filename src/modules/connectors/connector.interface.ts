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
   * Writes a state, a set of fields, or both to one native record. Throws ConnectorRemoteError on
   * failure, and ConnectorConfigurationError if neither `targetState` nor `fields` is given.
   */
  pushUpdate(ctx: ConnectorContext, update: ConnectorRecordUpdate): Promise<{ nativeKey?: string; message: string }>;
}
