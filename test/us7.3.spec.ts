import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { InProcessEventBus } from '../src/modules/events/event-bus';
import { postMonitoringAndWait } from './integration-webhook-helpers';

describe('US7.3 — A resolved alert proposes mitigation without closing the Incident', () => {
  let app: INestApplication;
  const orgId = '73000000-0000-0000-0000-000000000001';
  const teamId = '73000000-0000-0000-0000-000000000002';

  const server = () => app.getHttpServer();

  async function fireAlert(deliveryId: string, dedupeKey: string, triggeredAt: string) {
    return postMonitoringAndWait(server(), orgId, deliveryId, {
        provider: 'pagerduty',
        event_type: 'alert_fired',
        alert: {
          id: `${dedupeKey}-fired`,
          dedupe_key: dedupeKey,
          title: 'Cart service unavailable in eu-west-1',
          severity: 'critical',
          monitor_name: 'cart-availability',
          triggered_at: triggeredAt,
        },
      });
  }

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(server())
      .post('/integrations/monitoring/settings')
      .set('x-org-id', orgId)
      .send({ min_severity: 'SEV4', dedupe_window_minutes: 120, default_team_id: teamId })
      .expect(201);
  });

  it('moves the linked Incident to Mitigated and never to Resolved or Closed', async () => {
    const fired = await fireAlert('us7.3-fired', 'cart-availability', '2026-09-20T09:00:00.000Z');
    expect(fired.body.incident.status).toBe('Triaged');

    InProcessEventBus.getInstance().clearEmittedEvents();

    const resolved = await postMonitoringAndWait(
      server(), orgId, 'us7.3-resolved', {
        provider: 'pagerduty',
        event_type: 'alert_resolved',
        alert: {
          id: 'cart-availability-resolved',
          dedupe_key: 'cart-availability',
          title: 'Cart service unavailable in eu-west-1',
          severity: 'critical',
          resolved_at: '2026-09-20T09:42:00.000Z',
        },
      },
    );

    expect(resolved.body.outcome).toBe('mitigation_proposed');
    expect(resolved.body.incident.status).toBe('Mitigated');

    // The walk to Mitigated goes through the real workflow, one guarded step at a time.
    expect(resolved.body.transitions.map((transition: any) => [transition.to_state, transition.outcome]))
      .toEqual([['Investigating', 'applied'], ['Mitigated', 'applied']]);

    const incident = await request(server())
      .get(`/workitems/${fired.body.incident.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(incident.body.status).toBe('Mitigated');
    expect(incident.body.status).not.toBe('Resolved');
    expect(incident.body.status).not.toBe('Closed');
    expect(incident.body.custom_fields.mitigation_summary).toContain('Awaiting human confirmation');

    const events = InProcessEventBus.getInstance().emittedEvents;
    const proposal = events.find((event) => event.event_type === 'IncidentMitigationProposed');
    expect(proposal?.payload).toMatchObject({
      to_state: 'Mitigated',
      applied: true,
      awaiting_human_confirmation: true,
    });

    // Confirmation past Mitigated remains a guarded human action.
    const withoutRole = await request(server())
      .post(`/workitems/${fired.body.incident.id}/transitions`)
      .set('x-org-id', orgId)
      .set('x-actor-role', 'developer')
      .send({ to_state: 'Resolved' })
      .expect(409);
    expect(withoutRole.body).toMatchObject({ error: 'guard_failed', missing_role: 'incident_commander' });

    await request(server())
      .post(`/workitems/${fired.body.incident.id}/transitions`)
      .set('x-org-id', orgId)
      .set('x-actor-role', 'incident_commander')
      .send({ to_state: 'Resolved' })
      .expect(201);
  });

  it('records the resolution as skipped when the configured automation role fails the guard', async () => {
    await request(server())
      .post('/integrations/monitoring/settings')
      .set('x-org-id', orgId)
      .send({ automation_actor_role: 'observer' })
      .expect(201);

    const fired = await fireAlert('us7.3-guarded-fired', 'checkout-availability', '2026-09-20T11:00:00.000Z');

    const resolved = await postMonitoringAndWait(
      server(), orgId, 'us7.3-guarded-resolved', {
        provider: 'pagerduty',
        event_type: 'alert_resolved',
        alert: {
          id: 'checkout-availability-resolved',
          dedupe_key: 'checkout-availability',
          title: 'Cart service unavailable in eu-west-1',
          severity: 'critical',
          resolved_at: '2026-09-20T11:30:00.000Z',
        },
      },
    );

    expect(resolved.body.transitions).toHaveLength(1);
    expect(resolved.body.transitions[0]).toMatchObject({ to_state: 'Investigating', outcome: 'skipped' });
    expect(resolved.body.transitions[0].reason).toContain('on_call or incident_commander');

    const incident = await request(server())
      .get(`/workitems/${fired.body.incident.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(incident.body.status).toBe('Triaged');

    await request(server())
      .post('/integrations/monitoring/settings')
      .set('x-org-id', orgId)
      .send({ automation_actor_role: 'on_call' })
      .expect(201);
  });

  it('records a resolution with no linked Incident as evidence only', async () => {
    const response = await postMonitoringAndWait(
      server(), orgId, 'us7.3-orphan-resolution', {
        provider: 'pagerduty',
        event_type: 'alert_resolved',
        alert: {
          id: 'never-fired-here',
          dedupe_key: 'never-fired-here',
          title: 'Alert that this tenant never received',
          resolved_at: '2026-09-20T12:00:00.000Z',
        },
      },
    );

    expect(response.body.outcome).toBe('no_linked_incident');
    expect(response.body.incident).toBeNull();
    expect(response.body.transitions).toEqual([]);
    expect(response.body.alert_artifact_id).toBeTruthy();
  });

  it('exposes queryable alert evidence from the Incident', async () => {
    const fired = await fireAlert('us7.3-evidence-fired', 'sessions-error-rate', '2026-09-20T13:00:00.000Z');
    await fireAlert('us7.3-evidence-refire', 'sessions-error-rate', '2026-09-20T13:20:00.000Z');

    const evidence = await request(server())
      .get(`/workitems/${fired.body.incident.id}/monitoring-alerts`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(evidence.body.alerts).toHaveLength(1);
    expect(evidence.body.alerts[0]).toMatchObject({
      provider: 'pagerduty',
      dedupe_key: 'sessions-error-rate',
      severity: 'SEV1',
      provider_severity: 'critical',
      occurrences: 2,
      status: 'firing',
      monitor_name: 'cart-availability',
    });
    expect(evidence.body.alerts[0].first_seen).toBe('2026-09-20T13:00:00.000Z');
    expect(evidence.body.alerts[0].last_seen).toBe('2026-09-20T13:20:00.000Z');

    // The same evidence is reachable through the shared external-artifact contract.
    const externalLinks = await request(server())
      .get(`/workitems/${fired.body.incident.id}/external-links`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(externalLinks.body[0]).toMatchObject({ artifact_type: 'alert', link_type: 'detected_by' });
  });
});
