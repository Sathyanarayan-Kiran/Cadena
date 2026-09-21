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

export interface AgingDistribution {
  green: number;
  amber: number;
  red: number;
}

export interface ExecutiveMetricRow {
  total_items: number;
  governed_items: number;
  sla_compliance_percent: number | null;
  average_cycle_time_hours: number | null;
  completed_items: number;
  aging_distribution: AgingDistribution;
}

export interface ExecutiveMetrics {
  generated_at: string;
  overall: ExecutiveMetricRow;
  teams: Array<ExecutiveMetricRow & { team_id: string; team_name: string; business_unit: string }>;
  business_units: Array<ExecutiveMetricRow & { business_unit: string }>;
  coverage: {
    cycle_time_items: number;
    note: string;
  };
}

interface ExecutiveAccumulator {
  total: number;
  governed: number;
  compliant: number;
  aging: AgingDistribution;
  cycleDurations: number[];
}

const SUCCESSFUL_DEPLOYMENT_STATUSES = ['success', 'succeeded', 'deployed'];
const RESOLVED_STATES = ['Resolved', 'Closed'];
const COMPLETION_STATES: Record<string, string[]> = {
  epic: ['Done', 'Verified', 'Closed'],
  story: ['Done', 'Verified', 'Closed'],
  incident: ['Resolved', 'Closed'],
  release: ['Deployed', 'Closed'],
};

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

function emptyExecutiveAccumulator(): ExecutiveAccumulator {
  return {
    total: 0,
    governed: 0,
    compliant: 0,
    aging: { green: 0, amber: 0, red: 0 },
    cycleDurations: [],
  };
}

function addExecutiveItem(
  target: ExecutiveAccumulator,
  item: any,
  completedAt?: Date,
): void {
  target.total += 1;
  const bucket: keyof AgingDistribution = item.aging_bucket === 'amber' || item.aging_bucket === 'red'
    ? item.aging_bucket
    : 'green';
  target.aging[bucket] += 1;
  if (item.governed === true) {
    target.governed += 1;
    if (Number(item.aging_score || 0) <= 100) target.compliant += 1;
  }
  if (completedAt) {
    const createdAt = new Date(item.created_at);
    const duration = completedAt.getTime() - createdAt.getTime();
    if (duration >= 0) target.cycleDurations.push(duration);
  }
}

function finishExecutiveAccumulator(target: ExecutiveAccumulator): ExecutiveMetricRow {
  const average = target.cycleDurations.length
    ? target.cycleDurations.reduce((sum, value) => sum + value, 0) / target.cycleDurations.length
    : null;
  return {
    total_items: target.total,
    governed_items: target.governed,
    sla_compliance_percent: target.governed
      ? Math.round((target.compliant / target.governed) * 1000) / 10
      : null,
    average_cycle_time_hours: average === null ? null : hours(average),
    completed_items: target.cycleDurations.length,
    aging_distribution: { ...target.aging },
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

  /**
   * US9.2 — a current operational snapshot rolled up by team and business unit.
   *
   * SLA compliance is derived from the same persisted scores the team heatmap displays.
   * Cycle time is creation through the first recorded completion transition, so a later
   * aging refresh cannot rewrite the result by changing `updated_at`.
   */
  public async getExecutiveMetrics(orgId: string): Promise<ExecutiveMetrics> {
    await this.dbService.initialize();

    const teamsResult = await this.dbService.db.query<any>(
      `SELECT id, name, business_unit FROM teams WHERE org_id = $1 ORDER BY business_unit, name`,
      [orgId],
    );
    const itemsResult = await this.dbService.db.query<any>(
      `SELECT item.id, item.team_id, item.type, item.status, item.created_at,
              item.aging_bucket, item.aging_score,
              (policy.id IS NOT NULL) AS governed
       FROM work_items item
       LEFT JOIN sla_policies policy
         ON policy.org_id = item.org_id
        AND policy.item_type = item.type
        AND policy.state = item.status
       WHERE item.org_id = $1`,
      [orgId],
    );
    const auditResult = await this.dbService.db.query<any>(
      `SELECT audit.work_item_id, audit.payload, audit.timestamp, item.type
       FROM audit_events audit
       JOIN work_items item ON item.id = audit.work_item_id AND item.org_id = $1
       WHERE audit.event_type = 'WorkItemStateChanged'
       ORDER BY audit.timestamp ASC`,
      [orgId],
    );

    const firstCompletion = new Map<string, Date>();
    for (const row of auditResult.rows || []) {
      if (firstCompletion.has(row.work_item_id)) continue;
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      if (!(COMPLETION_STATES[row.type] || []).includes(payload.to_state)) continue;
      firstCompletion.set(row.work_item_id, new Date(row.timestamp));
    }

    const teamMeta = new Map<string, { name: string; businessUnit: string }>();
    const teamAccumulators = new Map<string, ExecutiveAccumulator>();
    const unitAccumulators = new Map<string, ExecutiveAccumulator>();
    for (const team of teamsResult.rows || []) {
      const businessUnit = team.business_unit || 'Unassigned';
      teamMeta.set(team.id, { name: team.name, businessUnit });
      teamAccumulators.set(team.id, emptyExecutiveAccumulator());
      if (!unitAccumulators.has(businessUnit)) {
        unitAccumulators.set(businessUnit, emptyExecutiveAccumulator());
      }
    }

    const overall = emptyExecutiveAccumulator();
    for (const item of itemsResult.rows || []) {
      if (!teamAccumulators.has(item.team_id)) {
        teamMeta.set(item.team_id, { name: 'Unassigned team', businessUnit: 'Unassigned' });
        teamAccumulators.set(item.team_id, emptyExecutiveAccumulator());
      }
      const meta = teamMeta.get(item.team_id)!;
      if (!unitAccumulators.has(meta.businessUnit)) {
        unitAccumulators.set(meta.businessUnit, emptyExecutiveAccumulator());
      }
      const completedAt = firstCompletion.get(item.id);
      addExecutiveItem(teamAccumulators.get(item.team_id)!, item, completedAt);
      addExecutiveItem(unitAccumulators.get(meta.businessUnit)!, item, completedAt);
      addExecutiveItem(overall, item, completedAt);
    }

    const teams = Array.from(teamAccumulators.entries()).map(([teamId, accumulator]) => {
      const meta = teamMeta.get(teamId)!;
      return {
        team_id: teamId,
        team_name: meta.name,
        business_unit: meta.businessUnit,
        ...finishExecutiveAccumulator(accumulator),
      };
    }).sort((a, b) => a.business_unit.localeCompare(b.business_unit) || a.team_name.localeCompare(b.team_name));

    const businessUnits = Array.from(unitAccumulators.entries()).map(([businessUnit, accumulator]) => ({
      business_unit: businessUnit,
      ...finishExecutiveAccumulator(accumulator),
    })).sort((a, b) => a.business_unit.localeCompare(b.business_unit));

    return {
      generated_at: new Date().toISOString(),
      overall: finishExecutiveAccumulator(overall),
      teams,
      business_units: businessUnits,
      coverage: {
        cycle_time_items: overall.cycleDurations.length,
        note: 'SLA compliance covers items whose current state has an SLA policy. Cycle time covers items with a recorded transition into a completed state.',
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
