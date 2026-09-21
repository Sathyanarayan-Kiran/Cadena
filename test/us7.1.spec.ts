import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { postMonitoringAndWait } from './integration-webhook-helpers';

describe('US7.1 — Monitoring alerts auto-create and deduplicate Incidents', () => {
  let app: INestApplication;
  const orgId = '71000000-0000-0000-0000-000000000001';
  const teamId = '71000000-0000-0000-0000-000000000002';
  const otherOrgId = '71000000-0000-0000-0000-00000000000f';

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(server())
      .post('/integrations/monitoring/settings')
      .set('x-org-id', orgId)
      .send({ min_severity: 'SEV3', dedupe_window_minutes: 60, default_team_id: teamId })
      .expect(201);
  });

  it('creates a Triaged Incident with severity mapped from the alert', async () => {
    const response = await postMonitoringAndWait(
      server(), orgId, 'us7.1-fired-1', {
        provider: 'datadog',
        event_type: 'alert_fired',
        alert: {
          id: 'monitor-4821-evt-1',
          dedupe_key: 'checkout-api-latency',
          title: 'Checkout API p99 latency above 2s',
          description: 'p99 latency breached the 2s objective for 5 consecutive minutes.',
          severity: 'critical',
          monitor_name: 'checkout-api-latency-slo',
          url: 'https://app.datadoghq.example/monitors/4821',
          triggered_at: '2026-09-20T09:00:00.000Z',
        },
      },
    );

    expect(response.body.outcome).toBe('incident_created');
    expect(response.body.severity).toMatchObject({
      provider_value: 'critical',
      mapped: 'SEV1',
      priority: 'P0',
      matched: true,
    });
    expect(response.body.incident).toMatchObject({ status: 'Triaged', severity: 'SEV1', created: true });
    expect(response.body.incident.key).toMatch(/^INC-/);
    expect(response.body.occurrences).toBe(1);

    const incident = await request(server())
      .get(`/workitems/${response.body.incident.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(incident.body).toMatchObject({ type: 'incident', status: 'Triaged', severity: 'SEV1', priority: 'P0' });
    expect(incident.body.custom_fields).toMatchObject({
      alert_source: 'datadog',
      alert_dedupe_key: 'checkout-api-latency',
      monitor_name: 'checkout-api-latency-slo',
    });

    // The alert itself stays a provider-owned artifact rather than a canonical WorkItem.
    const allItems = await request(server()).get('/workitems').set('x-org-id', orgId).expect(200);
    expect(allItems.body.filter((item: any) => item.type === 'incident')).toHaveLength(1);
  });

  it('maps each provider severity vocabulary onto the SEV1–SEV4 scale', async () => {
    const cases = [
      { severity: 'error', expected: 'SEV2', priority: 'P1' },
      { severity: 'warning', expected: 'SEV3', priority: 'P2' },
    ];

    for (const [index, testCase] of cases.entries()) {
      const response = await postMonitoringAndWait(
        server(), orgId, `us7.1-severity-${index}`, {
          provider: 'datadog',
          event_type: 'alert_fired',
          alert: {
            id: `severity-probe-${index}`,
            title: `Severity probe ${testCase.severity}`,
            severity: testCase.severity,
            triggered_at: '2026-09-20T09:05:00.000Z',
          },
        },
      );

      expect(response.body.outcome).toBe('incident_created');
      expect(response.body.severity.mapped).toBe(testCase.expected);
      expect(response.body.incident.priority).toBe(testCase.priority);
    }
  });

  it('updates the existing Incident when the same alert refires inside the dedupe window', async () => {
    const first = await postMonitoringAndWait(
      server(), orgId, 'us7.1-dedupe-first', {
        provider: 'datadog',
        event_type: 'alert_fired',
        alert: {
          id: 'queue-depth-evt-1',
          dedupe_key: 'orders-queue-depth',
          title: 'Orders queue depth above threshold',
          severity: 'warning',
          triggered_at: '2026-09-20T10:00:00.000Z',
        },
      },
    );
    expect(first.body.outcome).toBe('incident_created');

    const refire = await postMonitoringAndWait(
      server(), orgId, 'us7.1-dedupe-refire', {
        provider: 'datadog',
        event_type: 'alert_fired',
        alert: {
          id: 'queue-depth-evt-2',
          dedupe_key: 'orders-queue-depth',
          title: 'Orders queue depth above threshold',
          severity: 'critical',
          triggered_at: '2026-09-20T10:20:00.000Z',
        },
      },
    );

    expect(refire.body.outcome).toBe('incident_deduplicated');
    expect(refire.body.incident.id).toBe(first.body.incident.id);
    expect(refire.body.occurrences).toBe(2);

    // A worse recurrence escalates the open Incident instead of opening a second one.
    const incident = await request(server())
      .get(`/workitems/${first.body.incident.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(incident.body.severity).toBe('SEV1');

    const incidents = await request(server())
      .get('/workitems?type=incident')
      .set('x-org-id', orgId)
      .expect(200);
    expect(incidents.body.filter((item: any) => item.custom_fields?.alert_dedupe_key === 'orders-queue-depth'))
      .toHaveLength(1);
  });

  it('opens a new Incident when the same alert returns outside the dedupe window', async () => {
    const recurrence = await postMonitoringAndWait(
      server(), orgId, 'us7.1-dedupe-window-expired', {
        provider: 'datadog',
        event_type: 'alert_fired',
        alert: {
          id: 'queue-depth-evt-3',
          dedupe_key: 'orders-queue-depth',
          title: 'Orders queue depth above threshold',
          severity: 'warning',
          triggered_at: '2026-09-20T14:00:00.000Z',
        },
      },
    );

    expect(recurrence.body.outcome).toBe('incident_created');
    const incidents = await request(server())
      .get('/workitems?type=incident')
      .set('x-org-id', orgId)
      .expect(200);
    expect(incidents.body.filter((item: any) => item.custom_fields?.alert_dedupe_key === 'orders-queue-depth'))
      .toHaveLength(2);
  });

  it('records but suppresses alerts below the configured severity threshold', async () => {
    const response = await postMonitoringAndWait(
      server(), orgId, 'us7.1-below-threshold', {
        provider: 'datadog',
        event_type: 'alert_fired',
        alert: {
          id: 'informational-probe',
          title: 'Nightly batch finished',
          severity: 'info',
          triggered_at: '2026-09-20T11:00:00.000Z',
        },
      },
    );

    expect(response.body.outcome).toBe('suppressed_below_threshold');
    expect(response.body.severity.mapped).toBe('SEV4');
    expect(response.body.incident).toBeNull();
    expect(response.body.alert_artifact_id).toBeTruthy();
    expect(response.body.reason).toContain('below the configured SEV3 threshold');
  });

  it('replays a duplicate delivery without creating a second Incident', async () => {
    const payload = {
      provider: 'datadog',
      event_type: 'alert_fired',
      alert: {
        id: 'replay-probe',
        dedupe_key: 'payments-error-rate',
        title: 'Payments error rate above 5%',
        severity: 'sev2',
        triggered_at: '2026-09-20T12:00:00.000Z',
      },
    };

    const first = await postMonitoringAndWait(
      server(), orgId, 'us7.1-replay', payload,
    );
    expect(first.body.duplicate).toBe(false);

    const replay = await postMonitoringAndWait(
      server(), orgId, 'us7.1-replay', payload,
    );

    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.incident.id).toBe(first.body.incident.id);
    expect(replay.body.occurrences).toBe(1);
  });

  it('rejects an invalid payload with an actionable error and keeps tenants isolated', async () => {
    const missingTitle = await request(server())
      .post('/integrations/monitoring/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', 'us7.1-invalid-title')
      .send({ provider: 'datadog', event_type: 'alert_fired', alert: { id: 'no-title' } })
      .expect(422);
    expect(missingTitle.body).toMatchObject({ error: 'invalid_monitoring_payload' });
    expect(missingTitle.body.message).toContain('alert.title is required');

    const badEvent = await request(server())
      .post('/integrations/monitoring/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', 'us7.1-invalid-event')
      .send({ provider: 'datadog', event_type: 'alert_exploded', alert: { id: 'x', title: 'x' } })
      .expect(422);
    expect(badEvent.body.message).toContain('alert_fired, alert_resolved');

    await request(server())
      .post('/integrations/monitoring/webhooks')
      .set('x-delivery-id', 'us7.1-missing-org')
      .send({ provider: 'datadog', event_type: 'alert_fired', alert: { id: 'x', title: 'x' } })
      .expect(400);

    // Incidents created for this tenant must not be visible to another tenant.
    const otherTenant = await request(server())
      .get('/workitems?type=incident')
      .set('x-org-id', otherOrgId)
      .expect(200);
    expect(otherTenant.body).toHaveLength(0);
  });
});
