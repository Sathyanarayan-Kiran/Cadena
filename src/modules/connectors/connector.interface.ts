import {
  ConnectorDiscoveryResult,
  ConnectorProviderType,
  ConnectorRecord,
  ExternalRecordPayload,
  WatermarkCursor,
} from './connector.types';

export interface ConnectorAdapter {
  readonly provider: ConnectorProviderType;

  /** Validate credentials and basic API reachability */
  testConnection(connector: ConnectorRecord): Promise<boolean>;

  /** Discover projects/tables, entity types, and standard/custom fields */
  discoverSchema(connector: ConnectorRecord): Promise<ConnectorDiscoveryResult>;

  /** Fetch incremental records updated since cursor watermark */
  fetchChanges(
    connector: ConnectorRecord,
    cursor?: WatermarkCursor,
  ): Promise<{
    records: ExternalRecordPayload[];
    nextCursor: WatermarkCursor;
  }>;

  /** Push state transition write back to native provider API */
  pushStateChange(
    connector: ConnectorRecord,
    externalId: string,
    targetState: string,
    fields?: Record<string, unknown>,
  ): Promise<{ success: boolean; nativeKey?: string; message?: string }>;
}
