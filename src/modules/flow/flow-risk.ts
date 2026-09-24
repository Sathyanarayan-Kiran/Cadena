/**
 * Risk of waiting too long (US21.3): pure calculation over the historical time-in-state distribution.
 *
 * Nothing is modelled or fitted. The percentile is a rank within comparable completed visits, and the
 * probability of overrunning the target is the share of the comparable visits that were still going when this
 * one is now and ran past the target. Below the minimum sample no score is produced at all.
 */
export const RISK_METHOD =
  'Empirical distribution of business time spent in this state by completed comparable visits (same team, item type and state). '
  + 'Percentile is the mid-rank share of those visits no longer than the current wait. Probability of exceeding the target is the share of '
  + 'visits that lasted longer than the current wait which also lasted longer than the state\'s SLA threshold.';

export type ProbabilityBasis = 'conditional_empirical' | 'already_past_target' | 'no_sla_target' | 'beyond_history';

export interface RiskInput {
  /** Business minutes of each completed comparable visit. */
  samples: number[];
  /** How many distinct items those visits belong to. */
  sampleItems: number;
  currentMinutes: number;
  targetMinutes: number | null;
  minSample: number;
}

export type RiskResult =
  | {
    status: 'insufficient_history';
    sample_size: number;
    sample_items: number;
    min_sample: number;
    message: string;
  }
  | {
    status: 'scored';
    percentile: number;
    probability_exceed_target: number | null;
    probability_basis: ProbabilityBasis;
    sample_size: number;
    sample_items: number;
    min_sample: number;
    current_wait_minutes: number;
    target_minutes: number | null;
    method: string;
  };

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export function assessRisk(input: RiskInput): RiskResult {
  const { samples, sampleItems, currentMinutes, targetMinutes, minSample } = input;
  if (sampleItems < minSample) {
    return {
      status: 'insufficient_history',
      sample_size: samples.length,
      sample_items: sampleItems,
      min_sample: minSample,
      message: `History is insufficient: ${sampleItems} comparable item${sampleItems === 1 ? ' has' : 's have'} completed this state and at least ${minSample} are required, so no risk score is produced.`,
    };
  }

  const below = samples.filter((duration) => duration < currentMinutes).length;
  const equal = samples.filter((duration) => duration === currentMinutes).length;
  const percentile = round4((below + equal / 2) / samples.length);

  let probability: number | null;
  let basis: ProbabilityBasis;
  if (targetMinutes === null) {
    probability = null;
    basis = 'no_sla_target';
  } else if (currentMinutes >= targetMinutes) {
    probability = 1;
    basis = 'already_past_target';
  } else {
    const stillGoing = samples.filter((duration) => duration > currentMinutes);
    if (!stillGoing.length) {
      probability = null;
      basis = 'beyond_history';
    } else {
      probability = round4(stillGoing.filter((duration) => duration > targetMinutes).length / stillGoing.length);
      basis = 'conditional_empirical';
    }
  }

  return {
    status: 'scored',
    percentile,
    probability_exceed_target: probability,
    probability_basis: basis,
    sample_size: samples.length,
    sample_items: sampleItems,
    min_sample: minSample,
    current_wait_minutes: Math.round(currentMinutes * 100) / 100,
    target_minutes: targetMinutes,
    method: RISK_METHOD,
  };
}
