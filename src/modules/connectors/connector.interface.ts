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

export interface ConnectorStateWrite {
  entityType: string;
  externalId: string;
  targetState: string;
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

  /** Move one native record to the target state. Throws ConnectorRemoteError on failure. */
  pushStateChange(ctx: ConnectorContext, write: ConnectorStateWrite): Promise<{ nativeKey?: string; message: string }>;
}
