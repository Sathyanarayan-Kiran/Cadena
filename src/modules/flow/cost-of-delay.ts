import type { SlaCalendar } from '../sla/sla-calculator.service';

/**
 * Cost-of-delay calculations (US21.4). Every figure is an estimate built from assumptions the organisation supplies:
 * a cost rate per day for the scope an item falls in. Where no assumption applies there is no cost, never zero.
 */
export const COST_LABEL = 'Estimated cost of delay from your configured assumptions. It is an estimate, not an accounting figure.';

/** One "day" is a day of the interval's own calendar: 24 hours for 24x7, an 8-hour business day for 5x8. */
export const MINUTES_PER_DAY: Record<SlaCalendar, number> = { '24x7': 1440, '5x8': 480 };

export interface CostRule {
  id: string;
  team_id: string | null;
  item_type: string | null;
  priority: string | null;
  service_id: string | null;
  rate_per_day: number;
  fixed_value_at_risk: number | null;
  label: string | null;
}

export interface ItemScope {
  team_id: string;
  item_type: string;
  priority: string | null;
  service_ids: string[];
}

const WEIGHTS = { service_id: 8, team_id: 4, item_type: 2, priority: 1 } as const;

const specificity = (rule: CostRule) =>
  (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce(
    (acc, key) => (rule[key] === null ? acc : { count: acc.count + 1, weight: acc.weight + WEIGHTS[key] }),
    { count: 0, weight: 0 },
  );

/**
 * The most specific rule whose every set dimension matches the item. Specificity is the number of dimensions the rule
 * sets; among equals a service rule beats a team rule beats an item-type rule beats a priority rule, then the higher
 * rate, then the id, so the choice is deterministic. A rule that sets no dimension is the org-wide default.
 */
export function matchRule(rules: CostRule[], scope: ItemScope): CostRule | null {
  const candidates = rules.filter((rule) =>
    (rule.team_id === null || rule.team_id === scope.team_id)
    && (rule.item_type === null || rule.item_type === scope.item_type)
    && (rule.priority === null || rule.priority === scope.priority)
    && (rule.service_id === null || scope.service_ids.includes(rule.service_id)));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const sa = specificity(a);
    const sb = specificity(b);
    return sb.count - sa.count || sb.weight - sa.weight || b.rate_per_day - a.rate_per_day || a.id.localeCompare(b.id);
  })[0];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Cost of `ms` business milliseconds of waiting under `rule`. */
export function intervalCost(rule: CostRule, ms: number, calendar: SlaCalendar): number {
  return round2((rule.rate_per_day * (ms / 60_000)) / MINUTES_PER_DAY[calendar]);
}

/** Median remaining time of the visits that lasted longer than the current wait; null when none did. */
export function remainingMinutes(samples: number[], currentMinutes: number): number | null {
  const longer = samples.filter((duration) => duration > currentMinutes).map((duration) => duration - currentMinutes).sort((a, b) => a - b);
  if (!longer.length) return null;
  const mid = Math.floor(longer.length / 2);
  return longer.length % 2 ? longer[mid] : (longer[mid - 1] + longer[mid]) / 2;
}

/** Cost of delay (rate per day) divided by the remaining duration in days: the most expensive waits to end sort first. */
export function priorityScore(ratePerDay: number, remaining: number, calendar: SlaCalendar): number | null {
  if (remaining <= 0) return null;
  return Math.round((ratePerDay / (remaining / MINUTES_PER_DAY[calendar])) * 10_000) / 10_000;
}
