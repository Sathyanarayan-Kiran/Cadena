export type ConnectorProviderType = 'jira' | 'servicenow' | 'azure_devops' | 'zendesk' | 'salesforce' | 'github' | 'asana';

export type ConnectorStatus =
  | 'unconfigured'
  | 'connected'
  | 'discovering'
  | 'active'
  | 'degraded'
  | 'error'
  | 'paused';

export interface ConnectorConfigDto {
  name: string;
  provider: ConnectorProviderType;
  baseUrl?: string;
  authType?: 'basic' | 'bearer' | 'oauth2' | 'apiKey';
  credentials?: Record<string, string>; // Secret references e.g. { apiToken: "env:JIRA_API_TOKEN" }
  options?: Record<string, unknown>;
  projectKeys?: string[];
  tableNames?: string[];
}

export interface ConnectorFieldSchema {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  required: boolean;
  custom: boolean;
  allowedValues?: string[];
}

export interface ConnectorEntitySchema {
  entityType: string; // e.g. "issue", "incident"
  name: string;
  fields: ConnectorFieldSchema[];
}

export interface ConnectorDiscoveryResult {
  provider: ConnectorProviderType;
  entities: ConnectorEntitySchema[];
  discoveredAt: string;
  supportedCapabilities: string[];
  warnings?: string[];
}

export interface WatermarkCursor {
  entityType: string;
  cursorValue: string; // ISO timestamp or ID/sequence
  updatedAt?: string;
}

export interface ExternalRecordPayload {
  externalId: string;
  artifactType: string; // "issue", "incident", "pull_request"
  title: string;
  nativeKey?: string;
  nativeUrl?: string;
  status: string;
  fields: Record<string, unknown>;
  fieldAuthority?: Record<string, string>; // fieldName -> provider system name
  updatedAt: string;
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
  syncState: 'synced' | 'diverged' | 'error' | 'paused';
  fieldAuthority: Record<string, string>;
  payload: Record<string, unknown>;
  correlationNodeId?: string;
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
  lastSyncedAt?: string;
  lastSuccessAt?: string;
  syncLagSeconds: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionPollResult {
  connectorId: string;
  provider: ConnectorProviderType;
  fetchedCount: number;
  twinsCreated: number;
  twinsUpdated: number;
  workOrdersPrepared: number;
  workOrdersHeld: number;
  workOrdersExecuted: number;
  nextCursors: WatermarkCursor[];
  durationMs: number;
}
