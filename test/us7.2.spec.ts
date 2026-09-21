import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { postMonitoringAndWait } from './integration-webhook-helpers';

describe('US7.2 — Auto-created Incidents are linked to the affected Service', () => {
  let app: INestApplication;
  const orgId = '72000000-0000-0000-0000-000000000001';
  const platformTeamId = '72000000-0000-0000-0000-000000000002';
  const paymentsTeamId = '72000000-0000-0000-0000-000000000003';
  const otherOrgId = '72000000-0000-0000-0000-00000000000f';

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(server())
      .post('/integrations/monitoring/settings')
      .set('x-org-id', orgId)
      .send({ min_severity: 'SEV4', dedupe_window_minutes: 60, default_team_id: platformTeamId })
      .expect(201);
  });

  it('creates an affects edge to the registered Service that owns the alerting host', async () => {
    const service = await request(server())
      .post('/services')
      .set('x-org-id', orgId)
      .send({
        name: 'Payments API',
        service_key: 'payments-api',
        owner_team_id: paymentsTeamId,
        environment: 'production',
        aliases: ['payments-api', 'ip-10-0-3-22'],
      })
      .expect(201);

    expect(service.body).toMatchObject({ service_key: 'SVC-PAYMENTS-API', source: 'internal' });

    const alert = await postMonitoringAndWait(
      server(), orgId, 'us7.2-service-match', {
        provider: 'prometheus',
        event_type: 'alert_fired',
        alert: {
          id: 'payments-5xx-1',
          dedupe_key: 'payments-api-5xx',
          title: 'Payments API 5xx rate above 2%',
          severity: 'sev2',
          host: 'ip-10-0-3-22',
          environment: 'production',
          triggered_at: '2026-09-20T09:00:00.000Z',
        },
      },
    );

    expect(alert.body.outcome).toBe('incident_created');
    expect(alert.body.affected_services).toEqual([
      { service_key: 'SVC-PAYMENTS-API', name: 'Payments API', source: 'internal' },
    ]);

    // Ownership comes from the Service record, not the tenant default team.
    const incident = await request(server())
      .get(`/workitems/${alert.body.incident.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(incident.body.team_id).toBe(paymentsTeamId);

    const evidence = await request(server())
      .get(`/workitems/${alert.body.incident.id}/monitoring-alerts`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(evidence.body.affected_services).toHaveLength(1);
    expect(evidence.body.affected_services[0].service_key).toBe('SVC-PAYMENTS-API');

    // The inverse query is what makes Epic 4 impact analysis work without manual tagging.
    const impact = await request(server())
      .get(`/services/${service.body.id}/work-items`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(impact.body.link_type).toBe('affects');
    expect(impact.body.work_items).toHaveLength(1);
    expect(impact.body.work_items[0]).toMatchObject({
      id: alert.body.incident.id,
      type: 'incident',
      link_type: 'affects',
    });
  });

  it('registers a discovered Service when the alert names one the registry does not hold', async () => {
    const alert = await postMonitoringAndWait(
      server(), orgId, 'us7.2-service-discovered', {
        provider: 'prometheus',
        event_type: 'alert_fired',
        alert: {
          id: 'search-latency-1',
          dedupe_key: 'search-indexer-latency',
          title: 'Search indexer lag above 10 minutes',
          severity: 'sev3',
          service: 'search-indexer',
          environment: 'production',
          triggered_at: '2026-09-20T09:30:00.000Z',
        },
      },
    );

    expect(alert.body.affected_services).toEqual([
      { service_key: 'SVC-SEARCH-INDEXER', name: 'search-indexer', source: 'monitoring_discovery' },
    ]);

    const services = await request(server()).get('/services').set('x-org-id', orgId).expect(200);
    const discovered = services.body.find((entry: any) => entry.service_key === 'SVC-SEARCH-INDEXER');
    expect(discovered).toMatchObject({ source: 'monitoring_discovery', environment: 'production' });
    expect(discovered.description).toContain('pending CMDB reconciliation');

    // Services are supporting entities, not WorkItems; they never reach the delivery board.
    const items = await request(server()).get('/workitems').set('x-org-id', orgId).expect(200);
    expect(items.body.every((item: any) => ['epic', 'story', 'incident', 'release'].includes(item.type))).toBe(true);
    expect(items.body.some((item: any) => item.title === 'search-indexer')).toBe(false);
  });

  it('keeps the Service registry and its affects edges scoped to the owning tenant', async () => {
    const otherTenantServices = await request(server())
      .get('/services')
      .set('x-org-id', otherOrgId)
      .expect(200);
    expect(otherTenantServices.body).toHaveLength(0);

    const services = await request(server()).get('/services').set('x-org-id', orgId).expect(200);
    const paymentsApi = services.body.find((entry: any) => entry.service_key === 'SVC-PAYMENTS-API');

    await request(server())
      .get(`/services/${paymentsApi.id}/work-items`)
      .set('x-org-id', otherOrgId)
      .expect(404);

    await request(server()).get('/services').expect(400);
  });
});
