export type ConnectorProviderType = 'jira' | 'servicenow' | 'azure_devops' | 'zendesk' | 'salesforce' | 'github' | 'asana';

/**
 * Connector lifecycle.
 *
 * unconfigured → connected (credentials verified) → discovered (schema + capability report)
 * → active (operator activation; refused while blocking limitations exist). `degraded` means the
 * last poll succeeded for some records only; `error` means the last operation failed outright.
 * Synchronization is permitted only after activation and never while `paused`.
 */
export type ConnectorStatus =
  | 'unconfigured'
  | 'connected'
  | 'discovering'
  | 'discovered'
  | 'active'
  | 'degraded'
  | 'error'
  | 'paused';

export type ConnectorCapability =
  | 'connection_test'
  | 'scope_discovery'
  | 'field_discovery'
  | 'custom_field_discovery'
  | 'state_discovery'
  | 'incremental_query'
  | 'state_write';

export interface ConnectorConfigDto {
  name: string;
  provider: ConnectorProviderType;
  baseUrl?: string;
  authType?: 'basic' | 'bearer';
  /** Secret references only, for example `{ apiToken: "env:JIRA_API_TOKEN" }`. Plaintext is rejected. */
  credentials?: Record<string, string>;
  /** Non-secret provider options such as `accountEmail`, `username` or `queryTimeZone`. */
  options?: Record<string, unknown>;
  projectKeys?: string[];
  tableNames?: string[];
  /** Fields that synchronization depends on, keyed by entity type. Missing fields block activation. */
  requiredFields?: Record<string, string[]>;
  /** Operator edits Cadena may write back to this source. Everything is read-only by default. */
  writeBack?: ConnectorWriteBackPolicy;
}

export interface ConnectorWriteBackPolicy {
  /** Allow operators to change a twin's native state through an audited connector work order. */
  state?: boolean;
}

export interface ConnectorFieldSchema {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  required: boolean;
  custom: boolean;
  allowedValues?: string[];
  /** Provider-native codes for `allowedValues`, index-aligned (for example ServiceNow state choices). */
  allowedValueCodes?: string[];
}

export interface ConnectorEntitySchema {
  entityType: string; // e.g. "issue", "incident"
  name: string;
  fields: ConnectorFieldSchema[];
}

export interface ConnectorScope {
  /** Project key or table name as configured. */
  id: string;
  name: string;
  entityType: string;
  found: boolean;
}

export interface ConnectorLimitation {
  code:
    | 'scope_not_found'
    | 'field_not_found'
    | 'state_values_unknown'
    | 'capability_missing'
    | 'provider_warning';
  severity: 'blocking' | 'warning';
  message: string;
  entityType?: string;
  field?: string;
}

export interface ConnectorCapabilityReport {
  ready: boolean;
  limitations: ConnectorLimitation[];
  evaluatedAt: string;
}

export interface ConnectorDiscoveryResult {
  provider: ConnectorProviderType;
  entities: ConnectorEntitySchema[];
  scopes: ConnectorScope[];
  discoveredAt: string;
  supportedCapabilities: ConnectorCapability[];
  warnings?: string[];
  capabilityReport?: ConnectorCapabilityReport;
}

export interface WatermarkCursor {
  entityType: string;
  cursorValue: string; // ISO timestamp
  updatedAt?: string;
}

export interface ExternalRecordPayload {
  externalId: string;
  artifactType: string; // "issue", "incident", "change_request"
  title: string;
  nativeKey?: string;
  nativeUrl?: string;
  status: string;
  fields: Record<string, unknown>;
  fieldAuthority?: Record<string, string>; // fieldName -> provider system name
  updatedAt: string;
  updatedBy?: string;
}

export interface CanonicalTwin {
  id: string;
  orgId: string;
  connectorId: string;
  provider: ConnectorProviderType;
  artifactType: string;
  externalId: string;
  nativeKey?: string;
  nativeUrl?: string;
  title?: string;
  status?: string;
  syncState: 'synced' | 'diverged' | 'error' | 'paused';
  fieldAuthority: Record<string, string>;
  payload: Record<string, unknown>;
  correlationNodeId?: string;
  sourceUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRecord {
  id: string;
  orgId: string;
  provider: ConnectorProviderType;
  name: string;
  status: ConnectorStatus;
  config: Record<string, unknown>;
  discoveryMetadata?: ConnectorDiscoveryResult;
  activatedAt?: string;
  lastSyncedAt?: string;
  lastSuccessAt?: string;
  syncLagSeconds: number;
  consecutiveFailures: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionRecordError {
  externalId: string;
  entityType: string;
  message: string;
}

export interface IngestionPollResult {
  connectorId: string;
  provider: ConnectorProviderType;
  fetchedCount: number;
  twinsCreated: number;
  twinsUpdated: number;
  twinsUnchanged: number;
  echoesSuppressed: number;
  workOrdersPrepared: number;
  workOrdersHeld: number;
  workOrdersExecuted: number;
  workOrdersFailed: number;
  recordErrors: IngestionRecordError[];
  hasMore: boolean;
  nextCursors: WatermarkCursor[];
  durationMs: number;
}

export type ConnectorWorkOrderStatus = 'pending' | 'executed' | 'failed' | 'dead' | 'noop';

export type ConnectorWorkOrderOrigin = 'state_translation' | 'operator_edit';

export interface ConnectorWorkOrder {
  id: string;
  orgId: string;
  /** US13.1 state-sync transaction for translations; null for operator edits. */
  transactionId: string | null;
  origin: ConnectorWorkOrderOrigin;
  requestedBy?: string;
  sourceConnectorId: string | null;
  targetConnectorId: string;
  targetTwinId: string;
  targetEntityType: string;
  targetExternalId: string;
  targetState: string;
  fields: Record<string, unknown>;
  status: ConnectorWorkOrderStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  executedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorHealth {
  connectorId: string;
  provider: ConnectorProviderType;
  status: ConnectorStatus;
  activatedAt?: string;
  lastSyncedAt?: string;
  lastSuccessAt?: string;
  secondsSinceLastSuccess: number | null;
  syncLagSeconds: number;
  consecutiveFailures: number;
  errorMessage?: string;
  twinCount: number;
  cursors: WatermarkCursor[];
  workOrders: Record<ConnectorWorkOrderStatus, number>;
}

export interface ConnectorProviderDescriptor {
  provider: ConnectorProviderType;
  displayName: string;
  scopeLabel: string;
  authTypes: Array<'basic' | 'bearer'>;
  capabilities: ConnectorCapability[];
}

export type TwinFieldEditReason =
  | 'write_back_enabled'
  | 'no_outbound_mapping'
  | 'write_back_disabled'
  | 'connector_unavailable'
  | 'capability_missing'
  | 'state_values_unknown';

export interface TwinFieldPolicy {
  /** Canonical field name; `state` for the native lifecycle field. */
  field: string;
  /** Provider-native field id, e.g. `status` (Jira) or `state` (ServiceNow). */
  nativeField: string;
  label: string;
  value: unknown;
  /** System that owns the field. */
  authority: string;
  editable: boolean;
  reason: TwinFieldEditReason;
  message: string;
  allowedValues?: string[];
}

export interface TwinCounterpart {
  nodeId: string;
  system: string;
  entityType: string;
  immutableId: string;
  displayKey: string | null;
  url: string | null;
  twinId?: string;
  status?: string;
}

export interface TwinWorkspaceRow extends CanonicalTwin {
  connectorName: string;
  connectorStatus: ConnectorStatus;
  lastSuccessAt?: string;
  counterparts: TwinCounterpart[];
  queuedWrites: number;
  failedWrites: number;
}

export interface TwinDetail extends TwinWorkspaceRow {
  fields: TwinFieldPolicy[];
  workOrders: ConnectorWorkOrder[];
}

export interface TwinEditResult {
  decision: 'routed' | 'noop';
  twinId: string;
  field: string;
  value: string;
  workOrder?: ConnectorWorkOrder;
  propagation: { prepared: number; executed: number; held: number };
  message: string;
}

export interface WorkspaceOverview {
  sources: Array<ConnectorHealth & { name: string }>;
  totals: {
    sources: number;
    healthy: number;
    attention: number;
    twins: number;
    maxLagSeconds: number;
    queuedWrites: number;
    failedWrites: number;
  };
}
