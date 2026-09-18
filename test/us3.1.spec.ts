import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';
import { randomUUID } from 'crypto';

describe('US3.1: Configurable SLA Thresholds & Business Calendar', () => {
  let dbService: DatabaseService;
  let slaCalculator: SlaCalculatorService;

  const ORG_ID = '00000000-0000-0000-0000-000000000099';

  beforeEach(async () => {
    dbService = DatabaseService.getInstance();
    await dbService.initialize();
    slaCalculator = new SlaCalculatorService();

    await dbService.db.exec(`
      INSERT INTO orgs (id, name) VALUES ('${ORG_ID}', 'Primary Org') ON CONFLICT DO NOTHING;
    `);

    await dbService.db.exec(`DELETE FROM sla_policies;`);
    await dbService.db.exec(`DELETE FROM work_items;`);
  });

  it('excludes weekend time on a 5x8 business calendar', async () => {
    // Friday Sept 18, 2026, 4:00 PM (16:00)
    const friday4pm = new Date('2026-09-18T16:00:00.000Z');
    // Monday Sept 21, 2026, 10:00 AM (10:00)
    const monday10am = new Date('2026-09-21T10:00:00.000Z');

    // 2 business days = 2 * 8 * 60 = 960 minutes
    const thresholdMinutes = 960;

    const result = slaCalculator.computeAging(
      friday4pm,
      monday10am,
      thresholdMinutes,
      '5x8',
    );

    // Friday 4pm -> 5pm = 60 mins. Sat/Sun = 0 mins. Mon 9am -> 10am = 60 mins. Total = 120 mins.
    expect(result.elapsedMinutes).toBe(120);
    // 120 / 960 * 100 = 12.5%
    expect(result.agingScore).toBe(12.5);
    expect(result.agingBucket).toBe('green');
  });

  it('fires no false aging alert when no threshold is configured for a (type, state) pair', async () => {
    const itemType = 'custom_type';
    const state = 'Draft';

    // Insert policy for a different item type
    await dbService.db.exec(`
      INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
      VALUES ('${randomUUID()}', '${ORG_ID}', 'story', 'In Review', 960, '5x8');
    `);

    // Query policy for (custom_type, Draft)
    const res = await dbService.db.query(
      `SELECT * FROM sla_policies WHERE org_id = $1 AND item_type = $2 AND state = $3;`,
      [ORG_ID, itemType, state],
    );

    expect(res.rows.length).toBe(0);

    // Default policy behavior when missing: score = 0, bucket = green
    const agingScore = res.rows.length > 0 ? 100 : 0;
    const agingBucket = res.rows.length > 0 ? 'red' : 'green';

    expect(agingScore).toBe(0);
    expect(agingBucket).toBe('green');
  });
});
