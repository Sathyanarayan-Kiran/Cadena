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

const MAX_REPORT_ITEMS = 10_000;
const DEFAULT_WINDOW_DAYS = 30;
const CALENDAR_NOTE =
  'Durations are business time. The calendar for each state comes from the SLA policy for that item type and state '
  + '(5x8 is Monday to Friday 09:00-17:00 UTC) and is 24x7 where no policy exists. Time in a workflow terminal state is excluded.';

export class FlowNotFoundError extends Error {}
export class InvalidFlowRangeError extends Error {}

interface ItemRow {
  id: string;
  item_key: string | null;
  type: string;
  team_id: string;
  status: string;
  created_at: Date | string;
}

interface Scored {
  state: string;
  classification: FlowBucket;
  classification_version: number | null;
  calendar: SlaCalendar;
  started_at: string;
  ended_at: string;
  open: boolean;
  ms: number;
}

/**
 * Worked versus waiting time from recorded history (US21.1).
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
      `SELECT id, item_key, type, team_id, status, created_at FROM work_items WHERE id = $1 AND org_id = $2`,
      [workItemId, orgId],
    )).rows[0];
    if (!item) throw new FlowNotFoundError(`Work item '${workItemId}' not found`);

    const { from, to } = this.parseRange(range, false);
    const events = await this.loadEvents(orgId, [item.id]);
    const resolver = await this.classifications.resolver(orgId);
    const calendars = await this.loadCalendars(orgId);
    const terminal = await this.terminalStates([item.type]);
    const scored = this.score(item, events.get(item.id) ?? [], resolver, calendars, terminal, from, to, now);

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

    const params: unknown[] = [orgId, to!.toISOString()];
    let where = 'org_id = $1 AND created_at < $2';
    if (filter.teamId) { params.push(filter.teamId); where += ` AND team_id = $${params.length}`; }
    if (filter.itemType) { params.push(filter.itemType); where += ` AND type = $${params.length}`; }
    const itemResult = await this.dbService.db.query<ItemRow>(
      `SELECT id, item_key, type, team_id, status, created_at FROM work_items
       WHERE ${where} ORDER BY created_at, id LIMIT ${MAX_REPORT_ITEMS + 1}`,
      params,
    );
    const truncated = itemResult.rows.length > MAX_REPORT_ITEMS;
    const items = itemResult.rows.slice(0, MAX_REPORT_ITEMS);

    const events = await this.loadEvents(orgId, items.map((item) => item.id));
    const resolver = await this.classifications.resolver(orgId);
    const calendars = await this.loadCalendars(orgId);
    const terminal = await this.terminalStates([...new Set(items.map((item) => item.type))]);
    const teamNames = new Map(
      (await this.dbService.db.query<any>(`SELECT id, name FROM teams WHERE org_id = $1`, [orgId])).rows.map((row: any) => [row.id, row.name]),
    );

    const overall = emptyBucketMs();
    const byTeam = new Map<string, { ms: BucketMs; items: number }>();
    const byType = new Map<string, { ms: BucketMs; items: number }>();
    const byState = new Map<string, { state: string; classification: FlowBucket; ms: number; items: Set<string> }>();
    let anomalies = 0;
    let counted = 0;

    for (const item of items) {
      const scored = this.score(item, events.get(item.id) ?? [], resolver, calendars, terminal, from, to, now);
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

  private score(
    item: ItemRow,
    events: StateChange[],
    resolver: ClassificationResolver,
    calendars: Map<string, SlaCalendar>,
    terminal: Map<string, Set<string>>,
    from: Date | null,
    to: Date | null,
    now: Date,
  ): { intervals: Scored[]; anomalies: number } {
    const built = buildIntervals({
      createdAt: new Date(item.created_at),
      currentState: item.status,
      events,
      now,
      terminalStates: terminal.get(item.type),
    });
    const clipped: StateInterval[] = clipIntervals(built.intervals, from, to);
    const intervals = clipped.map((interval): Scored => {
      const resolved = resolver(item.team_id, interval.state);
      const calendar = calendars.get(`${item.type}|${interval.state}`) ?? '24x7';
      return {
        state: interval.state,
        classification: resolved.classification,
        classification_version: resolved.version,
        calendar,
        started_at: interval.start.toISOString(),
        ended_at: interval.end.toISOString(),
        open: interval.open,
        ms: businessMs(interval.start, interval.end, calendar),
      };
    });
    return { intervals, anomalies: built.anomalies };
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
      list.push({ at: new Date(row.timestamp), from: typeof payload.from_state === 'string' ? payload.from_state : null, to: payload.to_state });
      map.set(row.work_item_id, list);
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
