import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { InProcessEventBus } from '../src/modules/events/event-bus';
import { EventConsumerRegistry } from '../src/modules/events/consumer-registry.service';
import { AgingEngineService } from '../src/modules/sla/aging-engine.service';
import { SlaCalculatorService } from '../src/modules/sla/sla-calculator.service';
import {
  PILOT_ORG_ID,
  PILOT_PEOPLE,
  PILOT_TEAM_ID,
  seedPilotConfiguration,
} from '../src/bootstrap/pilot-configuration';

/**
 * Regressions for defects found in external review of ebc53c2.
 *
 * Each test fails against the code as it stood at that commit. They live together because
 * they share an origin rather than a feature: three of the four were reachable only once
 * the datastore began persisting, which is the kind of interaction a per-story suite misses.
 */
describe('Review regressions', () => {
  let app: INestApplication;
  const tenantA = '99100000-0000-0000-0000-00000000000a';
  const tenantB = '99100000-0000-0000-0000-00000000000b';
  const teamId = '99100000-0000-0000-0000-000000000002';
  const ownerId = '99100000-0000-0000-0000-000000000003';

  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    for (const org of [tenantA, tenantB]) {
      await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Review org') ON CONFLICT DO NOTHING`, [org]);
    }
    await db().query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Review team') ON CONFLICT DO NOTHING`,
      [teamId, tenantA],
    );
    await db().query(
      `INSERT INTO people (id, org_id, team_id, name, email, role)
       VALUES ($1, $2, $3, 'Rea Viewer', 'rea@example.test', 'developer') ON CONFLICT DO NOTHING`,
      [ownerId, tenantA, teamId],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    new EventConsumerRegistry().register({
      name: 'review-failing-consumer',
      eventTypes: ['ReviewProbeEvent'],
      maxAttempts: 1,
      retryDelayMs: 1,
      handle: () => { throw new Error('always fails'); },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('Finding 1 — dead-letter entries are tenant-isolated', () => {
    let entryId: string;

    beforeAll(async () => {
      await InProcessEventBus.getInstance().publish(
        'ReviewProbeEvent',
        randomUUID(),
        { type: 'system', id: 'review' },
        { org_id: tenantA, secret: 'tenant A payload' },
      );
      const list = await request(server()).get('/dlq').set('x-org-id', tenantA).expect(200);
      entryId = list.body[0].id;
      expect(entryId).toBeTruthy();
    });

    it('does not let another tenant read an entry by id', async () => {
      await request(server()).get(`/dlq/${entryId}`).set('x-org-id', tenantA).expect(200);
      // Not found rather than forbidden: a caller must not be able to probe for the
      // existence of another tenant's failures.
      await request(server()).get(`/dlq/${entryId}`).set('x-org-id', tenantB).expect(404);
    });

    it('does not let another tenant replay or edit an entry', async () => {
      await request(server())
        .post(`/dlq/${entryId}/replay`)
        .set('x-org-id', tenantB)
        .send({ payload: { org_id: tenantB, injected: true } })
        .expect(404);

      // The payload must be untouched by the rejected attempt.
      const still = await request(server()).get(`/dlq/${entryId}`).set('x-org-id', tenantA).expect(200);
      expect(still.body.envelope.payload).toMatchObject({ secret: 'tenant A payload' });
      expect(still.body.envelope.payload.injected).toBeUndefined();
    });

    it('does not let another tenant discard an entry', async () => {
      await request(server())
        .post(`/dlq/${entryId}/discard`)
        .set('x-org-id', tenantB)
        .send({ reason: 'not mine to discard' })
        .expect(404);

      const still = await request(server()).get(`/dlq/${entryId}`).set('x-org-id', tenantA).expect(200);
      expect(still.body.status).toBe('dead');
    });

    it('keeps depth and listings scoped without exposing global failure metadata', async () => {
      const other = await request(server()).get('/dlq').set('x-org-id', tenantB).expect(200);
      expect(other.body).toHaveLength(0);

      const depth = await request(server()).get('/dlq/depth').set('x-org-id', tenantA).expect(200);
      expect(depth.body.by_consumer['review-failing-consumer']).toBeGreaterThan(0);
      const otherDepth = await request(server()).get('/dlq/depth').set('x-org-id', tenantB).expect(200);
      expect(otherDepth.body).toMatchObject({ total: 0, by_consumer: {}, alerting: false });
      expect(otherDepth.body).not.toHaveProperty('untenanted_total');
    });
  });

  describe('Finding 2b — an untenanted dead letter is logged rather than silent', () => {
    it('warns when a dead-lettered event has no resolvable tenant', async () => {
      // No org_id in the payload and a work_item_id that matches no work item, so neither
      // resolution path finds a tenant. Such an entry is deliberately absent from every
      // tenant-scoped view, which is precisely why it must not also be silent.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await InProcessEventBus.getInstance().publish(
          'ReviewProbeEvent',
          randomUUID(),
          { type: 'system', id: 'review' },
          { note: 'no tenant anywhere in this payload' },
        );

        const warned = warn.mock.calls.map((args) => String(args[0])).join(' | ');
        expect(warned).toContain('no resolvable tenant');
        expect(warned).toContain('review-failing-consumer');
      } finally {
        warn.mockRestore();
      }

      // It is still absent from both tenants' views, as designed.
      for (const tenant of [tenantA, tenantB]) {
        const list = await request(server()).get('/dlq').set('x-org-id', tenant).expect(200);
        expect(list.body.some((e: any) => e.org_id === null)).toBe(false);
      }
    });
  });

  describe('Finding 4 — SLA emission suppression survives a restart', () => {
    it('does not re-emit for a state entry already recorded', async () => {
      const aging = new AgingEngineService(new SlaCalculatorService());

      await request(server())
        .post('/sla-policies')
        .set('x-org-id', tenantA)
        .send({ item_type: 'story', state: 'In Review', threshold_minutes: 60, calendar: '24x7' })
        .expect(201);

      const story = await request(server())
        .post('/workitems')
        .set('x-org-id', tenantA)
        .send({ type: 'story', title: 'Aged past warning', team_id: teamId, org_id: tenantA, owner_id: ownerId })
        .expect(201);
      for (const state of ['Planned', 'In Progress', 'In Review']) {
        await request(server())
          .post(`/workitems/${story.body.id}/transitions`)
          .set('x-org-id', tenantA)
          .send({ to_state: state })
          .expect(201);
      }
      await db().query(
        `UPDATE work_items SET entered_state_at = $1 WHERE id = $2`,
        [new Date(Date.now() - 50 * 60 * 1000).toISOString(), story.body.id],
      );

      const first = await aging.recomputeAgingForOrg(tenantA);
      expect(first.warningCount).toBeGreaterThanOrEqual(1);

      // A fresh engine stands in for a restarted process: the previous instance's
      // in-memory suppression is gone, but the recorded emission is not.
      const afterRestart = new AgingEngineService(new SlaCalculatorService());
      const second = await afterRestart.recomputeAgingForOrg(tenantA);
      expect(second.warningCount).toBe(0);

      const notifications = await request(server())
        .get(`/notifications?work_item_id=${story.body.id}&event_type=SLAWarning`)
        .set('x-org-id', tenantA)
        .expect(200);
      expect(notifications.body).toHaveLength(1);

      const emissions = await db().query<any>(
        `SELECT kind FROM sla_emissions WHERE work_item_id = $1`,
        [story.body.id],
      );
      expect(emissions.rows.map((r: any) => r.kind)).toContain('warning');
    });
  });

  describe('Finding 2 — pilot defaults never overwrite persisted configuration', () => {
    it('keeps customised preferences, escalation, monitoring and service metadata', async () => {
      await db().query(
        `INSERT INTO orgs (id, name) VALUES ($1, 'Primary Pilot Org') ON CONFLICT DO NOTHING`,
        [PILOT_ORG_ID],
      );
      await db().query(
        `INSERT INTO teams (id, org_id, name)
         VALUES ($1, $2, 'Platform Team') ON CONFLICT DO NOTHING`,
        [PILOT_TEAM_ID, PILOT_ORG_ID],
      );
      await seedPilotConfiguration();

      await db().query(
        `UPDATE notification_preferences
         SET channel = 'teams', address = 'custom-address'
         WHERE person_id = $1`,
        [PILOT_PEOPLE[0].id],
      );
      await db().query(
        `UPDATE team_escalation_targets SET escalation_person_id = $1 WHERE team_id = $2`,
        [PILOT_PEOPLE[1].id, PILOT_TEAM_ID],
      );
      await db().query(
        `UPDATE monitoring_settings
         SET min_severity = 'SEV1', dedupe_window_minutes = 5,
             automation_actor_role = 'incident_commander', auto_register_services = FALSE
         WHERE org_id = $1`,
        [PILOT_ORG_ID],
      );
      await db().query(
        `UPDATE services
         SET name = 'Curated Checkout', source = 'cmdb', environment = 'staging'
         WHERE org_id = $1 AND service_key = 'SVC-CHECKOUT-API'`,
        [PILOT_ORG_ID],
      );

      // This is the operation performed on every persistent server restart.
      await seedPilotConfiguration();

      const preference = await db().query<any>(
        `SELECT channel, address FROM notification_preferences WHERE person_id = $1`,
        [PILOT_PEOPLE[0].id],
      );
      expect(preference.rows[0]).toMatchObject({ channel: 'teams', address: 'custom-address' });

      const escalation = await db().query<any>(
        `SELECT escalation_person_id FROM team_escalation_targets WHERE team_id = $1`,
        [PILOT_TEAM_ID],
      );
      expect(escalation.rows[0].escalation_person_id).toBe(PILOT_PEOPLE[1].id);

      const monitoring = await db().query<any>(
        `SELECT min_severity, dedupe_window_minutes, automation_actor_role, auto_register_services
         FROM monitoring_settings WHERE org_id = $1`,
        [PILOT_ORG_ID],
      );
      expect(monitoring.rows[0]).toMatchObject({
        min_severity: 'SEV1',
        dedupe_window_minutes: 5,
        automation_actor_role: 'incident_commander',
        auto_register_services: false,
      });

      const service = await db().query<any>(
        `SELECT name, source, environment FROM services
         WHERE org_id = $1 AND service_key = 'SVC-CHECKOUT-API'`,
        [PILOT_ORG_ID],
      );
      expect(service.rows[0]).toMatchObject({
        name: 'Curated Checkout',
        source: 'cmdb',
        environment: 'staging',
      });

      const counts = await db().query<any>(
        `SELECT
           (SELECT COUNT(*)::int FROM people WHERE org_id = $1) AS people,
           (SELECT COUNT(*)::int FROM services WHERE org_id = $1) AS services`,
        [PILOT_ORG_ID],
      );
      expect(counts.rows[0]).toMatchObject({ people: 3, services: 2 });
    });
  });
});
