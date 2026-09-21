import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US9.2 — cross-team executive rollup', () => {
  let app: INestApplication;
  const orgId = '92000000-0000-0000-0000-000000000001';
  const otherOrgId = '92000000-0000-0000-0000-00000000000f';
  const alpha = '92000000-0000-0000-0000-000000000002';
  const beta = '92000000-0000-0000-0000-000000000003';
  const support = '92000000-0000-0000-0000-000000000004';
  const enablement = '92000000-0000-0000-0000-000000000005';
  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Executive org') ON CONFLICT DO NOTHING`, [orgId]);
    await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Other org') ON CONFLICT DO NOTHING`, [otherOrgId]);
    for (const [id, name, unit] of [
      [alpha, 'Alpha', 'Engineering'],
      [beta, 'Beta', 'Engineering'],
      [support, 'Support', 'Customer Operations'],
      [enablement, 'Enablement', 'Operations Enablement'],
    ]) {
      await db().query(
        `INSERT INTO teams (id, org_id, name, business_unit) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [id, orgId, name, unit],
      );
    }
    const otherTeam = '92000000-0000-0000-0000-0000000000ff';
    await db().query(
      `INSERT INTO teams (id, org_id, name, business_unit)
       VALUES ($1, $2, 'Other team', 'Other unit') ON CONFLICT DO NOTHING`,
      [otherTeam, otherOrgId],
    );

    await db().query(
      `INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
       VALUES ($1, $2, 'story', 'In Review', 100, '24x7')
       ON CONFLICT (org_id, item_type, state) DO NOTHING`,
      [randomUUID(), orgId],
    );

    const completedAt = new Date('2026-09-21T12:00:00.000Z');
    const items = [
      { team: alpha, title: 'Alpha completed', bucket: 'green', score: 50, created: new Date(completedAt.getTime() - 48 * 3_600_000), completed: true },
      { team: beta, title: 'Beta breached', bucket: 'red', score: 125, created: new Date(completedAt.getTime() - 12 * 3_600_000), completed: false },
      { team: support, title: 'Support completed', bucket: 'amber', score: 90, created: new Date(completedAt.getTime() - 24 * 3_600_000), completed: true },
    ];
    for (const item of items) {
      const id = randomUUID();
      await db().query(
        `INSERT INTO work_items
           (id, item_key, type, title, status, priority, team_id, org_id, entered_state_at,
            aging_bucket, aging_score, created_at, updated_at)
         VALUES ($1, $2, 'story', $3, 'In Review', 'P1', $4, $5, $6, $7, $8, $6, $6)`,
        [
          id,
          `STORY-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
          item.title,
          item.team,
          orgId,
          item.created.toISOString(),
          item.bucket,
          item.score,
        ],
      );
      if (item.completed) {
        await db().query(
          `INSERT INTO audit_events (id, event_type, work_item_id, actor_id, payload, timestamp)
           VALUES ($1, 'WorkItemStateChanged', $2, 'metrics-fixture', $3, $4)`,
          [randomUUID(), id, JSON.stringify({ from_state: 'In Review', to_state: 'Done' }), completedAt.toISOString()],
        );
      }
    }

    const otherItem = randomUUID();
    await db().query(
      `INSERT INTO work_items
         (id, item_key, type, title, status, priority, team_id, org_id, aging_bucket, aging_score)
       VALUES ($1, $2, 'story', 'Other tenant item', 'In Review', 'P1', $3, $4, 'red', 500)`,
      [otherItem, `STORY-${otherItem.replace(/-/g, '').slice(0, 8).toUpperCase()}`, otherTeam, otherOrgId],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports SLA compliance, cycle time and aging distribution per team', async () => {
    const response = await request(server()).get('/metrics/executive').set('x-org-id', orgId).expect(200);
    expect(response.body.teams).toHaveLength(4);

    const byName = Object.fromEntries(response.body.teams.map((team: any) => [team.team_name, team]));
    expect(byName.Alpha).toMatchObject({
      business_unit: 'Engineering', total_items: 1, governed_items: 1,
      sla_compliance_percent: 100, average_cycle_time_hours: 48,
      aging_distribution: { green: 1, amber: 0, red: 0 },
    });
    expect(byName.Beta).toMatchObject({
      business_unit: 'Engineering', total_items: 1, governed_items: 1,
      sla_compliance_percent: 0, average_cycle_time_hours: null,
      aging_distribution: { green: 0, amber: 0, red: 1 },
    });
    expect(byName.Support).toMatchObject({
      business_unit: 'Customer Operations', total_items: 1, governed_items: 1,
      sla_compliance_percent: 100, average_cycle_time_hours: 24,
      aging_distribution: { green: 0, amber: 1, red: 0 },
    });
    expect(byName.Enablement).toMatchObject({
      business_unit: 'Operations Enablement', total_items: 0, governed_items: 0,
      sla_compliance_percent: null, average_cycle_time_hours: null,
      aging_distribution: { green: 0, amber: 0, red: 0 },
    });
  });

  it('rolls teams into business units and an auditable overall figure', async () => {
    const response = await request(server()).get('/metrics/executive').set('x-org-id', orgId).expect(200);
    const units = Object.fromEntries(response.body.business_units.map((unit: any) => [unit.business_unit, unit]));

    expect(units.Engineering).toMatchObject({
      total_items: 2,
      governed_items: 2,
      sla_compliance_percent: 50,
      aging_distribution: { green: 1, amber: 0, red: 1 },
    });
    expect(units['Operations Enablement']).toMatchObject({
      total_items: 0,
      governed_items: 0,
      sla_compliance_percent: null,
      aging_distribution: { green: 0, amber: 0, red: 0 },
    });
    expect(response.body.overall).toMatchObject({
      total_items: 3,
      governed_items: 3,
      sla_compliance_percent: 66.7,
      average_cycle_time_hours: 36,
      completed_items: 2,
      aging_distribution: { green: 1, amber: 1, red: 1 },
    });
    expect(response.body.coverage.cycle_time_items).toBe(2);
    expect(response.body.coverage.note).toContain('recorded transition');
  });

  it('never includes another tenant and still requires a tenant context', async () => {
    const response = await request(server()).get('/metrics/executive').set('x-org-id', otherOrgId).expect(200);
    expect(response.body.overall.total_items).toBe(1);
    expect(response.body.teams.map((team: any) => team.team_name)).toEqual(['Other team']);
    await request(server()).get('/metrics/executive').expect(400);
  });
});
