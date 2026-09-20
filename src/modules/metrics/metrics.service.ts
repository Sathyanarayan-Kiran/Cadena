import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface MetricsWindow {
  from: string;
  to: string;
  days: number;
}

export interface DeploymentFrequency {
  total: number;
  per_week: number;
  environments: Record<string, number>;
}

export interface DurationStat {
  count: number;
  median_hours: number | null;
  p90_hours: number | null;
  average_hours: number | null;
}

export interface ChangeFailureRate {
  deployments: number;
  failed_deployments: number;
  rate: number | null;
  /** Deployment/incident pairs behind the rate, so the number can be audited. */
  failures: Array<{ deployment: string; release_key: string | null; incident_key: string; severity: string | null }>;
}

export interface FlowMetrics {
  window: MetricsWindow;
  dora: {
    deployment_frequency: DeploymentFrequency;
    lead_time_for_changes: DurationStat;
    change_failure_rate: ChangeFailureRate;
    time_to_restore_service: DurationStat;
  };
  itil: {
    incidents_opened: number;
    incidents_resolved: number;
    by_severity: Record<string, number>;
    auto_created: number;
    sla_breaches: number;
    reopened: number;
  };
  coverage: {
    deployments_with_commit_evidence: number;
    incidents_with_resolution_history: number;
    note: string;
  };
}

const SUCCESSFUL_DEPLOYMENT_STATUSES = ['success', 'succeeded', 'deployed'];
const RESOLVED_STATES = ['Resolved', 'Closed'];

function hours(ms: number): number {
  return Math.round((ms / 3_600_000) * 100) / 100;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function stat(durationsMs: number[]): DurationStat {
  if (!durationsMs.length) {
    return { count: 0, median_hours: null, p90_hours: null, average_hours: null };
  }
  const median = percentile(durationsMs, 0.5);
  const p90 = percentile(durationsMs, 0.9);
  const average = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length;
  return {
    count: durationsMs.length,
    median_hours: median === null ? null : hours(median),
    p90_hours: p90 === null ? null : hours(p90),
    average_hours: hours(average),
  };
}

/**
 * US9.4 — DORA and ITIL metrics computed from recorded history, never hand-entered.
 *
 * Every figure here is derived from artefacts the platform already captures:
 *   - deployment frequency from Epic 6 deployment artefacts
 *   - lead time from the earliest commit linked to what a deployment shipped
 *   - change failure rate from `Incident caused_by Release`, the Epic 4 traceability edge
 *   - time to restore from the Incident's own state-change history
 *
 * Change failure rate is the one that justifies the traceability graph: in a two-tool
 * world it is a manual tagging exercise, and here it falls out of an edge that already
 * exists. The rate ships with the deployment/incident pairs behind it so it can be audited
 * rather than taken on trust.
 */
@Injectable()
export class MetricsService {
  private dbService = DatabaseService.getInstance();

  public async getFlowMetrics(orgId: string, fromISO?: string, toISO?: string): Promise<FlowMetrics> {
    await this.dbService.initialize();

    const to = toISO ? new Date(toISO) : new Date();
    const from = fromISO ? new Date(fromISO) : new Date(to.getTime() - 30 * 86_400_000);
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
    const window: MetricsWindow = { from: from.toISOString(), to: to.toISOString(), days };

    const deployments = await this.loadDeployments(orgId, from, to);
    const leadTimes = await this.leadTimes(orgId, deployments);
    const failure = await this.changeFailureRate(orgId, deployments);
    const restore = await this.timeToRestore(orgId, from, to);
    const itil = await this.itilCounts(orgId, from, to);

    const environments: Record<string, number> = {};
    for (const deployment of deployments) {
      const env = deployment.environment || 'unspecified';
      environments[env] = (environments[env] || 0) + 1;
    }

    return {
      window,
      dora: {
        deployment_frequency: {
          total: deployments.length,
          per_week: Math.round((deployments.length / days) * 7 * 100) / 100,
          environments,
        },
        lead_time_for_changes: leadTimes.stat,
        change_failure_rate: failure,
        time_to_restore_service: restore.stat,
      },
      itil,
      coverage: {
        deployments_with_commit_evidence: leadTimes.covered,
        incidents_with_resolution_history: restore.stat.count,
        note: 'Lead time covers only deployments whose shipped work items also carry a linked commit; '
          + 'time to restore covers only incidents with a recorded transition into a resolved state.',
      },
    };
  }

  private async loadDeployments(orgId: string, from: Date, to: Date) {
    const result = await this.dbService.db.query<any>(
      `SELECT id, external_id, title, status, payload, created_at
       FROM external_artifacts
       WHERE org_id = $1 AND artifact_type = 'deployment'
         AND created_at >= $2 AND created_at <= $3
       ORDER BY created_at ASC`,
      [orgId, from.toISOString(), to.toISOString()],
    );
    return result.rows
      .map((row) => {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
        return {
          id: row.id,
          external_id: row.external_id,
          status: (row.status || '').toLowerCase(),
          environment: payload.environment as string | undefined,
          release_key: (payload.release_key as string | undefined) || null,
          at: new Date(typeof row.created_at === 'string' ? row.created_at : row.created_at),
        };
      })
      .filter((d) => SUCCESSFUL_DEPLOYMENT_STATUSES.includes(d.status));
  }

  /** Earliest commit linked to anything a deployment shipped, through to the deploy time. */
  private async leadTimes(orgId: string, deployments: Array<{ id: string; at: Date }>) {
    const durations: number[] = [];
    let covered = 0;

    for (const deployment of deployments) {
      const result = await this.dbService.db.query<any>(
        `SELECT MIN(commit_artifact.created_at) AS first_commit
         FROM external_artifact_links deploy_link
         JOIN external_artifact_links commit_link
           ON commit_link.work_item_id = deploy_link.work_item_id
         JOIN external_artifacts commit_artifact
           ON commit_artifact.id = commit_link.artifact_id
          AND commit_artifact.artifact_type = 'commit'
          AND commit_artifact.org_id = $2
         WHERE deploy_link.artifact_id = $1`,
        [deployment.id, orgId],
      );
      const first = result.rows?.[0]?.first_commit;
      if (!first) continue;
      const commitAt = new Date(typeof first === 'string' ? first : first);
      const delta = deployment.at.getTime() - commitAt.getTime();
      if (delta < 0) continue;
      covered += 1;
      durations.push(delta);
    }
    return { stat: stat(durations), covered };
  }

  /**
   * A deployment counts as failed when an Incident is linked by `caused_by` to a Release
   * that the deployment shipped. That edge is the Epic 4 traceability link, so the figure
   * needs no separate tagging discipline.
   */
  private async changeFailureRate(orgId: string, deployments: Array<{ id: string; external_id: string; release_key: string | null }>) {
    const failures: ChangeFailureRate['failures'] = [];
    const failed = new Set<string>();

    for (const deployment of deployments) {
      const result = await this.dbService.db.query<any>(
        `SELECT DISTINCT incident.item_key, incident.severity, release_item.item_key AS release_key
         FROM external_artifact_links deploy_link
         JOIN work_items release_item
           ON release_item.id = deploy_link.work_item_id
          AND release_item.type = 'release'
          AND release_item.org_id = $2
         JOIN work_item_links caused
           ON caused.target_id = release_item.id
          AND caused.link_type = 'caused_by'
         JOIN work_items incident
           ON incident.id = caused.source_id
          AND incident.type = 'incident'
          AND incident.org_id = $2
         WHERE deploy_link.artifact_id = $1`,
        [deployment.id, orgId],
      );

      for (const row of result.rows || []) {
        failed.add(deployment.id);
        failures.push({
          deployment: deployment.external_id,
          release_key: row.release_key || deployment.release_key,
          incident_key: row.item_key,
          severity: row.severity,
        });
      }
    }

    return {
      deployments: deployments.length,
      failed_deployments: failed.size,
      rate: deployments.length ? Math.round((failed.size / deployments.length) * 1000) / 1000 : null,
      failures,
    };
  }

  /** Incident creation through to its first transition into a resolved state. */
  private async timeToRestore(orgId: string, from: Date, to: Date) {
    const incidents = await this.dbService.db.query<any>(
      `SELECT id, created_at FROM work_items
       WHERE org_id = $1 AND type = 'incident'
         AND created_at >= $2 AND created_at <= $3`,
      [orgId, from.toISOString(), to.toISOString()],
    );

    const durations: number[] = [];
    for (const incident of incidents.rows || []) {
      const resolved = await this.dbService.db.query<any>(
        `SELECT MIN(timestamp) AS resolved_at
         FROM audit_events
         WHERE work_item_id = $1 AND event_type = 'WorkItemStateChanged'
           AND payload->>'to_state' = ANY($2)`,
        [incident.id, RESOLVED_STATES],
      );
      const at = resolved.rows?.[0]?.resolved_at;
      if (!at) continue;
      const opened = new Date(typeof incident.created_at === 'string' ? incident.created_at : incident.created_at);
      const delta = new Date(typeof at === 'string' ? at : at).getTime() - opened.getTime();
      if (delta >= 0) durations.push(delta);
    }
    return { stat: stat(durations) };
  }

  private async itilCounts(orgId: string, from: Date, to: Date): Promise<FlowMetrics['itil']> {
    const opened = await this.dbService.db.query<any>(
      `SELECT severity, status, tags FROM work_items
       WHERE org_id = $1 AND type = 'incident' AND created_at >= $2 AND created_at <= $3`,
      [orgId, from.toISOString(), to.toISOString()],
    );

    const bySeverity: Record<string, number> = {};
    let autoCreated = 0;
    let resolved = 0;
    for (const row of opened.rows || []) {
      const severity = row.severity || 'unset';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;
      if ((row.tags || []).includes('auto-created')) autoCreated += 1;
      if (RESOLVED_STATES.includes(row.status)) resolved += 1;
    }

    const breaches = await this.dbService.db.query<any>(
      `SELECT COUNT(*)::int AS n FROM domain_events
       WHERE org_id = $1 AND event_type = 'SLABreached'
         AND occurred_at >= $2 AND occurred_at <= $3`,
      [orgId, from.toISOString(), to.toISOString()],
    );

    const reopened = await this.dbService.db.query<any>(
      `SELECT COUNT(*)::int AS n FROM audit_events audit
       JOIN work_items item ON item.id = audit.work_item_id AND item.org_id = $1 AND item.type = 'incident'
       WHERE audit.event_type = 'WorkItemStateChanged'
         AND audit.payload->>'from_state' = ANY($2)
         AND audit.timestamp >= $3 AND audit.timestamp <= $4`,
      [orgId, RESOLVED_STATES, from.toISOString(), to.toISOString()],
    );

    return {
      incidents_opened: (opened.rows || []).length,
      incidents_resolved: resolved,
      by_severity: bySeverity,
      auto_created: autoCreated,
      sla_breaches: breaches.rows?.[0]?.n ?? 0,
      reopened: reopened.rows?.[0]?.n ?? 0,
    };
  }
}
