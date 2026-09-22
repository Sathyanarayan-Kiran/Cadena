import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import { ServiceRegistryService } from '../services/service-registry.service';
import { ServiceRecord } from '../services/service-registry.types';
import { WorkItemService } from '../work-items/work-item.service';
import { WorkflowService } from '../workflow/workflow.service';
import {
  VALID_SEVERITIES,
  WorkItemPriority,
  WorkItemSeverity,
} from '../work-items/work-item.types';
import { IntegrationSupport, IntegrationWorkItemRef } from './integration-support';
import { InvalidIntegrationPayloadError } from './integration.service';
import { appendAuditIntegrityEntry } from '../audit/audit-integrity';
import { ExternalArtifact, IntegrationTransitionResult } from './integration.types';
import {
  ALERT_LINK_TYPE,
  MONITORING_EVENT_TYPES,
  MonitoringAlertEvidence,
  MonitoringAlertPayload,
  MonitoringDeliveryResult,
  MonitoringEventType,
  MonitoringIncidentSummary,
  MonitoringOutcome,
  MonitoringSettings,
  MonitoringWebhookDto,
  SeverityMapping,
  UpdateMonitoringSettingsDto,
} from './monitoring.types';

/**
 * Provider severity vocabularies mapped onto the canonical SEV1–SEV4 scale (Spec §3.1).
 * Anything unrecognized falls back to `DEFAULT_SEVERITY` and is reported as `matched: false`
 * so an operator can see that a mapping is missing rather than silently losing the alert.
 */
const SEVERITY_ALIASES: Record<string, WorkItemSeverity> = {
  sev1: 'SEV1', s1: 'SEV1', p1: 'SEV1', '1': 'SEV1',
  critical: 'SEV1', crit: 'SEV1', fatal: 'SEV1', emergency: 'SEV1', disaster: 'SEV1', page: 'SEV1',
  sev2: 'SEV2', s2: 'SEV2', p2: 'SEV2', '2': 'SEV2',
  error: 'SEV2', high: 'SEV2', major: 'SEV2', severe: 'SEV2', alert: 'SEV2',
  sev3: 'SEV3', s3: 'SEV3', p3: 'SEV3', '3': 'SEV3',
  warning: 'SEV3', warn: 'SEV3', medium: 'SEV3', moderate: 'SEV3', degraded: 'SEV3',
  sev4: 'SEV4', s4: 'SEV4', p4: 'SEV4', '4': 'SEV4',
  info: 'SEV4', informational: 'SEV4', low: 'SEV4', minor: 'SEV4', notice: 'SEV4', ok: 'SEV4',
};

const DEFAULT_SEVERITY: WorkItemSeverity = 'SEV3';

const SEVERITY_PRIORITY: Record<WorkItemSeverity, WorkItemPriority> = {
  SEV1: 'P0',
  SEV2: 'P1',
  SEV3: 'P2',
  SEV4: 'P3',
};

/** The Incident state automation may propose. Confirmation past this point stays human. */
const PROPOSED_STATE = 'Mitigated';

/**
 * States the monitoring integration must never drive an Incident into, even if the tenant's
 * workflow would allow the edge. US7.3 requires that automation proposes mitigation and
 * leaves resolution and closure to a person.
 */
const AUTOMATION_FORBIDDEN_STATES = new Set(['Resolved', 'Closed', 'Post-incident Review']);

/** Incident states that mean "this incident is finished"; a later alert opens a new one. */
const INCIDENT_SETTLED_STATES = new Set(['Mitigated', 'Resolved', 'Closed', 'Post-incident Review']);

/** Upper bound on how many consecutive transitions automation may chain in one delivery. */
const MAX_AUTOMATION_PATH_LENGTH = 3;

const DEFAULT_SETTINGS: Omit<MonitoringSettings, 'org_id'> = {
  min_severity: 'SEV3',
  dedupe_window_minutes: 60,
  default_team_id: null,
  automation_actor_role: 'on_call',
  auto_register_services: true,
};

function severityRank(severity: WorkItemSeverity): number {
  return VALID_SEVERITIES.indexOf(severity);
}

@Injectable()
export class MonitoringIntegrationService {
  private dbService = DatabaseService.getInstance();
  private support = new IntegrationSupport();
  private eventBus = InProcessEventBus.getInstance();
  private workItemService = new WorkItemService();
  private workflowService = new WorkflowService();
  private registry = new ServiceRegistryService();

  // ---------------------------------------------------------------------------------------
  // Tenant configuration
  // ---------------------------------------------------------------------------------------

  public async getSettings(orgId: string): Promise<MonitoringSettings> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM monitoring_settings WHERE org_id = $1`,
      [orgId],
    );
    if (result.rows.length === 0) return { org_id: orgId, ...DEFAULT_SETTINGS };
    const row = result.rows[0];
    return {
      org_id: row.org_id,
      min_severity: row.min_severity as WorkItemSeverity,
      dedupe_window_minutes: Number(row.dedupe_window_minutes),
      default_team_id: row.default_team_id,
      automation_actor_role: row.automation_actor_role,
      auto_register_services: row.auto_register_services !== false,
    };
  }

  public async updateSettings(orgId: string, dto: UpdateMonitoringSettingsDto): Promise<MonitoringSettings> {
    await this.dbService.initialize();
    const current = await this.getSettings(orgId);

    let minSeverity = current.min_severity;
    if (dto.min_severity !== undefined) {
      const candidate = String(dto.min_severity).toUpperCase() as WorkItemSeverity;
      if (!VALID_SEVERITIES.includes(candidate)) {
        throw new InvalidIntegrationPayloadError(
          `min_severity must be one of: ${VALID_SEVERITIES.join(', ')}`,
        );
      }
      minSeverity = candidate;
    }

    let dedupeWindow = current.dedupe_window_minutes;
    if (dto.dedupe_window_minutes !== undefined) {
      if (!Number.isInteger(dto.dedupe_window_minutes) || dto.dedupe_window_minutes < 0) {
        throw new InvalidIntegrationPayloadError(
          'dedupe_window_minutes must be a whole number of minutes that is zero or greater',
        );
      }
      dedupeWindow = dto.dedupe_window_minutes;
    }

    const actorRole = dto.automation_actor_role?.trim() || current.automation_actor_role;
    if (!actorRole) {
      throw new InvalidIntegrationPayloadError('automation_actor_role cannot be empty');
    }

    const defaultTeamId = dto.default_team_id !== undefined ? dto.default_team_id : current.default_team_id;
    const autoRegister = dto.auto_register_services !== undefined
      ? Boolean(dto.auto_register_services)
      : current.auto_register_services;

    await this.dbService.db.query(
      `INSERT INTO monitoring_settings
       (org_id, min_severity, dedupe_window_minutes, default_team_id, automation_actor_role, auto_register_services, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id) DO UPDATE SET
         min_severity = EXCLUDED.min_severity,
         dedupe_window_minutes = EXCLUDED.dedupe_window_minutes,
         default_team_id = EXCLUDED.default_team_id,
         automation_actor_role = EXCLUDED.automation_actor_role,
         auto_register_services = EXCLUDED.auto_register_services,
         updated_at = CURRENT_TIMESTAMP`,
      [orgId, minSeverity, dedupeWindow, defaultTeamId, actorRole, autoRegister],
    );

    return this.getSettings(orgId);
  }

  // ---------------------------------------------------------------------------------------
  // Webhook ingestion
  // ---------------------------------------------------------------------------------------

  public async processMonitoringWebhook(
    orgId: string,
    dto: MonitoringWebhookDto,
    deliveryId: string,
  ): Promise<MonitoringDeliveryResult> {
    await this.dbService.initialize();
    this.validateWebhook(dto, deliveryId);

    const provider = (dto.provider || 'monitoring').toLowerCase();
    const existing = await this.support.findDelivery<MonitoringDeliveryResult>(orgId, provider, deliveryId);
    if (existing) {
      if (existing.result) return { ...existing.result, duplicate: true };
      throw new InvalidIntegrationPayloadError(
        `Delivery '${deliveryId}' is already ${existing.status}`,
      );
    }

    const deliveryRecordId = await this.support.beginDelivery(
      orgId, provider, deliveryId, dto.event_type, dto,
    );

    try {
      return await this.processQueuedMonitoringWebhook(
        deliveryRecordId, orgId, provider, deliveryId, dto,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown monitoring integration error';
      await this.support.failDelivery(deliveryRecordId, message);
      throw error;
    }
  }

  /** Processes a delivery already persisted by the HTTP 202 ingestion queue. */
  public async processQueuedMonitoringWebhook(
    deliveryRecordId: string,
    orgId: string,
    provider: string,
    deliveryId: string,
    dto: MonitoringWebhookDto,
  ): Promise<MonitoringDeliveryResult> {
    const result = dto.event_type === 'alert_fired'
      ? await this.handleAlertFired(orgId, provider, deliveryId, dto.alert)
      : await this.handleAlertResolved(orgId, provider, deliveryId, dto.alert);

    await this.support.completeDelivery(deliveryRecordId, result);
    await this.eventBus.publish(
      'MonitoringAlertReceived',
      result.incident?.id || result.alert_artifact_id,
      { type: 'integration', id: provider },
      { org_id: orgId, delivery_id: deliveryId, event_type: dto.event_type, result },
    );
    return result;
  }

  public async getDelivery(orgId: string, provider: string, deliveryId: string): Promise<any | null> {
    await this.dbService.initialize();
    return this.support.getDeliveryRecord(orgId, provider, deliveryId);
  }

  /** Alert evidence for the Incident UI, including occurrence counts and affected services. */
  public async listAlertEvidence(orgId: string, workItemId: string): Promise<{
    work_item_id: string;
    alerts: MonitoringAlertEvidence[];
    affected_services: ServiceRecord[];
  }> {
    await this.dbService.initialize();
    const item = await this.dbService.db.query<any>(
      `SELECT id FROM work_items WHERE id = $1 AND org_id = $2`,
      [workItemId, orgId],
    );
    if (item.rows.length === 0) {
      throw new InvalidIntegrationPayloadError(`Work item '${workItemId}' not found`);
    }

    const result = await this.dbService.db.query<any>(
      `SELECT artifact.*, link.created_at AS linked_at
       FROM external_artifact_links link
       JOIN external_artifacts artifact ON artifact.id = link.artifact_id
       WHERE link.work_item_id = $1
         AND link.link_type = $2
         AND artifact.artifact_type = 'alert'
         AND artifact.org_id = $3
       ORDER BY link.created_at DESC`,
      [workItemId, ALERT_LINK_TYPE, orgId],
    );

    const alerts: MonitoringAlertEvidence[] = result.rows.map((row) => {
      const artifact = this.support.mapArtifact(row);
      const payload = artifact.payload as Record<string, any>;
      return {
        artifact_id: artifact.id,
        provider: artifact.provider,
        dedupe_key: artifact.external_id,
        title: artifact.title,
        status: artifact.status ?? null,
        url: artifact.url ?? null,
        severity: (payload.mapped_severity as WorkItemSeverity) ?? null,
        provider_severity: (payload.provider_severity as string) ?? null,
        occurrences: Number(payload.occurrences || 1),
        first_seen: (payload.first_seen as string) ?? null,
        last_seen: (payload.last_seen as string) ?? null,
        resolved_at: (payload.resolved_at as string) ?? null,
        monitor_name: (payload.monitor_name as string) ?? null,
        runbook_url: (payload.runbook_url as string) ?? null,
        linked_at: this.support.toIso(row.linked_at),
      };
    });

    const services = await this.registry.listServicesForWorkItem(orgId, workItemId);
    return {
      work_item_id: workItemId,
      alerts,
      affected_services: services.map((entry) => entry.service),
    };
  }

  // ---------------------------------------------------------------------------------------
  // Alert fired
  // ---------------------------------------------------------------------------------------

  private async handleAlertFired(
    orgId: string,
    provider: string,
    deliveryId: string,
    alert: MonitoringAlertPayload,
  ): Promise<MonitoringDeliveryResult> {
    const settings = await this.getSettings(orgId);
    const severity = this.mapSeverity(alert.severity);
    const dedupeKey = this.resolveDedupeKey(alert);
    const alertTime = this.parseTimestamp(alert.triggered_at) || new Date();

    const priorArtifact = await this.support.findArtifact(orgId, provider, 'alert', dedupeKey);
    const priorPayload = (priorArtifact?.payload || {}) as Record<string, any>;
    const occurrences = Number(priorPayload.occurrences || 0) + 1;
    const firstSeen = (priorPayload.first_seen as string) || alertTime.toISOString();

    const existingIncident = await this.findDedupeTarget(orgId, settings, priorPayload, alertTime);

    // Below-threshold alerts are still recorded as evidence; they simply do not open an
    // Incident. An alert that matches an already-open Incident always updates it, because
    // suppressing a follow-up occurrence would lose the recurrence signal.
    const belowThreshold = severityRank(severity.mapped) > severityRank(settings.min_severity);
    if (belowThreshold && !existingIncident) {
      const artifact = await this.writeAlertArtifact(orgId, provider, deliveryId, alert, {
        dedupeKey, severity, status: 'suppressed', occurrences, firstSeen,
        lastSeen: alertTime.toISOString(), resolvedAt: null,
        currentIncidentId: null, currentIncidentKey: null,
      });
      return this.buildResult({
        deliveryId, provider, eventType: 'alert_fired',
        outcome: 'suppressed_below_threshold',
        reason: `Alert severity ${severity.mapped} is below the configured ${settings.min_severity} threshold for this tenant`,
        dedupeKey, occurrences, severity, artifact, incident: null, services: [], transitions: [],
      });
    }

    const service = await this.resolveOrRegisterService(orgId, settings, alert);

    if (existingIncident) {
      const artifact = await this.writeAlertArtifact(orgId, provider, deliveryId, alert, {
        dedupeKey, severity, status: 'firing', occurrences, firstSeen,
        lastSeen: alertTime.toISOString(), resolvedAt: null,
        currentIncidentId: existingIncident.id, currentIncidentKey: existingIncident.key,
      });
      await this.support.linkArtifact(artifact.id, existingIncident.id, ALERT_LINK_TYPE);
      if (service) {
        await this.registry.linkWorkItemToService(orgId, existingIncident.id, service.id, `monitoring:${provider}`);
      }

      const escalated = await this.escalateSeverity(orgId, existingIncident.id, severity, provider);
      await this.eventBus.publish(
        'MonitoringAlertDeduplicated',
        existingIncident.id,
        { type: 'integration', id: `monitoring:${provider}` },
        {
          org_id: orgId,
          dedupe_key: dedupeKey,
          occurrences,
          work_item_key: existingIncident.key,
          dedupe_window_minutes: settings.dedupe_window_minutes,
          severity_escalated_to: escalated,
        },
      );

      return this.buildResult({
        deliveryId, provider, eventType: 'alert_fired',
        outcome: 'incident_deduplicated',
        reason: `Alert recurred within the ${settings.dedupe_window_minutes}-minute dedupe window for ${existingIncident.key}`,
        dedupeKey, occurrences, severity, artifact,
        incident: {
          id: existingIncident.id,
          key: existingIncident.key,
          status: existingIncident.status,
          severity: escalated || (existingIncident.severity as WorkItemSeverity | null),
          priority: SEVERITY_PRIORITY[escalated || severity.mapped],
          created: false,
        },
        services: service ? [service] : [],
        transitions: [],
      });
    }

    const teamId = service?.owner_team_id || settings.default_team_id;
    if (!teamId) {
      throw new InvalidIntegrationPayloadError(
        'No owning team could be resolved for this alert. Register the affected service with an '
        + 'owner_team_id via POST /services, or set default_team_id via POST /integrations/monitoring/settings.',
      );
    }

    const incident = await this.workItemService.createWorkItem(
      {
        type: 'incident',
        title: alert.title.trim(),
        description: alert.description?.trim()
          || `Auto-created from ${provider} alert '${alert.monitor_name || alert.id}'.`,
        priority: severity.priority,
        severity: severity.mapped,
        team_id: teamId,
        org_id: orgId,
        tags: ['auto-created', `provider:${provider}`],
        custom_fields: {
          alert_source: provider,
          alert_dedupe_key: dedupeKey,
          alert_external_id: alert.id,
          monitor_name: alert.monitor_name || null,
          alert_url: alert.url || null,
          runbook_url: alert.runbook_url || null,
          environment: alert.environment || service?.environment || null,
          provider_severity: severity.provider_value,
          detected_at: alertTime.toISOString(),
        },
      },
      `monitoring:${provider}`,
    );

    const artifact = await this.writeAlertArtifact(orgId, provider, deliveryId, alert, {
      dedupeKey, severity, status: 'firing', occurrences, firstSeen,
      lastSeen: alertTime.toISOString(), resolvedAt: null,
      currentIncidentId: incident.id, currentIncidentKey: incident.key,
    });
    await this.support.linkArtifact(artifact.id, incident.id, ALERT_LINK_TYPE);
    if (service) {
      await this.registry.linkWorkItemToService(orgId, incident.id, service.id, `monitoring:${provider}`);
    }

    await this.eventBus.publish(
      'IncidentAutoCreated',
      incident.id,
      { type: 'integration', id: `monitoring:${provider}` },
      {
        org_id: orgId,
        work_item_key: incident.key,
        status: incident.status,
        severity: incident.severity,
        dedupe_key: dedupeKey,
        affected_service_key: service?.service_key || null,
      },
    );

    return this.buildResult({
      deliveryId, provider, eventType: 'alert_fired',
      outcome: 'incident_created',
      dedupeKey, occurrences, severity, artifact,
      incident: {
        id: incident.id,
        key: incident.key,
        status: incident.status,
        severity: incident.severity ?? null,
        priority: incident.priority,
        created: true,
      },
      services: service ? [service] : [],
      transitions: [],
    });
  }

  // ---------------------------------------------------------------------------------------
  // Alert resolved
  // ---------------------------------------------------------------------------------------

  private async handleAlertResolved(
    orgId: string,
    provider: string,
    deliveryId: string,
    alert: MonitoringAlertPayload,
  ): Promise<MonitoringDeliveryResult> {
    const settings = await this.getSettings(orgId);
    const severity = this.mapSeverity(alert.severity);
    const dedupeKey = this.resolveDedupeKey(alert);
    const resolvedAt = this.parseTimestamp(alert.resolved_at) || new Date();

    const priorArtifact = await this.support.findArtifact(orgId, provider, 'alert', dedupeKey);
    const priorPayload = (priorArtifact?.payload || {}) as Record<string, any>;
    const occurrences = Number(priorPayload.occurrences || 1);

    const artifact = await this.writeAlertArtifact(orgId, provider, deliveryId, alert, {
      dedupeKey,
      severity: priorPayload.mapped_severity
        ? { ...severity, mapped: priorPayload.mapped_severity as WorkItemSeverity }
        : severity,
      status: 'resolved',
      occurrences,
      firstSeen: (priorPayload.first_seen as string) || resolvedAt.toISOString(),
      lastSeen: (priorPayload.last_seen as string) || resolvedAt.toISOString(),
      resolvedAt: resolvedAt.toISOString(),
      currentIncidentId: (priorPayload.current_incident_id as string) || null,
      currentIncidentKey: (priorPayload.current_incident_key as string) || null,
    });

    const incidentId = priorPayload.current_incident_id as string | undefined;
    const incident = incidentId ? await this.loadIncidentRef(orgId, incidentId) : null;

    if (!incident) {
      return this.buildResult({
        deliveryId, provider, eventType: 'alert_resolved',
        outcome: 'no_linked_incident',
        reason: `No open Incident is linked to alert '${dedupeKey}' in this tenant; the resolution was recorded as evidence only`,
        dedupeKey, occurrences, severity, artifact, incident: null, services: [], transitions: [],
      });
    }

    await this.support.linkArtifact(artifact.id, incident.id, ALERT_LINK_TYPE);
    const transitions = await this.proposeMitigation(orgId, provider, settings, incident, alert, resolvedAt);
    const applied = transitions.some((transition) => transition.outcome === 'applied');
    const refreshed = await this.loadIncidentRef(orgId, incident.id);

    await this.eventBus.publish(
      'IncidentMitigationProposed',
      incident.id,
      { type: 'integration', id: `monitoring:${provider}` },
      {
        org_id: orgId,
        work_item_key: incident.key,
        dedupe_key: dedupeKey,
        from_state: incident.status,
        to_state: PROPOSED_STATE,
        applied,
        awaiting_human_confirmation: true,
        transitions,
      },
    );

    return this.buildResult({
      deliveryId, provider, eventType: 'alert_resolved',
      outcome: 'mitigation_proposed',
      reason: applied
        ? `${incident.key} moved to ${PROPOSED_STATE}; resolution and closure still require human confirmation`
        : `${incident.key} was left in ${incident.status}; the proposed move to ${PROPOSED_STATE} was not applied`,
      dedupeKey, occurrences, severity, artifact,
      incident: {
        id: incident.id,
        key: incident.key,
        status: refreshed?.status || incident.status,
        severity: (refreshed?.severity as WorkItemSeverity | null) ?? null,
        priority: SEVERITY_PRIORITY[severity.mapped],
        created: false,
      },
      services: (await this.registry.listServicesForWorkItem(orgId, incident.id)).map((entry) => entry.service),
      transitions,
    });
  }

  /**
   * Walks the Incident's own workflow definition from its current state to `Mitigated`,
   * applying each step through `WorkflowService`. Guards and required fields are evaluated
   * normally; a rejected step stops the walk and is reported as skipped. Paths that would
   * pass through a resolution or closure state are never considered.
   */
  private async proposeMitigation(
    orgId: string,
    provider: string,
    settings: MonitoringSettings,
    incident: IncidentRef,
    alert: MonitoringAlertPayload,
    resolvedAt: Date,
  ): Promise<IntegrationTransitionResult[]> {
    const actorId = `monitoring:${provider}:alert_resolved`;

    if (incident.status === PROPOSED_STATE) {
      return [this.skipped(incident, PROPOSED_STATE, `Incident is already in ${PROPOSED_STATE}`)];
    }
    if (AUTOMATION_FORBIDDEN_STATES.has(incident.status)) {
      return [this.skipped(
        incident,
        PROPOSED_STATE,
        `Incident is already in '${incident.status}'; monitoring automation does not reopen resolved work`,
      )];
    }

    const workflow = await this.workflowService.getWorkflowDefinition(incident.type, incident.workflow_version);
    const path = this.findAutomationPath(workflow?.definition?.transitions || [], incident.status, PROPOSED_STATE);
    if (!path) {
      return [this.skipped(
        incident,
        PROPOSED_STATE,
        `No automation-safe path from '${incident.status}' to '${PROPOSED_STATE}' exists in workflow `
        + `'${incident.type}' v${incident.workflow_version} within ${MAX_AUTOMATION_PATH_LENGTH} transitions`,
      )];
    }

    const summary = `Auto-proposed by ${provider} monitoring: alert '${alert.monitor_name || alert.title}' `
      + `reported resolved at ${resolvedAt.toISOString()}. Awaiting human confirmation before Resolved.`;
    const supplyable: Record<string, string> = {
      mitigation_summary: summary,
      resolution_summary: summary,
      monitoring_resolution_note: summary,
    };

    const transitions: IntegrationTransitionResult[] = [];
    let current: IntegrationWorkItemRef = {
      id: incident.id, key: incident.key, type: incident.type, status: incident.status,
    };

    for (const step of path) {
      const rule = (workflow?.definition?.transitions || []).find(
        (candidate) => candidate.from === current.status && candidate.to === step,
      );
      const required = rule?.requires_fields || [];
      const unsupported = required.filter((field) => !(field in supplyable));
      if (unsupported.length > 0) {
        transitions.push(this.skipped(
          { ...incident, status: current.status },
          step,
          `Transition requires field(s) the monitoring integration cannot supply: ${unsupported.join(', ')}`,
        ));
        break;
      }

      const fields: Record<string, unknown> = {};
      for (const field of required) fields[field] = supplyable[field];

      const result = await this.support.attemptTransition(current, orgId, step, actorId, {
        actorRole: settings.automation_actor_role,
        fields,
        skippedEventType: 'MonitoringAutoTransitionSkipped',
      });
      transitions.push(result);
      if (result.outcome === 'skipped') break;
      current = { ...current, status: step };
    }

    return transitions;
  }

  private findAutomationPath(
    transitions: Array<{ from: string; to: string }>,
    fromState: string,
    targetState: string,
  ): string[] | null {
    const queue: Array<{ state: string; path: string[] }> = [{ state: fromState, path: [] }];
    const visited = new Set<string>([fromState]);

    while (queue.length > 0) {
      const { state, path } = queue.shift()!;
      if (path.length >= MAX_AUTOMATION_PATH_LENGTH) continue;
      for (const transition of transitions) {
        if (transition.from !== state) continue;
        const next = transition.to;
        if (next !== targetState && AUTOMATION_FORBIDDEN_STATES.has(next)) continue;
        if (visited.has(next)) continue;
        const nextPath = [...path, next];
        if (next === targetState) return nextPath;
        visited.add(next);
        queue.push({ state: next, path: nextPath });
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------

  public validateWebhook(dto: MonitoringWebhookDto, deliveryId: string): void {
    if (!deliveryId?.trim()) {
      throw new InvalidIntegrationPayloadError(
        'A delivery identifier is required; send x-delivery-id, x-monitoring-delivery, or delivery_id',
      );
    }
    if (!MONITORING_EVENT_TYPES.includes(dto.event_type)) {
      throw new InvalidIntegrationPayloadError(
        `event_type must be one of: ${MONITORING_EVENT_TYPES.join(', ')}`,
      );
    }
    if (!dto.alert || typeof dto.alert !== 'object') {
      throw new InvalidIntegrationPayloadError('alert object is required');
    }
    if (!dto.alert.id?.toString().trim() && !dto.alert.dedupe_key?.trim()) {
      throw new InvalidIntegrationPayloadError('alert.id or alert.dedupe_key is required');
    }
    if (!dto.alert.title?.trim()) {
      throw new InvalidIntegrationPayloadError('alert.title is required');
    }
    for (const field of ['triggered_at', 'resolved_at'] as const) {
      const value = dto.alert[field];
      if (value && !this.parseTimestamp(value)) {
        throw new InvalidIntegrationPayloadError(`alert.${field} must be an ISO 8601 timestamp`);
      }
    }
  }

  private mapSeverity(value?: string): SeverityMapping {
    const providerValue = value?.toString().trim() || null;
    const mapped = providerValue ? SEVERITY_ALIASES[providerValue.toLowerCase()] : undefined;
    const severity = mapped || DEFAULT_SEVERITY;
    return {
      provider_value: providerValue,
      mapped: severity,
      priority: SEVERITY_PRIORITY[severity],
      matched: Boolean(mapped),
    };
  }

  private resolveDedupeKey(alert: MonitoringAlertPayload): string {
    return (alert.dedupe_key?.trim() || alert.id?.toString().trim() || '').toLowerCase();
  }

  /**
   * Returns the Incident a repeat alert should update, or null when a new Incident is due.
   *
   * The window is rolling: it is measured from the previous occurrence of the same dedupe key
   * to this alert's own timestamp, so a steadily flapping alert keeps one Incident. An Incident
   * that has already reached a settled state always yields a new Incident, whatever the window.
   */
  private async findDedupeTarget(
    orgId: string,
    settings: MonitoringSettings,
    priorPayload: Record<string, any>,
    alertTime: Date,
  ): Promise<IncidentRef | null> {
    const incidentId = priorPayload.current_incident_id as string | undefined;
    if (!incidentId) return null;

    const lastSeen = this.parseTimestamp(priorPayload.last_seen as string | undefined);
    if (!lastSeen) return null;

    const elapsedMinutes = (alertTime.getTime() - lastSeen.getTime()) / 60000;
    if (elapsedMinutes > settings.dedupe_window_minutes) return null;

    const incident = await this.loadIncidentRef(orgId, incidentId);
    if (!incident) return null;
    if (INCIDENT_SETTLED_STATES.has(incident.status)) return null;
    return incident;
  }

  private async resolveOrRegisterService(
    orgId: string,
    settings: MonitoringSettings,
    alert: MonitoringAlertPayload,
  ): Promise<ServiceRecord | null> {
    const labels = (alert.labels || {}) as Record<string, unknown>;
    const candidates = [
      alert.service_key,
      alert.service,
      typeof labels.service === 'string' ? labels.service : undefined,
      alert.host,
      typeof labels.host === 'string' ? labels.host : undefined,
    ];

    const matched = await this.registry.resolveService(orgId, candidates);
    if (matched) return matched;

    const identifier = candidates.find((candidate) => candidate?.trim());
    if (!identifier || !settings.auto_register_services) return null;

    // No registry entry matched. Recording a discovered stub keeps the `affects` edge
    // intact for impact analysis and marks the row for Epic 11 CMDB reconciliation.
    return this.registry.registerService(orgId, {
      name: identifier,
      description: 'Discovered from a monitoring alert; pending CMDB reconciliation.',
      environment: alert.environment || null,
      source: 'monitoring_discovery',
      owner_team_id: settings.default_team_id,
      aliases: candidates.filter((candidate): candidate is string => Boolean(candidate?.trim())),
    });
  }

  private async writeAlertArtifact(
    orgId: string,
    provider: string,
    deliveryId: string,
    alert: MonitoringAlertPayload,
    state: {
      dedupeKey: string;
      severity: SeverityMapping;
      status: string;
      occurrences: number;
      firstSeen: string;
      lastSeen: string;
      resolvedAt: string | null;
      currentIncidentId: string | null;
      currentIncidentKey: string | null;
    },
  ): Promise<ExternalArtifact> {
    return this.support.upsertArtifact(orgId, provider, 'alert', state.dedupeKey, {
      title: alert.title.trim(),
      url: alert.url,
      status: state.status,
      payload: {
        dedupe_key: state.dedupeKey,
        alert_external_id: alert.id,
        provider_severity: state.severity.provider_value,
        mapped_severity: state.severity.mapped,
        severity_mapping_matched: state.severity.matched,
        monitor_name: alert.monitor_name || null,
        description: alert.description || null,
        runbook_url: alert.runbook_url || null,
        environment: alert.environment || null,
        service_hint: alert.service_key || alert.service || alert.host || null,
        labels: alert.labels || {},
        occurrences: state.occurrences,
        first_seen: state.firstSeen,
        last_seen: state.lastSeen,
        resolved_at: state.resolvedAt,
        current_incident_id: state.currentIncidentId,
        current_incident_key: state.currentIncidentKey,
        last_delivery_id: deliveryId,
      },
    });
  }

  /** Raises an open Incident's severity when a recurrence is worse than what was recorded. */
  private async escalateSeverity(
    orgId: string,
    incidentId: string,
    severity: SeverityMapping,
    provider: string,
  ): Promise<WorkItemSeverity | null> {
    const current = await this.dbService.db.query<any>(
      `SELECT severity, priority, item_key, origin FROM work_items WHERE id = $1 AND org_id = $2`,
      [incidentId, orgId],
    );
    if (current.rows.length === 0) return null;
    // Priority and severity of a twin-backed incident belong to its source (e.g. ServiceNow).
    if (current.rows[0].origin === 'connector') return null;

    const existing = current.rows[0].severity as WorkItemSeverity | null;
    if (existing && severityRank(severity.mapped) >= severityRank(existing)) return null;

    const now = new Date().toISOString();
    const auditId = randomUUID();
    const actorId = `monitoring:${provider}`;
    const auditPayload = {
      from_severity: existing,
      to_severity: severity.mapped,
      from_priority: current.rows[0].priority,
      to_priority: severity.priority,
      before: { severity: existing, priority: current.rows[0].priority },
      after: { severity: severity.mapped, priority: severity.priority },
    };
    await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE work_items SET severity = $1, priority = $2, updated_at = $3 WHERE id = $4 AND org_id = $5`,
        [severity.mapped, severity.priority, now, incidentId, orgId],
      );
      await tx.query(
        `INSERT INTO audit_events (id, event_type, work_item_id, actor_type, actor_id, payload, timestamp)
         VALUES ($1, 'IncidentSeverityEscalated', $2, 'integration', $3, $4, $5)`,
        [auditId, incidentId, actorId, JSON.stringify(auditPayload), now],
      );
      await appendAuditIntegrityEntry(tx, {
        source: 'audit_events',
        event_id: auditId,
        org_id: orgId,
        work_item_id: incidentId,
        event_type: 'IncidentSeverityEscalated',
        actor_type: 'integration',
        actor_id: actorId,
        payload: auditPayload,
        occurred_at: now,
      });
    });
    return severity.mapped;
  }

  private async loadIncidentRef(orgId: string, incidentId: string): Promise<IncidentRef | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT id, item_key, type, status, severity, workflow_version
       FROM work_items WHERE id = $1 AND org_id = $2`,
      [incidentId, orgId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      key: row.item_key,
      type: row.type,
      status: row.status,
      severity: row.severity,
      workflow_version: row.workflow_version,
    };
  }

  private skipped(incident: IncidentRef, targetState: string, reason: string): IntegrationTransitionResult {
    return {
      work_item_id: incident.id,
      work_item_key: incident.key,
      from_state: incident.status,
      to_state: targetState,
      outcome: 'skipped',
      reason,
    };
  }

  private parseTimestamp(value?: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private buildResult(input: {
    deliveryId: string;
    provider: string;
    eventType: MonitoringEventType;
    outcome: MonitoringOutcome;
    reason?: string;
    dedupeKey: string;
    occurrences: number;
    severity: SeverityMapping;
    artifact: ExternalArtifact;
    incident: MonitoringIncidentSummary | null;
    services: ServiceRecord[];
    transitions: IntegrationTransitionResult[];
  }): MonitoringDeliveryResult {
    return {
      delivery_id: input.deliveryId,
      provider: input.provider,
      event_type: input.eventType,
      duplicate: false,
      outcome: input.outcome,
      reason: input.reason,
      dedupe_key: input.dedupeKey,
      occurrences: input.occurrences,
      severity: input.severity,
      alert_artifact_id: input.artifact.id,
      incident: input.incident,
      affected_services: input.services.map((service) => ({
        service_key: service.service_key,
        name: service.name,
        source: service.source,
      })),
      transitions: input.transitions,
    };
  }
}

interface IncidentRef {
  id: string;
  key: string;
  type: string;
  status: string;
  severity: string | null;
  workflow_version: number;
}
