export interface SyncIdentity {
  system: string;
  entity_type: string;
  immutable_id: string;
}

export interface RecordIntegrationWriteDto {
  identity: SyncIdentity;
  service_account_id: string;
  /** Normalized mapped fields, excluding volatile webhook metadata such as delivery time. */
  payload: Record<string, unknown>;
}

export interface EvaluateSyncWebhookDto {
  identity: SyncIdentity;
  actor_id: string;
  /** The same normalized field projection used when the outbound write was recorded. */
  payload: Record<string, unknown>;
}

export type SyncGuardReason = 'self_originated_hash' | 'content_noop' | 'external_change';

export interface SyncGuardDecision {
  node_id: string;
  identity: SyncIdentity;
  payload_hash: string;
  suppressed: boolean;
  action: 'ignore' | 'process';
  reason: SyncGuardReason;
  matched_service_account: boolean;
  decided_at: string;
}

export class InvalidSyncGuardError extends Error {}
export class SyncIdentityNotFoundError extends Error {}

