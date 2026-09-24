import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { SlaCalendar } from '../sla/sla-calculator.service';
import { WorkflowService } from '../workflow/workflow.service';
import { ClassificationResolver, FlowClassificationService } from './flow-classification.service';
import {
  BucketMs,
  FlowBucket,
  StateChange,
  StateInterval,
  addBucketMs,
  buildIntervals,
  businessMs,
  clipIntervals,
  emptyBucketMs,
  toMinutes,
  totalsFrom,
} from './flow-profile';
import { ReasonCategory, ReasonSource, isWaitReasonCategory } from './wait-reason';

const MAX_REPORT_ITEMS = 10_000;
const MAX_DRILL_DOWN = 1_000;
const DEFAULT_WINDOW_DAYS = 30;
const CALENDAR_NOTE =
  'Durations are business time. The calendar for each state comes from the SLA policy for that item type and state '
  + '(5x8 is Monday to Friday 09:00-17:00 UTC) and is 24x7 where no policy exists. Time in a workflow terminal state is excluded.';
const WAIT_METHOD =
  'Only time in states classified waiting or blocked is analysed; unclassified time is excluded because it is not known to be a wait. '
  + 'The reason category is, in order: the reason supplied with the transition that entered the state, a blocking link (dependency), '
  + 'the state\'s default reason, otherwise unattributed. The blocking item is the first-created blocked_by, blocks or caused_by link that existed '
  + 'when the interval began and whose blocking item was not already closed; if there are several the first is used and the interval is flagged.';

export class FlowNotFoundError extends Error {}
export class InvalidFlowRangeError extends Error {}

export interface ItemRow {
  id: string;
  item_key: string | null;
  type: string;
  team_id: string;
  status: string;
  priority?: string;
  created_at: Date | string;
}

/** An item that is holding up another, with the moment the link appeared and when (if ever) it stopped blocking. */
interface Blocker {
  id: string;
  key: string | null;
  team_id: string | null;
  team_name: string | null;
  linked_at: Date;
  closed_at: Date | null;
}

export interface BlockingItem {
  id: string;
  key: string | null;
  team_id: string | null;
  team_name: string | null;
}

export interface Scored {
  state: string;
  classification: FlowBucket;
  classification_version: number | null;
  calendar: SlaCalendar;
  started_at: string;
  ended_at: string;
  open: boolean;
  ms: number;
  /** Present only for waiting and blocked intervals. */
  wait?: {
    reason: ReasonCategory;
    reason_source: ReasonSource;
    note: string | null;
    blocking_item: BlockingItem | null;
    ambiguous_blockers: number;
  };
}

interface Context {
  resolver: ClassificationResolver;
  calendars: Map<string, SlaCalendar>;
  terminal: Map<string, Set<string>>;
  blockers: Map<string, Blocker[]>;
  events: Map<string, StateChange[]>;
}

interface WaitRow {
  work_item_id: string;
  item_key: string | null;
  item_type: string;
  priority: string | null;
  team_id: string;
  team_name: string | null;
  state: string;
  classification: FlowBucket;
  started_at: string;
  ended_at: string;
  open: boolean;
  calendar: SlaCalendar;
  reason: ReasonCategory;
  reason_source: ReasonSource;
  note: string | null;
  blocking_item: BlockingItem | null;
  ambiguous_blockers: number;
  ms: number;
}

export interface WaitFilter {
  itemId?: string;
  teamId?: string;
  itemType?: string;
  reason?: string;
  blockingItemId?: string;
  blockingTeamId?: string;
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

/**
 * Worked versus waiting time from recorded history (US21.1), and why the waiting happened (US21.2).
 *
 * A work item's state-change events (`audit_events`, written at the source system's own timestamp for
 * connector twins) become state intervals; each interval is measured in business time and bucketed by the
 * state's *current* classification. Nothing is stored, so reclassifying a state immediately restates every
 * profile and report, and no item's recorded history is ever edited.
 */
@Injectable()
export class FlowService {
  private readonly dbService = DatabaseService.getInstance();
  private readonly classifications = new FlowClassificationService();
  private readonly workflows = new WorkflowService();

  public async profile(orgId: string, workItemId: string, range: { from?: string; to?: string } = {}, now = new Date()) {
    await this.dbService.initialize();
    const item = (await this.dbService.db.query<ItemRow>(
      `SELECT id, item_key, type, team_id, status, priority, created_at FROM work_items WHERE id = $1 AND org_id = $2`,
      [workItemId, orgId],
    )).rows[0];
    if (!item) throw new FlowNotFoundError(`Work item '${workItemId}' not found`);

    const { from, to } = this.parseRange(range, false);
    const context = await this.context(orgId, [item]);
    const scored = this.score(item, context, from, to, now);

    const ms = emptyBucketMs();
    const byState = new Map<string, { classification: FlowBucket; ms: number }>();
    for (const interval of scored.intervals) {
      ms[interval.classification] += interval.ms;
      const key = `${interval.state}|${interval.classification}`;
      const entry = byState.get(key) ?? { classification: interval.classification, ms: 0 };
      entry.ms += interval.ms;
      byState.set(key, entry);
    }
    const unclassifiedStates = [...new Set(scored.intervals.filter((i) => i.classification === 'unclassified').map((i) => i.state))];

    return {
      work_item_id: item.id,
      item_key: item.item_key,
      type: item.type,
      team_id: item.team_id,
      current_state: item.status,
      as_of: now.toISOString(),
      window: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      ...totalsFrom(ms),
      unclassified_states: unclassifiedStates,
      by_state: [...byState.entries()].map(([key, value]) => ({
        state: key.slice(0, key.lastIndexOf('|')),
        classification: value.classification,
        minutes: toMinutes(value.ms),
      })),
      intervals: scored.intervals.map(({ ms: intervalMs, ...rest }) => ({ ...rest, minutes: toMinutes(intervalMs) })),
      history_anomalies: scored.anomalies,
      calendar_note: CALENDAR_NOTE,
    };
  }

  public async report(
    orgId: string,
    range: { from?: string; to?: string },
    filter: { teamId?: string; itemType?: string } = {},
    now = new Date(),
  ) {
    await this.dbService.initialize();
    const { from, to } = this.parseRange(range, true, now);
    const { items, truncated } = await this.loadItems(orgId, to!, filter);
    const context = await this.context(orgId, items);
    const teamNames = await this.teamNames(orgId);

    const overall = emptyBucketMs();
    const byTeam = new Map<string, { ms: BucketMs; items: number }>();
    const byType = new Map<string, { ms: BucketMs; items: number }>();
    const byState = new Map<string, { state: string; classification: FlowBucket; ms: number; items: Set<string> }>();
    let anomalies = 0;
    let counted = 0;

    for (const item of items) {
      const scored = this.score(item, context, from, to, now);
      anomalies += scored.anomalies;
      if (!scored.intervals.length) continue;
      counted += 1;
      const itemMs = emptyBucketMs();
      for (const interval of scored.intervals) {
        itemMs[interval.classification] += interval.ms;
        const key = `${interval.state}|${interval.classification}`;
        const entry = byState.get(key) ?? { state: interval.state, classification: interval.classification, ms: 0, items: new Set<string>() };
        entry.ms += interval.ms;
        entry.items.add(item.id);
        byState.set(key, entry);
      }
      addBucketMs(overall, itemMs);
      for (const [map, key] of [[byTeam, item.team_id], [byType, item.type]] as const) {
        const entry = map.get(key) ?? { ms: emptyBucketMs(), items: 0 };
        addBucketMs(entry.ms, itemMs);
        entry.items += 1;
        map.set(key, entry);
      }
    }

    const ranked = <T extends { elapsed_minutes: number }>(rows: T[]) => rows.sort((a, b) => b.elapsed_minutes - a.elapsed_minutes);
    return {
      window: { from: from!.toISOString(), to: to!.toISOString() },
      items_considered: items.length,
      items_with_time: counted,
      truncated,
      ...totalsFrom(overall),
      by_team: ranked([...byTeam.entries()].map(([teamId, v]) => ({
        team_id: teamId, team_name: teamNames.get(teamId) ?? null, items: v.items, ...totalsFrom(v.ms),
      }))),
      by_item_type: ranked([...byType.entries()].map(([type, v]) => ({ item_type: type, items: v.items, ...totalsFrom(v.ms) }))),
      by_state: [...byState.values()]
        .map((v) => ({ state: v.state, classification: v.classification, items: v.items.size, minutes: toMinutes(v.ms) }))
        .sort((a, b) => b.minutes - a.minutes),
      unclassified_states: [...new Set([...byState.values()].filter((v) => v.classification === 'unclassified').map((v) => v.state))].sort(),
      history_anomalies: anomalies,
      calendar_note: CALENDAR_NOTE,
      method: 'Flow efficiency is active business time divided by total elapsed business time, from recorded state changes. '
        + 'Unclassified states count as elapsed time and are never assumed to be active.',
    };
  }

  /** Every non-terminal-or-complete visit of every item in an org, unclipped, for history-based analysis (US21.3). */
  public async scoreOrg(orgId: string, now = new Date()) {
    await this.dbService.initialize();
    const { items, truncated } = await this.loadItems(orgId, now, {});
    const context = await this.context(orgId, items);
    return {
      truncated,
      items: items.map((item) => ({ item, ...this.score(item, context, null, null, now) })),
    };
  }

  /** Total waiting and blocked time in a range grouped by reason, team and blocking item, each with its share of the total. */
  public async waitReasons(
    orgId: string,
    range: { from?: string; to?: string },
    filter: { teamId?: string; itemType?: string } = {},
    now = new Date(),
  ) {
    const { rows, total, unclassifiedMs, truncated, window, itemsConsidered } = await this.collectWaits(orgId, range, filter, now);
    const group = <K extends string>(keyOf: (row: WaitRow) => K | null, build: (key: K, row: WaitRow) => Record<string, unknown>) => {
      const map = new Map<K, { ms: number; intervals: number; items: Set<string>; first: WaitRow }>();
      for (const row of rows) {
        const key = keyOf(row);
        if (key === null) continue;
        const entry = map.get(key) ?? { ms: 0, intervals: 0, items: new Set<string>(), first: row };
        entry.ms += row.ms;
        entry.intervals += 1;
        entry.items.add(row.work_item_id);
        map.set(key, entry);
      }
      return [...map.entries()]
        .map(([key, v]) => ({ ...build(key, v.first), minutes: toMinutes(v.ms), share: share(v.ms, total), intervals: v.intervals, items: v.items.size, _ms: v.ms }))
        .sort((a, b) => b._ms - a._ms)
        .map(({ _ms, ...rest }) => rest);
    };
    const blockedMs = rows.filter((row) => row.blocking_item).reduce((sum, row) => sum + row.ms, 0);
    const unattributedMs = rows.filter((row) => row.reason === 'unattributed').reduce((sum, row) => sum + row.ms, 0);

    return {
      window,
      items_considered: itemsConsidered,
      truncated,
      total_wait_minutes: toMinutes(total),
      excluded_unclassified_minutes: toMinutes(unclassifiedMs),
      unattributed_share: share(unattributedMs, total),
      blocked_by_item_minutes: toMinutes(blockedMs),
      by_reason: group((row) => row.reason, (reason) => ({ reason })),
      by_team: group((row) => row.team_id, (teamId, row) => ({ team_id: teamId, team_name: row.team_name })),
      by_blocking_item: group((row) => row.blocking_item?.id ?? null, (_id, row) => ({
        blocking_item_id: row.blocking_item!.id,
        blocking_item_key: row.blocking_item!.key,
        blocking_team_id: row.blocking_item!.team_id,
        blocking_team_name: row.blocking_item!.team_name,
      })),
      by_blocking_team: group((row) => row.blocking_item?.team_id ?? null, (teamId, row) => ({
        blocking_team_id: teamId, blocking_team_name: row.blocking_item!.team_name,
      })),
      method: WAIT_METHOD,
      calendar_note: CALENDAR_NOTE,
    };
  }

  /** The intervals behind any figure in the wait-reason report: filter by reason, team, blocking item or blocking team. */
  public async waitIntervals(
    orgId: string,
    range: { from?: string; to?: string },
    filter: WaitFilter = {},
    now = new Date(),
  ) {
    if (filter.reason && filter.reason !== 'unattributed' && !isWaitReasonCategory(filter.reason)) {
      throw new InvalidFlowRangeError(`reason '${filter.reason}' is not a known reason category`);
    }
    const { rows, window, truncated } = await this.collectWaits(orgId, range, filter, now);
    const matching = rows.filter((row) =>
      (!filter.reason || row.reason === filter.reason)
      && (!filter.blockingItemId || row.blocking_item?.id === filter.blockingItemId)
      && (!filter.blockingTeamId || row.blocking_item?.team_id === filter.blockingTeamId));
    matching.sort((a, b) => b.ms - a.ms);
    const capped = matching.slice(0, MAX_DRILL_DOWN);
    return {
      window,
      total: matching.length,
      returned: capped.length,
      truncated: truncated || matching.length > capped.length,
      total_minutes: toMinutes(matching.reduce((sum, row) => sum + row.ms, 0)),
      intervals: capped.map(({ ms, ...rest }) => ({ ...rest, minutes: toMinutes(ms) })),
    };
  }

  public async collectWaits(orgId: string, range: { from?: string; to?: string }, filter: WaitFilter, now: Date) {
    await this.dbService.initialize();
    const { from, to } = this.parseRange(range, true, now);
    const { items, truncated } = await this.loadItems(orgId, to!, filter);
    const context = await this.context(orgId, items);
    const teamNames = await this.teamNames(orgId);
    const rows: WaitRow[] = [];
    let total = 0;
    let unclassifiedMs = 0;
    for (const item of items) {
      for (const interval of this.score(item, context, from, to, now).intervals) {
        if (interval.classification === 'unclassified') unclassifiedMs += interval.ms;
        if (!interval.wait || interval.ms <= 0) continue;
        total += interval.ms;
        rows.push({
          work_item_id: item.id,
          item_key: item.item_key,
          item_type: item.type,
          priority: item.priority ?? null,
          team_id: item.team_id,
          team_name: teamNames.get(item.team_id) ?? null,
          state: interval.state,
          classification: interval.classification,
          started_at: interval.started_at,
          ended_at: interval.ended_at,
          open: interval.open,
          calendar: interval.calendar,
          reason: interval.wait.reason,
          reason_source: interval.wait.reason_source,
          note: interval.wait.note,
          blocking_item: interval.wait.blocking_item,
          ambiguous_blockers: interval.wait.ambiguous_blockers,
          ms: interval.ms,
        });
      }
    }
    return {
      rows,
      total,
      unclassifiedMs,
      truncated,
      itemsConsidered: items.length,
      window: { from: from!.toISOString(), to: to!.toISOString() },
    };
  }

  private score(item: ItemRow, context: Context, from: Date | null, to: Date | null, now: Date): { intervals: Scored[]; anomalies: number } {
    const built = buildIntervals({
      createdAt: new Date(item.created_at),
      currentState: item.status,
      events: context.events.get(item.id) ?? [],
      now,
      terminalStates: context.terminal.get(item.type),
    });
    const clipped: StateInterval[] = clipIntervals(built.intervals, from, to);
    const blockers = context.blockers.get(item.id) ?? [];
    const intervals = clipped.map((interval): Scored => {
      const resolved = context.resolver(item.team_id, interval.state);
      const calendar = context.calendars.get(`${item.type}|${interval.state}`) ?? '24x7';
      const scored: Scored = {
        state: interval.state,
        classification: resolved.classification,
        classification_version: resolved.version,
        calendar,
        started_at: interval.start.toISOString(),
        ended_at: interval.end.toISOString(),
        open: interval.open,
        ms: businessMs(interval.start, interval.end, calendar),
      };
      if (resolved.classification === 'waiting' || resolved.classification === 'blocked') {
        // Attribution is judged when the wait began, not at the edge of a report window, so a range never changes it.
        const entered = built.intervals.find((candidate) => candidate.state === interval.state
          && candidate.start <= interval.start && candidate.end >= interval.end);
        const enteredAt = entered?.start ?? interval.start;
        const applicable = blockers.filter((blocker) => blocker.linked_at <= enteredAt && (!blocker.closed_at || blocker.closed_at > enteredAt));
        const blocker = applicable[0] ?? null;
        const explicit = interval.reason ?? null;
        let reason: ReasonCategory = 'unattributed';
        let source: ReasonSource = 'none';
        if (explicit) { reason = explicit.category; source = 'transition'; }
        else if (blocker) { reason = 'dependency'; source = 'blocking_link'; }
        else if (resolved.default_reason) { reason = resolved.default_reason; source = 'state_default'; }
        scored.wait = {
          reason,
          reason_source: source,
          note: explicit?.note ?? null,
          blocking_item: blocker ? { id: blocker.id, key: blocker.key, team_id: blocker.team_id, team_name: blocker.team_name } : null,
          ambiguous_blockers: Math.max(0, applicable.length - 1),
        };
      }
      return scored;
    });
    return { intervals, anomalies: built.anomalies };
  }

  private async context(orgId: string, items: ItemRow[]): Promise<Context> {
    const events = await this.loadEvents(orgId, items.map((item) => item.id));
    const resolver = await this.classifications.resolver(orgId);
    const calendars = await this.loadCalendars(orgId);
    const terminal = await this.terminalStates([...new Set(items.map((item) => item.type))]);
    const blockers = await this.loadBlockers(orgId, items.map((item) => item.id), terminal);
    return { resolver, calendars, terminal, blockers, events };
  }

  private async loadItems(orgId: string, to: Date, filter: { teamId?: string; itemType?: string; itemId?: string }) {
    const params: unknown[] = [orgId, to.toISOString()];
    let where = 'org_id = $1 AND created_at < $2';
    if (filter.teamId) { params.push(filter.teamId); where += ` AND team_id = $${params.length}`; }
    if (filter.itemType) { params.push(filter.itemType); where += ` AND type = $${params.length}`; }
    if (filter.itemId) { params.push(filter.itemId); where += ` AND id = $${params.length}`; }
    const result = await this.dbService.db.query<ItemRow>(
      `SELECT id, item_key, type, team_id, status, priority, created_at FROM work_items
       WHERE ${where} ORDER BY created_at, id LIMIT ${MAX_REPORT_ITEMS + 1}`,
      params,
    );
    return { items: result.rows.slice(0, MAX_REPORT_ITEMS), truncated: result.rows.length > MAX_REPORT_ITEMS };
  }

  private async teamNames(orgId: string): Promise<Map<string, string>> {
    const result = await this.dbService.db.query<any>(`SELECT id, name FROM teams WHERE org_id = $1`, [orgId]);
    return new Map(result.rows.map((row: any) => [row.id, row.name]));
  }

  private async loadEvents(orgId: string, itemIds: string[]): Promise<Map<string, StateChange[]>> {
    const map = new Map<string, StateChange[]>();
    if (!itemIds.length) return map;
    const result = await this.dbService.db.query<any>(
      `SELECT a.work_item_id, a.timestamp, a.payload
       FROM audit_events a JOIN work_items w ON w.id = a.work_item_id
       WHERE w.org_id = $1 AND a.event_type = 'WorkItemStateChanged' AND a.work_item_id = ANY($2::uuid[])
       ORDER BY a.timestamp, a.id`,
      [orgId, itemIds],
    );
    for (const row of result.rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (typeof payload?.to_state !== 'string') continue;
      const list = map.get(row.work_item_id) ?? [];
      const category = payload.wait_reason?.category;
      list.push({
        at: new Date(row.timestamp),
        from: typeof payload.from_state === 'string' ? payload.from_state : null,
        to: payload.to_state,
        reason: isWaitReasonCategory(category)
          ? { category, note: typeof payload.wait_reason.note === 'string' ? payload.wait_reason.note : null }
          : null,
      });
      map.set(row.work_item_id, list);
    }
    return map;
  }

  /**
   * Items that hold up each given item: `X blocked_by Y`, `X caused_by Y` and `Y blocks X` all make Y a blocker of X.
   * A blocker stops counting once it reaches a terminal state of its own workflow.
   */
  private async loadBlockers(orgId: string, itemIds: string[], knownTerminal: Map<string, Set<string>>): Promise<Map<string, Blocker[]>> {
    const map = new Map<string, Blocker[]>();
    if (!itemIds.length) return map;
    const links = await this.dbService.db.query<any>(
      `SELECT id, source_id, target_id, link_type, created_at FROM work_item_links
       WHERE (source_id = ANY($1::uuid[]) AND link_type IN ('blocked_by', 'caused_by'))
          OR (target_id = ANY($1::uuid[]) AND link_type = 'blocks')
       ORDER BY created_at, id`,
      [itemIds],
    );
    if (!links.rows.length) return map;
    const pairs = links.rows.map((row: any) => ({
      blocked: row.link_type === 'blocks' ? row.target_id : row.source_id,
      blocker: row.link_type === 'blocks' ? row.source_id : row.target_id,
      linkedAt: new Date(row.created_at),
    }));
    const blockerIds = [...new Set(pairs.map((pair: any) => pair.blocker as string))];
    const info = await this.dbService.db.query<ItemRow>(
      `SELECT id, item_key, type, team_id, status, created_at FROM work_items WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, blockerIds],
    );
    const blockerItems = new Map(info.rows.map((row) => [row.id, row]));
    const terminal = new Map(knownTerminal);
    const missing = [...new Set(info.rows.map((row) => row.type))].filter((type) => !terminal.has(type));
    for (const [type, states] of await this.terminalStates(missing)) terminal.set(type, states);
    const blockerEvents = await this.loadEvents(orgId, [...blockerItems.keys()]);
    const names = await this.teamNames(orgId);

    for (const pair of pairs) {
      const item = blockerItems.get(pair.blocker);
      if (!item) continue; // a blocker in another tenant (or gone) is not attributable here
      const finals = terminal.get(item.type) ?? new Set<string>();
      let closedAt: Date | null = null;
      if (finals.has(item.status)) {
        const entries = (blockerEvents.get(item.id) ?? []).filter((event) => finals.has(event.to));
        closedAt = entries.length ? entries[entries.length - 1].at : new Date(item.created_at);
      }
      const list = map.get(pair.blocked) ?? [];
      list.push({
        id: item.id, key: item.item_key, team_id: item.team_id, team_name: names.get(item.team_id) ?? null,
        linked_at: pair.linkedAt, closed_at: closedAt,
      });
      map.set(pair.blocked, list);
    }
    return map;
  }

  private async loadCalendars(orgId: string): Promise<Map<string, SlaCalendar>> {
    const result = await this.dbService.db.query<any>(`SELECT item_type, state, calendar FROM sla_policies WHERE org_id = $1`, [orgId]);
    return new Map(result.rows.map((row: any) => [`${row.item_type}|${row.state}`, row.calendar as SlaCalendar]));
  }

  private async terminalStates(types: string[]): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    for (const type of types) {
      const definition = await this.workflows.getWorkflowDefinition(type);
      map.set(type, new Set(definition?.definition.terminal_states ?? []));
    }
    return map;
  }

  private parseRange(range: { from?: string; to?: string }, defaults: boolean, now = new Date()) {
    const parse = (value: string | undefined, field: string) => {
      if (!value) return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new InvalidFlowRangeError(`${field} must be an ISO 8601 date`);
      return date;
    };
    let from = parse(range.from, 'from');
    let to = parse(range.to, 'to');
    if (defaults) {
      to = to ?? now;
      from = from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
    }
    if (from && to && from.getTime() >= to.getTime()) throw new InvalidFlowRangeError('from must be earlier than to');
    return { from, to };
  }
}
