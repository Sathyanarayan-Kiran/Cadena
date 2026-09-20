export type GitIntegrationEventType = 'push' | 'pull_request' | 'deployment';

export interface GitCommitPayload {
  sha: string;
  message: string;
  url?: string;
  author?: string;
}

export interface GitPullRequestPayload {
  id: string | number;
  title: string;
  body?: string;
  url?: string;
  state?: string;
  merged?: boolean;
  head_ref?: string;
}

export interface GitDeploymentPayload {
  id: string | number;
  environment: string;
  status: string;
  url?: string;
  release_key?: string;
  work_item_keys?: string[];
  description?: string;
}

export interface GitWebhookDto {
  provider?: string;
  delivery_id?: string;
  event_type: GitIntegrationEventType;
  repository: string;
  action?: string;
  commit?: GitCommitPayload;
  commits?: GitCommitPayload[];
  pull_request?: GitPullRequestPayload;
  deployment?: GitDeploymentPayload;
}

export interface ExternalArtifact {
  id: string;
  org_id: string;
  provider: string;
  artifact_type: 'commit' | 'pull_request' | 'deployment';
  external_id: string;
  title: string;
  url?: string | null;
  status?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IntegrationTransitionResult {
  work_item_id: string;
  work_item_key: string;
  from_state: string;
  to_state: string;
  outcome: 'applied' | 'skipped';
  reason?: string;
}

export interface IntegrationDeliveryResult {
  delivery_id: string;
  provider: string;
  event_type: GitIntegrationEventType;
  duplicate: boolean;
  artifacts: ExternalArtifact[];
  linked_work_item_keys: string[];
  unresolved_keys: string[];
  transitions: IntegrationTransitionResult[];
}
