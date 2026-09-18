import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';
import { AgingEngineService } from '../src/modules/sla/aging-engine.service';
import { InProcessEventBus } from '../src/modules/events/event-bus';
import { randomUUID } from 'crypto';

describe('US3.3: Automatic Warning & Breach Notifications + Event Emission', () => {
  let dbService: DatabaseService;
  let slaCalculator: SlaCalculatorService;
  let agingEngine: AgingEngineService;
  let eventBus: InProcessEventBus;

  const ORG_ID = '00000000-0000-0000-0000-000000000099';
  const TEAM_ID = '11111111-1111-1111-1111-111111111111';
  const OWNER_ID = '33333333-3333-3333-3333-333333333333';
  const TEAM_LEAD_ID = '44444444-4444-4444-4444-444444444444';

  beforeEach(async () => {
    dbService = DatabaseService.getInstance();
    await dbService.initialize();
    slaCalculator = new SlaCalculatorService();
    agingEngine = new AgingEngineService(slaCalculator);
    eventBus = InProcessEventBus.getInstance();
    eventBus.clearEmittedEvents();

    await dbService.db.exec(`
      INSERT INTO orgs (id, name) VALUES ('${ORG_ID}', 'Primary Org') ON CONFLICT DO NOTHING;
      INSERT INTO teams (id, org_id, name) VALUES ('${TEAM_ID}', '${ORG_ID}', 'Core Team') ON CONFLICT DO NOTHING;
      INSERT INTO people (id, org_id, team_id, name, email, role) VALUES
        ('${OWNER_ID}', '${ORG_ID}', '${TEAM_ID}', 'John Developer', 'john@cadena.io', 'developer'),
        ('${TEAM_LEAD_ID}', '${ORG_ID}', '${TEAM_ID}', 'Sarah Lead', 'sarah@cadena.io', 'team_lead')
      ON CONFLICT DO NOTHING;
    `);

    await dbService.db.exec(`DELETE FROM sla_policies;`);
    await dbService.db.exec(`DELETE FROM work_items;`);
  });

  it('emits SLAWarning event and notifies owner when item crosses 75% of SLA threshold', async () => {
    // 100 minute SLA policy for Incident in Investigating state
    const policyId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
      VALUES ('${policyId}', '${ORG_ID}', 'incident', 'Investigating', 100, '24x7');
    `);

    // Item entered state 78 minutes ago (78% consumed -> crosses 75%)
    const enteredAt = new Date(Date.now() - 78 * 60 * 1000);
    const itemId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO work_items (id, type, title, status, priority, owner_id, team_id, org_id, entered_state_at)
      VALUES ('${itemId}', 'incident', 'High latency on API', 'Investigating', 'P1', '${OWNER_ID}', '${TEAM_ID}', '${ORG_ID}', '${enteredAt.toISOString()}');
    `);

    // Run aging recompute cycle
    await agingEngine.recomputeAgingForOrg(ORG_ID);

    // Verify SLAWarning event was emitted
    const warningEvents = eventBus.emittedEvents.filter(e => e.event_type === 'SLAWarning');
    expect(warningEvents.length).toBe(1);
    expect(warningEvents[0].work_item_id).toBe(itemId);
    expect(warningEvents[0].payload.aging_score).toBe(78);
    expect(warningEvents[0].payload.recipients).toContain(OWNER_ID);
  });

  it('emits SLABreached event and notifies owner + team lead when item crosses 100% of threshold', async () => {
    // 60 minute SLA policy for Incident in Investigating state
    const policyId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
      VALUES ('${policyId}', '${ORG_ID}', 'incident', 'Investigating', 60, '24x7');
    `);

    // Item entered state 90 minutes ago (150% consumed -> crosses 100%)
    const enteredAt = new Date(Date.now() - 90 * 60 * 1000);
    const itemId = randomUUID();
    await dbService.db.exec(`
      INSERT INTO work_items (id, type, title, status, priority, owner_id, team_id, org_id, entered_state_at)
      VALUES ('${itemId}', 'incident', 'Database Outage', 'Investigating', 'P0', '${OWNER_ID}', '${TEAM_ID}', '${ORG_ID}', '${enteredAt.toISOString()}');
    `);

    // Run aging recompute cycle
    await agingEngine.recomputeAgingForOrg(ORG_ID);

    // Verify SLABreached event was emitted
    const breachEvents = eventBus.emittedEvents.filter(e => e.event_type === 'SLABreached');
    expect(breachEvents.length).toBe(1);
    expect(breachEvents[0].work_item_id).toBe(itemId);
    expect(breachEvents[0].payload.aging_score).toBe(150);
    expect(breachEvents[0].payload.recipients).toContain(OWNER_ID);
    expect(breachEvents[0].payload.recipients).toContain(TEAM_LEAD_ID);
  });
});
