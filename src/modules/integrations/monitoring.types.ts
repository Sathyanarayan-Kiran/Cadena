import { WorkItemPriority, WorkItemSeverity } from '../work-items/work-item.types';
import { ServiceRecord } from '../services/service-registry.types';
import { IntegrationTransitionResult } from './integration.types';

export const MONITORING_EVENT_TYPES = ['alert_fired', 'alert_resolved'] as const;
export type MonitoringEventType = (typeof MONITORING_EVENT_TYPES)[number];

/**
 * Link type used between a monitoring alert artifact and the Incident it produced.
 *
 * Alerts are provider-owned observability records, so they are stored as
 * `external_artifacts` (Spec §3.3 "Link" and the §9 system-of-record decision that
 * monitoring tools stay authoritative for their own data) and never as WorkItems.
 */
export const ALERT_LINK_TYPE = 'detected_by' as const;

export interface MonitoringAlertPayload {
  /** Provider-side alert or monitor event identifier. */
  id: string;
  /** Stable grouping key for the same underlying issue; falls back to `id`. */
  dedupe_key?: string;
  title: string;
  description?: string;
  /** Provider severity vocabulary; mapped onto SEV1–SEV4. */
  severity?: string;
  status?: string;
  url?: string;
  runbook_url?: string;
  monitor_name?: string;
  triggered_at?: string;
  resolved_at?: string;
  /** Affected Service identifier; matched against the tenant Service registry. */
  service?: string;
  service_key?: string;
  host?: string;
  environment?: string;
  labels?: Record<string, unknown>;
}

export interface MonitoringWebhookDto {
  provider?: string;
  delivery_id?: string;
  event_type: MonitoringEventType;
  alert: MonitoringAlertPayload;
}

export interface MonitoringSettings {
  org_id: string;
  /** Least severe level that may open an Incident; SEV4 alerts are recorded but suppressed at SEV3. */
  min_severity: WorkItemSeverity;
  dedupe_window_minutes: number;
  default_team_id: string | null;
  /** Role the monitoring integration presents to the workflow engine; guards still run. */
  automation_actor_role: string;
  auto_register_services: boolean;
}

export interface UpdateMonitoringSettingsDto {
  min_severity?: string;
  dedupe_window_minutes?: number;
  default_team_id?: string | null;
  automation_actor_role?: string;
  auto_register_services?: boolean;
}

export interface SeverityMapping {
  provider_value: string | null;
  mapped: WorkItemSeverity;
  priority: WorkItemPriority;
  /** False when the provider value was unknown and the documented default was applied. */
  matched: boolean;
}

export type MonitoringOutcome =
  | 'incident_created'
  | 'incident_deduplicated'
  | 'mitigation_proposed'
  | 'suppressed_below_threshold'
  | 'no_linked_incident';

export interface MonitoringIncidentSummary {
  id: string;
  key: string;
  status: string;
  severity: WorkItemSeverity | null;
  priority: WorkItemPriority;
  created: boolean;
}

export interface MonitoringDeliveryResult {
  delivery_id: string;
  provider: string;
  event_type: MonitoringEventType;
  duplicate: boolean;
  outcome: MonitoringOutcome;
  reason?: string;
  dedupe_key: string;
  occurrences: number;
  severity: SeverityMapping;
  alert_artifact_id: string;
  incident: MonitoringIncidentSummary | null;
  affected_services: Array<{ service_key: string; name: string; source: ServiceRecord['source'] }>;
  transitions: IntegrationTransitionResult[];
}

export interface MonitoringAlertEvidence {
  artifact_id: string;
  provider: string;
  dedupe_key: string;
  title: string;
  status: string | null;
  url: string | null;
  severity: WorkItemSeverity | null;
  provider_severity: string | null;
  occurrences: number;
  first_seen: string | null;
  last_seen: string | null;
  resolved_at: string | null;
  monitor_name: string | null;
  runbook_url: string | null;
  linked_at: string;
}
