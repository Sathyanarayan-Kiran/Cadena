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
  | 'state_write'
  | 'comment_read'
  | 'comment_write';

export type ConnectorCommentDirection = 'from_source' | 'to_source' | 'bidirectional';

/** Public-comment synchronization is deliberately independent for every connector and off by default. */
export interface ConnectorCommentSyncPolicy {
  enabled: boolean;
  direction: ConnectorCommentDirection;
  /** Stable provider account ids. A non-empty allow-list is restrictive; the block-list always wins. */
  authorAllowList: string[];
  authorBlockList: string[];
}

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
  /** Public comments only. Private work notes/restricted comments are discarded inside the adapter. */
  commentSync?: ConnectorCommentSyncPolicy;
  /** How twins become governed WorkItems: owning team, type map and owner map. */
  projection?: Record<string, unknown>;
}

export interface ConnectorWriteBackPolicy {
  /** Allow operators to change a twin's native state through an audited connector work order. */
  state?: boolean;
  /** Canonical field names (the same keys as `CanonicalTwin.payload`) operators may edit directly on this connector's own twins. */
  fields?: string[];
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

/** A provider comment that the adapter has already classified as customer-visible. */
export interface ExternalPublicComment {
  externalId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  nativeUrl?: string;
  /** Cadena marker found on a returning transferred comment. */
  originMarker?: string;
}

export interface TwinPublicComment {
  id: string;
  sourceTwinId: string;
  sourceConnectorId: string;
  providerCommentId: string;
  body: string;
  originalAuthorId: string;
  originalAuthorName: string;
  sourceSystem: ConnectorProviderType;
  sourceCreatedAt: string;
  nativeUrl?: string;
  readOnly: true;
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
  commentsFetched: number;
  commentsStored: number;
  commentsFiltered: number;
  commentsTransferred: number;
  commentsFailed: number;
  recordErrors: IngestionRecordError[];
  hasMore: boolean;
  nextCursors: WatermarkCursor[];
  durationMs: number;
}

export type ConnectorWorkOrderStatus = 'pending' | 'processing' | 'executed' | 'failed' | 'dead' | 'held' | 'noop';

export type ConnectorWorkOrderOrigin = 'state_translation' | 'state_propagation' | 'operator_edit';

export interface ConnectorQueueAttempt {
  attempt: number;
  startedAt: string;
  completedAt: string;
  outcome: 'executed' | 'retry_scheduled' | 'dead_lettered' | 'held' | 'completed' | 'requeued';
  error?: string;
}

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
  sourceEventId?: string;
  queuePosition: number;
  attemptHistory: ConnectorQueueAttempt[];
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
  pausedTwinQueues: number;
}

export type TwinQueueEntryKind = 'ingestion' | 'state_write' | 'state_translation';

/** Operator view of one twin-scoped queue head that exhausted retries or needs correction. */
export interface TwinQueueDeadLetter {
  id: string;
  orgId: string;
  connectorId: string;
  twinId?: string;
  partitionKey: string;
  kind: TwinQueueEntryKind;
  status: 'dead' | 'held';
  payload: Record<string, unknown>;
  attempts: number;
  attemptHistory: ConnectorQueueAttempt[];
  lastError: string;
  queuePosition: number;
  createdAt: string;
  updatedAt: string;
}

export interface TwinQueueReinjectionResult {
  entryId: string;
  kind: TwinQueueEntryKind;
  status: 'pending';
  requeued: true;
  message: string;
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
  projection: TwinProjectionSummary;
}

/** The twin-backed WorkItem that puts this record under SLA, traceability and metrics governance. */
export interface TwinProjectionSummary {
  status: 'pending' | 'projected' | 'held' | 'disabled';
  reason?: string;
  workItemId?: string;
  workItemKey?: string;
  workItemType?: string;
  agingBucket?: string;
  agingScore?: number;
  escalatedAt?: string;
  enteredStateAt?: string;
  teamId?: string;
  ownerId?: string;
}

export interface TwinDetail extends TwinWorkspaceRow {
  fields: TwinFieldPolicy[];
  workOrders: ConnectorWorkOrder[];
  comments: TwinPublicComment[];
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
