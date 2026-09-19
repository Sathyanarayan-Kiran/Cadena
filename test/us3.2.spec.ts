import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';
import { AgingEngineService } from '../src/modules/sla/aging-engine.service';
import { WorkItemService } from '../src/modules/work-items/work-item.service';
import { randomUUID } from 'crypto';

describe('US3.2: Continuous Aging Score & Heatmap Buckets', () => {
  let dbService: DatabaseService;
  let slaCalculator: SlaCalculatorService;
  let agingEngine: AgingEngineService;

  const ORG_ID = '00000000-0000-0000-0000-000000000099';
  const TEAM_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    dbService = DatabaseService.getInstance();
    await dbService.initialize();
    slaCalculator = new SlaCalculatorService();
    agingEngine = new AgingEngineService(slaCalculator);

    await dbService.db.exec(`
      INSERT INTO orgs (id, name) VALUES ('${ORG_ID}', 'Primary Org') ON CONFLICT DO NOTHING;
      INSERT INTO teams (id, org_id, name) VALUES ('${TEAM_ID}', '${ORG_ID}', 'Core Team') ON CONFLICT DO NOTHING;
    `);

    await dbService.db.exec(`DELETE FROM sla_policies;`);
    await dbService.db.exec(`DELETE FROM work_items;`);
  });

  it("flips aging bucket to amber when item consumes 80% of SLA threshold", async () => {
    // SLA Policy: Incident in Investigating state has 100 minute threshold on 24x7
    const policyId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
      VALUES ('${policyId}', '${ORG_ID}', 'incident', 'Investigating', 100, '24x7');
    `);

    // Work item entered state 80 minutes ago
    const enteredAt = new Date(Date.now() - 80 * 60 * 1000);
    const itemId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO work_items (id, type, title, status, priority, team_id, org_id, entered_state_at, aging_bucket, aging_score)
      VALUES ('${itemId}', 'incident', 'Database degradation', 'Investigating', 'P0', '${TEAM_ID}', '${ORG_ID}', '${enteredAt.toISOString()}', 'green', 0);
    `);

    // Run aging recompute tick
    await agingEngine.recomputeAgingForOrg(ORG_ID);

    // Verify item in database
    const res = await dbService.db.query<{ aging_bucket: string; aging_score: number }>(`SELECT aging_bucket, aging_score FROM work_items WHERE id = $1;`, [itemId]);
    expect(res.rows[0].aging_bucket).toBe('amber');
    expect(Number(res.rows[0].aging_score)).toBe(80);

    // The public WorkItem read model must expose the persisted engine result.
    const item = await new WorkItemService().getWorkItemById(itemId, ORG_ID);
    expect(item?.aging_bucket).toBe('amber');
    expect(item?.aging_score).toBe(80);
  });

  it("flips bucket to red when item exceeds 100% of threshold during recompute cycle", async () => {
    // SLA Policy: Story in In Review state has 60 minute threshold on 24x7
    const policyId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
      VALUES ('${policyId}', '${ORG_ID}', 'story', 'In Review', 60, '24x7');
    `);

    // Work item entered state 75 minutes ago (> 100% of threshold)
    const enteredAt = new Date(Date.now() - 75 * 60 * 1000);
    const itemId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO work_items (id, type, title, status, priority, team_id, org_id, entered_state_at, aging_bucket, aging_score)
      VALUES ('${itemId}', 'story', 'OAuth integration', 'In Review', 'P1', '${TEAM_ID}', '${ORG_ID}', '${enteredAt.toISOString()}', 'green', 0);
    `);

    // Run aging recompute tick
    await agingEngine.recomputeAgingForOrg(ORG_ID);

    // Verify item bucket flipped to red
    const res = await dbService.db.query<{ aging_bucket: string; aging_score: number }>(`SELECT aging_bucket, aging_score FROM work_items WHERE id = $1;`, [itemId]);
    expect(res.rows[0].aging_bucket).toBe('red');
    expect(Number(res.rows[0].aging_score)).toBe(125); // 75/60 * 100 = 125%

    const item = await new WorkItemService().getWorkItemById(itemId, ORG_ID);
    expect(item?.aging_bucket).toBe('red');
    expect(item?.aging_score).toBe(125);
  });
});
