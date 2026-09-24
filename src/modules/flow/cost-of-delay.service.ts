import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import { VALID_PRIORITIES, VALID_WORK_ITEM_TYPES } from '../work-items/work-item.types';
import { COST_LABEL, CostRule, MINUTES_PER_DAY, intervalCost, matchRule, priorityScore, remainingMinutes } from './cost-of-delay';
import { FlowRiskService } from './flow-risk.service';
import { FlowNotFoundError, FlowService } from './flow.service';
import { toMinutes } from './flow-profile';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RULES = 200;
const MAX_RATE = 1_000_000_000;
const TOP_ITEMS = 50;

export class InvalidCostAssumptionError extends Error {}
export class CostVersionNotFoundError extends Error {}

export interface AssumptionSet {
  version: number;
  currency: string;
  note: string | null;
  created_by: string;
  created_at: string;
  rules: CostRule[];
}

const rulePart = (rule: CostRule) => [rule.team_id, rule.item_type, rule.priority, rule.service_id];
const scopeKey = (rule: CostRule) => JSON.stringify(rulePart(rule));
const describeRule = (rule: CostRule) => ({
  id: rule.id,
  label: rule.label,
  rate_per_day: rule.rate_per_day,
  fixed_value_at_risk: rule.fixed_value_at_risk,
  scope: { team_id: rule.team_id, item_type: rule.item_type, priority: rule.priority, service_id: rule.service_id },
});
const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

/**
 * Estimated cost of delay (US21.4).
 *
 * The organisation supplies a versioned set of assumptions: a cost rate per day (and an optional fixed value at risk)
 * for a scope of team, item type, priority and service. Waiting and blocked time from US21.1/US21.2 is priced with the
 * most specific applicable rule. An interval with no applicable rule has no cost, which is reported as such and is
 * never added up as zero. Every response names the assumption version it used and is labelled an estimate.
 */
@Injectable()
export class CostOfDelayService {
  private readonly dbService = DatabaseService.getInstance();
  private readonly outbox = new EventOutboxService();

  constructor(
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(FlowRiskService) private readonly risk: FlowRiskService,
  ) {}

  // ─── Assumptions ─────────────────────────────────────────────────────────

  /** The current set, or a specific version; null when none has ever been saved. */
  public async getSet(orgId: string, version?: number): Promise<AssumptionSet | null> {
    await this.dbService.initialize();
    const setRow = (await this.dbService.db.query<any>(
      version === undefined
        ? `SELECT * FROM cost_assumption_sets WHERE org_id = $1 ORDER BY version DESC LIMIT 1`
        : `SELECT * FROM cost_assumption_sets WHERE org_id = $1 AND version = $2`,
      version === undefined ? [orgId] : [orgId, version],
    )).rows[0];
    if (!setRow) {
      if (version !== undefined) throw new CostVersionNotFoundError(`Cost assumption version ${version} does not exist`);
      return null;
    }
    const rules = await this.dbService.db.query<any>(`SELECT * FROM cost_assumptions WHERE set_id = $1 ORDER BY id`, [setRow.id]);
    return {
      version: Number(setRow.version),
      currency: setRow.currency,
      note: setRow.note ?? null,
      created_by: setRow.created_by,
      created_at: new Date(setRow.created_at).toISOString(),
      rules: rules.rows.map((row: any) => ({
        id: row.id,
        team_id: row.team_id ?? null,
        item_type: row.item_type ?? null,
        priority: row.priority ?? null,
        service_id: row.service_id ?? null,
        rate_per_day: Number(row.rate_per_day),
        fixed_value_at_risk: row.fixed_value_at_risk === null ? null : Number(row.fixed_value_at_risk),
        label: row.label ?? null,
      })),
    };
  }

  public async history(orgId: string): Promise<Array<Omit<AssumptionSet, 'rules'> & { rule_count: number }>> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT s.*, (SELECT COUNT(*)::int FROM cost_assumptions a WHERE a.set_id = s.id) AS rule_count
       FROM cost_assumption_sets s WHERE s.org_id = $1 ORDER BY s.version DESC`,
      [orgId],
    );
    return result.rows.map((row: any) => ({
      version: Number(row.version), currency: row.currency, note: row.note ?? null, created_by: row.created_by,
      created_at: new Date(row.created_at).toISOString(), rule_count: Number(row.rule_count),
    }));
  }

  /**
   * Saves the full set of assumptions as a new version. An unchanged set creates no version. Each rule sets any of
   * team, item type, priority and service (a rule that sets none is the org-wide default) and a rate per day.
   */
  public async setAssumptions(
    orgId: string,
    actorId: string,
    dto: { currency?: unknown; note?: unknown; assumptions?: unknown },
  ): Promise<{ changed: boolean; set: AssumptionSet }> {
    await this.dbService.initialize();
    if (!Array.isArray(dto?.assumptions)) throw new InvalidCostAssumptionError('assumptions must be an array (an empty array clears every assumption)');
    if (dto.assumptions.length > MAX_RULES) throw new InvalidCostAssumptionError(`at most ${MAX_RULES} assumptions can be saved`);
    const current = await this.getSet(orgId);
    const currency = dto.currency === undefined ? current?.currency ?? 'USD' : dto.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new InvalidCostAssumptionError('currency must be a three-letter uppercase code such as USD');
    if (dto.note !== undefined && dto.note !== null && (typeof dto.note !== 'string' || dto.note.length > 500)) {
      throw new InvalidCostAssumptionError('note must be text of at most 500 characters');
    }
    const note = typeof dto.note === 'string' && dto.note.trim() ? dto.note.trim() : null;

    const teams = new Set((await this.dbService.db.query<any>(`SELECT id FROM teams WHERE org_id = $1`, [orgId])).rows.map((row: any) => row.id));
    const services = new Set((await this.dbService.db.query<any>(`SELECT id FROM services WHERE org_id = $1`, [orgId])).rows.map((row: any) => row.id));

    const rules: CostRule[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of (dto.assumptions as Array<Record<string, unknown>>).entries()) {
      const where = `assumption ${index + 1}`;
      if (typeof raw !== 'object' || raw === null) throw new InvalidCostAssumptionError(`${where} must be an object`);
      const optional = (value: unknown) => (value === undefined || value === null || value === '' ? null : value);
      const team = optional(raw.team_id);
      const type = optional(raw.item_type);
      const priority = optional(raw.priority);
      const service = optional(raw.service_id);
      if (team !== null && (typeof team !== 'string' || !UUID.test(team) || !teams.has(team))) throw new InvalidCostAssumptionError(`${where}: team_id must be a team in this organization`);
      if (type !== null && !(VALID_WORK_ITEM_TYPES as readonly string[]).includes(type as string)) throw new InvalidCostAssumptionError(`${where}: item_type must be one of ${VALID_WORK_ITEM_TYPES.join(', ')}`);
      if (priority !== null && !(VALID_PRIORITIES as readonly string[]).includes(priority as string)) throw new InvalidCostAssumptionError(`${where}: priority must be one of ${VALID_PRIORITIES.join(', ')}`);
      if (service !== null && (typeof service !== 'string' || !UUID.test(service) || !services.has(service))) throw new InvalidCostAssumptionError(`${where}: service_id must be a service in this organization`);
      const rate = raw.rate_per_day;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > MAX_RATE) throw new InvalidCostAssumptionError(`${where}: rate_per_day must be a number from 0 to ${MAX_RATE}`);
      const value = optional(raw.fixed_value_at_risk);
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12)) throw new InvalidCostAssumptionError(`${where}: fixed_value_at_risk must be a non-negative number`);
      const label = optional(raw.label);
      if (label !== null && (typeof label !== 'string' || label.length > 120)) throw new InvalidCostAssumptionError(`${where}: label must be text of at most 120 characters`);
      const rule: CostRule = {
        id: randomUUID(), team_id: team as string | null, item_type: type as string | null, priority: priority as string | null,
        service_id: service as string | null, rate_per_day: rate, fixed_value_at_risk: value as number | null, label: (label as string | null)?.trim() || null,
      };
      const key = scopeKey(rule);
      if (seen.has(key)) throw new InvalidCostAssumptionError(`${where}: another assumption already covers exactly this scope`);
      seen.add(key);
      rules.push(rule);
    }

    const canonical = (list: CostRule[]) => JSON.stringify(list.map((r) => [...rulePart(r), r.rate_per_day, r.fixed_value_at_risk, r.label]).sort());
    if (current && current.currency === currency && canonical(current.rules) === canonical(rules)) return { changed: false, set: current };

    const version = (current?.version ?? 0) + 1;
    const setId = randomUUID();
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO cost_assumption_sets (id, org_id, version, currency, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [setId, orgId, version, currency, note, actorId],
      );
      for (const rule of rules) {
        await tx.query(
          `INSERT INTO cost_assumptions (id, set_id, team_id, item_type, priority, service_id, rate_per_day, fixed_value_at_risk, label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [rule.id, setId, rule.team_id, rule.item_type, rule.priority, rule.service_id, rule.rate_per_day, rule.fixed_value_at_risk, rule.label],
        );
      }
      const before = new Map((current?.rules ?? []).map((r) => [scopeKey(r), r]));
      const after = new Map(rules.map((r) => [scopeKey(r), r]));
      event = await this.outbox.enqueue(tx, {
        event_type: 'CostAssumptionsChanged',
        work_item_id: `cost-assumptions:${orgId}`,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: {
          org_id: orgId,
          before_version: current?.version ?? null,
          after_version: version,
          currency,
          rule_count: rules.length,
          added: [...after.keys()].filter((k) => !before.has(k)).length,
          removed: [...before.keys()].filter((k) => !after.has(k)).length,
          changed: [...after.entries()].filter(([k, r]) => {
            const old = before.get(k);
            return old && (old.rate_per_day !== r.rate_per_day || old.fixed_value_at_risk !== r.fixed_value_at_risk);
          }).length,
          note,
        },
      });
    });
    if (event) await this.outbox.dispatch(event);
    return { changed: true, set: (await this.getSet(orgId, version))! };
  }

  // ─── Calculations ────────────────────────────────────────────────────────

  /** Per-interval and total estimated cost of one item's waiting time. */
  public async itemCost(orgId: string, workItemId: string, range: { from?: string; to?: string }, version?: number, now = new Date()) {
    const set = await this.getSet(orgId, version);
    const found = await this.dbService.db.query<any>(`SELECT id FROM work_items WHERE id = $1 AND org_id = $2`, [workItemId, orgId]);
    if (!found.rows.length) throw new FlowNotFoundError(`Work item '${workItemId}' not found`);
    const collected = await this.flow.collectWaits(orgId, range, { itemId: workItemId }, now);
    const services = await this.serviceLinks(orgId, [workItemId]);
    const rules = set?.rules ?? [];

    let total = 0;
    let costedMs = 0;
    let uncostedMs = 0;
    let valueAtRisk: number | null = null;
    const intervals = collected.rows.map((row) => {
      const rule = matchRule(rules, { team_id: row.team_id, item_type: row.item_type, priority: row.priority, service_ids: services.get(row.work_item_id) ?? [] });
      const cost = rule ? intervalCost(rule, row.ms, row.calendar) : null;
      if (rule && cost !== null) { total += cost; costedMs += row.ms; if (rule.fixed_value_at_risk !== null) valueAtRisk = Math.max(valueAtRisk ?? 0, rule.fixed_value_at_risk); }
      else uncostedMs += row.ms;
      return {
        state: row.state, classification: row.classification, started_at: row.started_at, ended_at: row.ended_at, open: row.open,
        minutes: toMinutes(row.ms), calendar: row.calendar, reason: row.reason,
        estimated_cost: cost, assumption: rule ? describeRule(rule) : null,
        ...(rule ? {} : { note: 'No assumption applies to this item, so no cost is given.' }),
      };
    });

    return {
      ...this.frame(set),
      work_item_id: workItemId,
      window: collected.window,
      total_estimated_cost: costedMs > 0 || intervals.some((i) => i.estimated_cost !== null) ? Math.round(total * 100) / 100 : null,
      costed_minutes: toMinutes(costedMs),
      uncosted_minutes: toMinutes(uncostedMs),
      value_at_risk: valueAtRisk,
      intervals,
    };
  }

  /** Estimated cost in a date range, ranked by cost, by state, reason, team and item. */
  public async report(
    orgId: string,
    range: { from?: string; to?: string },
    filter: { teamId?: string; itemType?: string } = {},
    version?: number,
    now = new Date(),
  ) {
    const set = await this.getSet(orgId, version);
    const collected = await this.flow.collectWaits(orgId, range, filter, now);
    const services = await this.serviceLinks(orgId, [...new Set(collected.rows.map((row) => row.work_item_id))]);
    const rules = set?.rules ?? [];

    type Bucket = { cost: number; ms: number; intervals: number };
    const bump = (map: Map<string, Bucket>, key: string, cost: number, ms: number) => {
      const entry = map.get(key) ?? { cost: 0, ms: 0, intervals: 0 };
      entry.cost += cost; entry.ms += ms; entry.intervals += 1; map.set(key, entry);
    };
    const byState = new Map<string, Bucket>();
    const byReason = new Map<string, Bucket>();
    const byTeam = new Map<string, Bucket & { name: string | null }>();
    const byItem = new Map<string, Bucket & { key: string | null; team_id: string; team_name: string | null; value: number | null }>();
    let total = 0;
    let costedMs = 0;
    let uncostedMs = 0;
    let uncostedIntervals = 0;

    for (const row of collected.rows) {
      const rule = matchRule(rules, { team_id: row.team_id, item_type: row.item_type, priority: row.priority, service_ids: services.get(row.work_item_id) ?? [] });
      if (!rule) { uncostedMs += row.ms; uncostedIntervals += 1; continue; }
      const cost = intervalCost(rule, row.ms, row.calendar);
      total += cost; costedMs += row.ms;
      bump(byState, row.state, cost, row.ms);
      bump(byReason, row.reason, cost, row.ms);
      bump(byTeam as Map<string, Bucket>, row.team_id, cost, row.ms);
      byTeam.get(row.team_id)!.name = row.team_name;
      bump(byItem as Map<string, Bucket>, row.work_item_id, cost, row.ms);
      const item = byItem.get(row.work_item_id)!;
      item.key = row.item_key; item.team_id = row.team_id; item.team_name = row.team_name;
      if (rule.fixed_value_at_risk !== null) item.value = Math.max(item.value ?? 0, rule.fixed_value_at_risk);
      else item.value = item.value ?? null;
    }

    const rank = <T extends { cost: number }>(rows: T[]) => rows.sort((a, b) => b.cost - a.cost);
    const grouped = (map: Map<string, Bucket>, name: string) => rank([...map.entries()].map(([key, v]) => ({
      [name]: key, cost: Math.round(v.cost * 100) / 100, share: share(v.cost, total), minutes: toMinutes(v.ms), intervals: v.intervals,
    }))) as Array<Record<string, any>>;
    const allItems = rank([...byItem.entries()].map(([id, v]) => ({
      work_item_id: id, item_key: v.key, team_id: v.team_id, team_name: v.team_name,
      cost: Math.round(v.cost * 100) / 100, share: share(v.cost, total), minutes: toMinutes(v.ms), intervals: v.intervals, value_at_risk: v.value,
    })));

    return {
      ...this.frame(set),
      window: collected.window,
      truncated: collected.truncated,
      total_estimated_cost: set && costedMs > 0 ? Math.round(total * 100) / 100 : null,
      costed_minutes: toMinutes(costedMs),
      uncosted_minutes: toMinutes(uncostedMs),
      uncosted_intervals: uncostedIntervals,
      by_state: grouped(byState, 'state'),
      by_reason: grouped(byReason, 'reason'),
      by_team: grouped(byTeam, 'team_id').map((row) => ({ ...row, team_name: byTeam.get(row.team_id)?.name ?? null })),
      by_item: allItems.slice(0, TOP_ITEMS),
      items_costed: allItems.length,
    };
  }

  /**
   * Items waiting right now, most expensive wait to end first: the rate of delay divided by the remaining duration in
   * days. The remaining duration is the median remaining time of comparable completed visits that lasted longer than the
   * wait so far (the same history as US21.3); without enough of it an item is listed but cannot be ranked.
   */
  public async openItems(orgId: string, version?: number, now = new Date()) {
    const set = await this.getSet(orgId, version);
    const { settings, scored, history } = await this.risk.waitHistory(orgId, now);
    const services = await this.serviceLinks(orgId, scored.items.map(({ item }) => item.id));
    const teams = new Map((await this.dbService.db.query<any>(`SELECT id, name FROM teams WHERE org_id = $1`, [orgId])).rows.map((row: any) => [row.id, row.name]));
    const rules = set?.rules ?? [];

    const ranked: Array<Record<string, any>> = [];
    const unranked: Array<Record<string, any>> = [];
    const noAssumption: Array<Record<string, any>> = [];
    for (const { item, intervals } of scored.items) {
      for (const interval of intervals) {
        if (!interval.open || (interval.classification !== 'waiting' && interval.classification !== 'blocked')) continue;
        const rule = matchRule(rules, { team_id: item.team_id, item_type: item.type, priority: item.priority ?? null, service_ids: services.get(item.id) ?? [] });
        const base = {
          work_item_id: item.id, item_key: item.item_key, team_id: item.team_id, team_name: teams.get(item.team_id) ?? null,
          item_type: item.type, priority: item.priority ?? null, state: interval.state, entered_at: interval.started_at,
          waited_minutes: toMinutes(interval.ms),
        };
        if (!rule) { noAssumption.push({ ...base, reason: 'No assumption applies to this item, so no cost is given.' }); continue; }
        const sample = history.get(`${item.team_id}|${item.type}|${interval.state}`);
        const waited = interval.ms / 60_000;
        let remaining: number | null = null;
        let basis: 'historical_median_remaining' | 'insufficient_history' | 'beyond_history' = 'insufficient_history';
        if (sample && sample.items.size >= settings.min_sample) {
          remaining = remainingMinutes(sample.durations, waited);
          basis = remaining === null ? 'beyond_history' : 'historical_median_remaining';
        }
        const score = remaining === null ? null : priorityScore(rule.rate_per_day, remaining, interval.calendar);
        const row = {
          ...base,
          rate_per_day: rule.rate_per_day,
          cost_so_far: intervalCost(rule, interval.ms, interval.calendar),
          value_at_risk: rule.fixed_value_at_risk,
          remaining_minutes: remaining === null ? null : Math.round(remaining * 100) / 100,
          remaining_basis: basis,
          priority_score: score,
          assumption: describeRule(rule),
        };
        (score === null ? unranked : ranked).push(row);
      }
    }
    ranked.sort((a, b) => b.priority_score - a.priority_score || b.rate_per_day - a.rate_per_day);
    unranked.sort((a, b) => b.rate_per_day - a.rate_per_day || b.cost_so_far - a.cost_so_far);

    return {
      ...this.frame(set),
      method: 'Items are ordered by cost of delay (the applicable rate per day) divided by the estimated remaining duration in days. '
        + 'Remaining duration is the median remaining time of comparable completed visits that lasted longer than the wait so far; '
        + `at least ${settings.min_sample} comparable items are required, otherwise the item is listed without a rank.`,
      minutes_per_day: MINUTES_PER_DAY,
      ranked,
      unranked,
      without_assumption: noAssumption,
    };
  }

  private frame(set: AssumptionSet | null) {
    return {
      estimate: true as const,
      label: COST_LABEL,
      assumptions: set
        ? { version: set.version, currency: set.currency, rule_count: set.rules.length, saved_by: set.created_by, saved_at: set.created_at, rules: set.rules.map(describeRule) }
        : null,
      ...(set ? {} : { message: 'No cost assumptions are configured, so no cost is given. Save assumptions to price waiting time.' }),
    };
  }

  private async serviceLinks(orgId: string, itemIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!itemIds.length) return map;
    const result = await this.dbService.db.query<any>(
      `SELECT work_item_id, service_id FROM work_item_service_links WHERE org_id = $1 AND work_item_id = ANY($2::uuid[])`, [orgId, itemIds],
    );
    for (const row of result.rows) map.set(row.work_item_id, [...(map.get(row.work_item_id) ?? []), row.service_id]);
    return map;
  }
}
