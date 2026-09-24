import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import { FlowService } from './flow.service';
import { assessRisk, RISK_METHOD, RiskResult } from './flow-risk';

export class InvalidRiskSettingsError extends Error {}

export interface RiskSettings {
  org_id: string;
  min_sample: number;
  percentile_threshold: number;
  lookback_days: number;
  is_default: boolean;
}

export const DEFAULT_RISK_SETTINGS = { min_sample: 10, percentile_threshold: 0.9, lookback_days: 180 };

export type WaitRisk = RiskResult & {
  work_item_id: string;
  item_key: string | null;
  item_type: string;
  team_id: string;
  state: string;
  classification: 'waiting' | 'blocked';
  entered_at: string;
  threshold: number;
  at_risk: boolean;
};

export interface EvaluationSummary {
  evaluated: number;
  scored: number;
  insufficient_history: number;
  at_risk: number;
  crossings_notified: number;
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const NOT_WAITING = 'Work item is not currently in a state classified waiting or blocked, so it has no waiting risk.';

/**
 * Risk of waiting too long (US21.3).
 *
 * The evaluation compares each waiting item's current business-time wait with the distribution of completed visits
 * to the same state by the same team and item type. It never guesses: too little history gives no score. A crossing of
 * the configured percentile threshold notifies once through the existing escalation routing, and only re-arms when the
 * risk falls back below the threshold or the item enters a new waiting interval.
 */
@Injectable()
export class FlowRiskService {
  private readonly dbService = DatabaseService.getInstance();
  private readonly outbox = new EventOutboxService();
  private readonly flow = new FlowService();

  public async getSettings(orgId: string): Promise<RiskSettings> {
    await this.dbService.initialize();
    const row = (await this.dbService.db.query<any>(`SELECT * FROM flow_risk_settings WHERE org_id = $1`, [orgId])).rows[0];
    if (!row) return { org_id: orgId, ...DEFAULT_RISK_SETTINGS, is_default: true };
    return {
      org_id: orgId,
      min_sample: Number(row.min_sample),
      percentile_threshold: Number(row.percentile_threshold),
      lookback_days: Number(row.lookback_days),
      is_default: false,
    };
  }

  public async updateSettings(orgId: string, actorId: string, dto: Partial<Record<'min_sample' | 'percentile_threshold' | 'lookback_days', unknown>>): Promise<RiskSettings> {
    await this.dbService.initialize();
    const current = await this.getSettings(orgId);
    const next = { ...current };
    if (dto.min_sample !== undefined) {
      if (!Number.isInteger(dto.min_sample) || (dto.min_sample as number) < 3 || (dto.min_sample as number) > 1000) {
        throw new InvalidRiskSettingsError('min_sample must be a whole number from 3 to 1000');
      }
      next.min_sample = dto.min_sample as number;
    }
    if (dto.percentile_threshold !== undefined) {
      const value = dto.percentile_threshold;
      if (typeof value !== 'number' || !(value >= 0.5 && value <= 0.999)) {
        throw new InvalidRiskSettingsError('percentile_threshold must be a number from 0.5 to 0.999');
      }
      next.percentile_threshold = value;
    }
    if (dto.lookback_days !== undefined) {
      if (!Number.isInteger(dto.lookback_days) || (dto.lookback_days as number) < 7 || (dto.lookback_days as number) > 730) {
        throw new InvalidRiskSettingsError('lookback_days must be a whole number from 7 to 730');
      }
      next.lookback_days = dto.lookback_days as number;
    }
    if (!current.is_default
      && current.min_sample === next.min_sample
      && current.percentile_threshold === next.percentile_threshold
      && current.lookback_days === next.lookback_days) {
      return current;
    }

    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO flow_risk_settings (org_id, min_sample, percentile_threshold, lookback_days, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (org_id) DO UPDATE SET min_sample = EXCLUDED.min_sample, percentile_threshold = EXCLUDED.percentile_threshold,
           lookback_days = EXCLUDED.lookback_days, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [orgId, next.min_sample, next.percentile_threshold, next.lookback_days, actorId],
      );
      event = await this.outbox.enqueue(tx, {
        event_type: 'FlowRiskSettingsChanged',
        work_item_id: `flow-risk-settings:${orgId}`,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: {
          org_id: orgId,
          before: current.is_default ? null : { min_sample: current.min_sample, percentile_threshold: current.percentile_threshold, lookback_days: current.lookback_days },
          after: { min_sample: next.min_sample, percentile_threshold: next.percentile_threshold, lookback_days: next.lookback_days },
        },
      });
    });
    if (event) await this.outbox.dispatch(event);
    return { ...next, is_default: false };
  }

  /** The risk of one item's current wait, computed live. Never notifies. */
  public async assessItem(orgId: string, workItemId: string, now = new Date()) {
    const item = (await this.dbService.db.query<any>(
      `SELECT id, item_key, type, team_id, status FROM work_items WHERE id = $1 AND org_id = $2`, [workItemId, orgId],
    )).rows[0];
    if (!item) return null;
    const risks = await this.assessOrg(orgId, now);
    const risk = risks.risks.find((candidate) => candidate.work_item_id === workItemId);
    if (risk) return { ...risk, settings: risks.settings };
    return {
      status: 'not_waiting' as const,
      work_item_id: item.id,
      item_key: item.item_key,
      state: item.status,
      message: NOT_WAITING,
      settings: risks.settings,
    };
  }

  /** Comparable completed visits per team, item type and state, plus each state's SLA target (shared with US21.4). */
  public async waitHistory(orgId: string, now = new Date()) {
    await this.dbService.initialize();
    const settings = await this.getSettings(orgId);
    const scored = await this.flow.scoreOrg(orgId, now);
    const cutoff = now.getTime() - settings.lookback_days * DAY_MS;
    const policies = await this.dbService.db.query<any>(`SELECT item_type, state, threshold_minutes FROM sla_policies WHERE org_id = $1`, [orgId]);
    const targets = new Map<string, number>(policies.rows.map((row: any) => [`${row.item_type}|${row.state}`, Number(row.threshold_minutes)]));

    const history = new Map<string, { durations: number[]; items: Set<string> }>();
    for (const { item, intervals } of scored.items) {
      for (const interval of intervals) {
        if (interval.open || interval.ms <= 0 || Date.parse(interval.ended_at) < cutoff) continue;
        const key = `${item.team_id}|${item.type}|${interval.state}`;
        const entry = history.get(key) ?? { durations: [], items: new Set<string>() };
        entry.durations.push(interval.ms / 60_000);
        entry.items.add(item.id);
        history.set(key, entry);
      }
    }
    return { settings, scored, history, targets };
  }

  /** Risk for every item that is currently waiting or blocked. */
  public async assessOrg(orgId: string, now = new Date()) {
    const { settings, scored, history, targets } = await this.waitHistory(orgId, now);

    const risks: WaitRisk[] = [];
    for (const { item, intervals } of scored.items) {
      for (const interval of intervals) {
        if (!interval.open || (interval.classification !== 'waiting' && interval.classification !== 'blocked')) continue;
        const sample = history.get(`${item.team_id}|${item.type}|${interval.state}`) ?? { durations: [], items: new Set<string>() };
        const result = assessRisk({
          samples: sample.durations,
          sampleItems: sample.items.size,
          currentMinutes: interval.ms / 60_000,
          targetMinutes: targets.get(`${item.type}|${interval.state}`) ?? null,
          minSample: settings.min_sample,
        });
        risks.push({
          ...result,
          work_item_id: item.id,
          item_key: item.item_key,
          item_type: item.type,
          team_id: item.team_id,
          state: interval.state,
          classification: interval.classification,
          entered_at: interval.started_at,
          threshold: settings.percentile_threshold,
          at_risk: result.status === 'scored' && result.percentile >= settings.percentile_threshold,
        });
      }
    }
    return { settings, risks, truncated: scored.truncated };
  }

  /** Evaluates an org, persists each waiting item's latest risk, and notifies once per threshold crossing. */
  public async evaluateOrg(orgId: string, now = new Date()): Promise<EvaluationSummary> {
    const { settings, risks, truncated } = await this.assessOrg(orgId, now);
    const summary: EvaluationSummary = { evaluated: risks.length, scored: 0, insufficient_history: 0, at_risk: 0, crossings_notified: 0, truncated };
    const evaluatedAt = now.toISOString();

    for (const risk of risks) {
      const scored = risk.status === 'scored' ? risk : null;
      if (scored) summary.scored += 1; else summary.insufficient_history += 1;
      if (risk.at_risk) summary.at_risk += 1;
      const key = [risk.work_item_id, risk.state, risk.entered_at];

      await this.dbService.db.query(
        `INSERT INTO flow_wait_risk
           (work_item_id, state, entered_at, org_id, team_id, item_type, status, current_wait_minutes, percentile,
            probability_exceed_target, probability_basis, sample_size, sample_items, min_sample, threshold, active, evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, $16)
         ON CONFLICT (work_item_id, state, entered_at) DO UPDATE SET
           status = EXCLUDED.status, current_wait_minutes = EXCLUDED.current_wait_minutes, percentile = EXCLUDED.percentile,
           probability_exceed_target = EXCLUDED.probability_exceed_target, probability_basis = EXCLUDED.probability_basis,
           sample_size = EXCLUDED.sample_size, sample_items = EXCLUDED.sample_items, min_sample = EXCLUDED.min_sample,
           threshold = EXCLUDED.threshold, active = TRUE, evaluated_at = EXCLUDED.evaluated_at`,
        [
          ...key, orgId, risk.team_id, risk.item_type, risk.status,
          scored?.current_wait_minutes ?? null, scored?.percentile ?? null, scored?.probability_exceed_target ?? null,
          scored?.probability_basis ?? null, risk.sample_size, risk.sample_items, risk.min_sample, settings.percentile_threshold, evaluatedAt,
        ],
      );

      if (!risk.at_risk) {
        // Risk fell back below the threshold: re-arm so a later crossing notifies again.
        await this.dbService.db.query(
          `UPDATE flow_wait_risk SET above = FALSE WHERE work_item_id = $1 AND state = $2 AND entered_at = $3 AND above = TRUE`, key,
        );
        continue;
      }

      const owner = (await this.dbService.db.query<any>(`SELECT owner_id FROM work_items WHERE id = $1`, [risk.work_item_id])).rows[0]?.owner_id ?? null;
      let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
      await this.dbService.db.transaction(async (tx) => {
        const claimed = await tx.query<any>(
          `UPDATE flow_wait_risk SET above = TRUE, notified_count = notified_count + 1, last_notified_at = CURRENT_TIMESTAMP
           WHERE work_item_id = $1 AND state = $2 AND entered_at = $3 AND above = FALSE RETURNING notified_count`, key,
        );
        if (!claimed.rows.length || !scored) return;
        event = await this.outbox.enqueue(tx, {
          event_type: 'FlowWaitRiskCrossed',
          work_item_id: risk.work_item_id,
          org_id: orgId,
          actor: { type: 'system', id: 'flow-risk' },
          payload: {
            org_id: orgId,
            work_item_id: risk.work_item_id,
            team_id: risk.team_id,
            owner_id: owner,
            type: risk.item_type,
            status: risk.state,
            classification: risk.classification,
            percentile: scored.percentile,
            threshold: settings.percentile_threshold,
            current_wait_minutes: scored.current_wait_minutes,
            probability_exceed_target: scored.probability_exceed_target,
            probability_basis: scored.probability_basis,
            target_minutes: scored.target_minutes,
            sample_size: scored.sample_size,
            sample_items: scored.sample_items,
            method: RISK_METHOD,
            crossing: claimed.rows[0].notified_count,
          },
        });
      });
      if (event) {
        await this.outbox.dispatch(event);
        summary.crossings_notified += 1;
      }
    }

    // Anything not evaluated in this pass is no longer in a waiting interval.
    await this.dbService.db.query(`UPDATE flow_wait_risk SET active = FALSE WHERE org_id = $1 AND active AND evaluated_at < $2`, [orgId, evaluatedAt]);
    return summary;
  }

  /** The latest persisted evaluation of items currently waiting; cheap enough for the board and the heatmap. */
  public async listCurrent(orgId: string, filter: { atRisk?: boolean; teamId?: string } = {}) {
    await this.dbService.initialize();
    const params: unknown[] = [orgId];
    let where = 'r.org_id = $1 AND r.active';
    if (filter.atRisk) where += ' AND r.status = \'scored\' AND r.percentile >= r.threshold';
    if (filter.teamId) { params.push(filter.teamId); where += ` AND r.team_id = $${params.length}`; }
    const result = await this.dbService.db.query<any>(
      `SELECT r.*, w.item_key FROM flow_wait_risk r JOIN work_items w ON w.id = r.work_item_id
       WHERE ${where} ORDER BY r.percentile DESC NULLS LAST, r.current_wait_minutes DESC NULLS LAST`,
      params,
    );
    const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
    return result.rows.map((row: any) => ({
      work_item_id: row.work_item_id,
      item_key: row.item_key,
      team_id: row.team_id,
      item_type: row.item_type,
      state: row.state,
      entered_at: new Date(row.entered_at).toISOString(),
      status: row.status as 'scored' | 'insufficient_history',
      percentile: num(row.percentile),
      current_wait_minutes: num(row.current_wait_minutes),
      probability_exceed_target: num(row.probability_exceed_target),
      probability_basis: row.probability_basis,
      sample_size: num(row.sample_size),
      sample_items: num(row.sample_items),
      min_sample: num(row.min_sample),
      threshold: num(row.threshold),
      at_risk: row.status === 'scored' && Number(row.percentile) >= Number(row.threshold),
      notified_count: Number(row.notified_count),
      last_notified_at: row.last_notified_at ? new Date(row.last_notified_at).toISOString() : null,
      evaluated_at: new Date(row.evaluated_at).toISOString(),
    }));
  }
}

/** Runs the evaluation on a timer. `CADENA_FLOW_RISK_SCHEDULER=disabled` turns it off; tests drive `tick()` directly. */
@Injectable()
export class FlowRiskScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly dbService = DatabaseService.getInstance();

  constructor(@Inject(FlowRiskService) private readonly risk: FlowRiskService) {}

  onModuleInit(): void {
    if (process.env.CADENA_FLOW_RISK_SCHEDULER === 'disabled') return;
    const requested = Number(process.env.CADENA_FLOW_RISK_TICK_MS);
    const period = Number.isFinite(requested) && requested >= 1000 ? requested : 300_000;
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error('FlowRiskScheduler tick failed:', error));
    }, period);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Evaluates every org once. Overlapping ticks are skipped rather than queued. */
  public async tick(now = new Date()): Promise<Record<string, EvaluationSummary>> {
    const results: Record<string, EvaluationSummary> = {};
    if (this.running) return results;
    this.running = true;
    try {
      await this.dbService.initialize();
      const orgs = await this.dbService.db.query<any>(`SELECT id FROM orgs`);
      for (const org of orgs.rows) results[org.id] = await this.risk.evaluateOrg(org.id, now);
    } finally {
      this.running = false;
    }
    return results;
  }
}
