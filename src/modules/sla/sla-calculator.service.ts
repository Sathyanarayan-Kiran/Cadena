import { Injectable } from '@nestjs/common';

export type SlaCalendar = '5x8' | '24x7';

export interface AgingCalculationResult {
  elapsedMinutes: number;
  agingScore: number;
  agingBucket: 'green' | 'amber' | 'red';
}

@Injectable()
export class SlaCalculatorService {
  /**
   * Calculates elapsed business minutes between enteredAt and now based on the specified calendar.
   */
  public calculateElapsedMinutes(
    enteredAt: Date,
    now: Date,
    calendar: SlaCalendar,
  ): number {
    if (now <= enteredAt) return 0;

    if (calendar === '24x7') {
      const diffMs = now.getTime() - enteredAt.getTime();
      return Math.floor(diffMs / (1000 * 60));
    }

    // 5x8 Business Calendar Logic:
    // Mon-Fri (1-5), 9:00 AM to 5:00 PM (17:00).
    let elapsedMs = 0;
    let curr = new Date(enteredAt.getTime());

    while (curr < now) {
      const day = curr.getUTCDay(); // 0 = Sun, 6 = Sat
      const hours = curr.getUTCHours();

      const isWeekday = day >= 1 && day <= 5;
      const isWorkHours = hours >= 9 && hours < 17;

      if (isWeekday && isWorkHours) {
        const nextMin = new Date(curr.getTime() + 60000);
        nextMin.setUTCSeconds(0, 0);

        const endOfWorkday = new Date(curr.getTime());
        endOfWorkday.setUTCHours(17, 0, 0, 0);

        const nextBoundary = new Date(
          Math.min(now.getTime(), nextMin.getTime(), endOfWorkday.getTime()),
        );

        const chunkMs = nextBoundary.getTime() - curr.getTime();
        if (chunkMs > 0) {
          elapsedMs += chunkMs;
          curr = nextBoundary;
        } else {
          curr = new Date(curr.getTime() + 60000);
        }
      } else {
        const nextWorkTime = new Date(curr.getTime());
        if (isWeekday && hours < 9) {
          nextWorkTime.setUTCHours(9, 0, 0, 0);
        } else {
          nextWorkTime.setUTCDate(nextWorkTime.getUTCDate() + 1);
          nextWorkTime.setUTCHours(9, 0, 0, 0);
        }

        if (nextWorkTime > now) {
          break;
        }
        curr = nextWorkTime;
      }
    }

    return Math.floor(elapsedMs / (1000 * 60));
  }

  /**
   * Computes aging score (% consumed) and aging bucket (green/amber/red).
   */
  public computeAging(
    enteredAt: Date,
    now: Date,
    thresholdMinutes: number,
    calendar: SlaCalendar,
  ): AgingCalculationResult {
    const elapsedMinutes = this.calculateElapsedMinutes(enteredAt, now, calendar);
    const agingScore = thresholdMinutes > 0 ? (elapsedMinutes / thresholdMinutes) * 100 : 0;

    let agingBucket: 'green' | 'amber' | 'red' = 'green';
    if (agingScore > 100) {
      agingBucket = 'red';
    } else if (agingScore >= 75) {
      agingBucket = 'amber';
    } else {
      agingBucket = 'green';
    }

    return {
      elapsedMinutes,
      agingScore: Math.round(agingScore * 100) / 100,
      agingBucket,
    };
  }
}
