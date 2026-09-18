import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US2.2 — Workflow Guards & Required Fields Enforcement', () => {
  let app: INestApplication;

  const orgId = '88888888-8888-8888-8888-888888888888';
  const teamId = '99999999-9999-9999-9999-999999999999';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // Publish Workflow for incident with guarded and field-requiring transitions
    await request(app.getHttpServer())
      .post('/workflows/definitions')
      .send({
        type: 'incident',
        states: ['triaged', 'investigating', 'mitigated', 'closed'],
        initial_state: 'triaged',
        terminal_states: ['closed'],
        transitions: [
          {
            from: 'triaged',
            to: 'investigating',
            guard: 'incident_commander',
          },
          {
            from: 'investigating',
            to: 'mitigated',
            requires_fields: ['mitigation_summary'],
          },
          {
            from: 'mitigated',
            to: 'closed',
          },
        ],
      })
      .expect(201);
  });

  it('US2.2: rejects transition when actor lacks required role with 409 guard_failed', async () => {
    // 1. Create Incident item (initial status 'triaged')
    const createRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Production Memory Leak',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    const incidentId = createRes.body.id;

    // 2. Attempt transition 'triaged' -> 'investigating' with unauthorized role 'developer'
    const failRes = await request(app.getHttpServer())
      .post(`/workitems/${incidentId}/transitions`)
      .set('x-actor-role', 'developer')
      .send({
        to_state: 'investigating',
      })
      .expect(409);

    expect(failRes.body.error).toBe('guard_failed');
    expect(failRes.body.missing_role).toBe('incident_commander');
    expect(failRes.body.reason).toContain("actor lacks role 'incident_commander'");

    // 3. Attempt transition with authorized role 'incident_commander'
    const successRes = await request(app.getHttpServer())
      .post(`/workitems/${incidentId}/transitions`)
      .set('x-actor-role', 'incident_commander')
      .send({
        to_state: 'investigating',
      })
      .expect(201);

    expect(successRes.body.to_state).toBe('investigating');
    expect(successRes.body.status).toBe('investigating');
  });

  it('US2.2: rejects transition when required fields are missing', async () => {
    // 1. Create Incident item and advance to 'investigating'
    const createRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'API Gateway High Latency',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    const incidentId = createRes.body.id;

    await request(app.getHttpServer())
      .post(`/workitems/${incidentId}/transitions`)
      .set('x-actor-role', 'incident_commander')
      .send({ to_state: 'investigating' })
      .expect(201);

    // 2. Attempt transition 'investigating' -> 'mitigated' WITHOUT 'mitigation_summary'
    const failRes = await request(app.getHttpServer())
      .post(`/workitems/${incidentId}/transitions`)
      .send({
        to_state: 'mitigated',
        fields: {},
      })
      .expect(400);

    expect(failRes.body.error).toBe('missing_required_fields');
    expect(failRes.body.missing_fields).toEqual(['mitigation_summary']);

    // 3. Attempt transition WITH required field 'mitigation_summary' supplied
    const successRes = await request(app.getHttpServer())
      .post(`/workitems/${incidentId}/transitions`)
      .send({
        to_state: 'mitigated',
        fields: {
          mitigation_summary: 'Rolled back deployment v1.4.2 to v1.4.1',
        },
      })
      .expect(201);

    expect(successRes.body.to_state).toBe('mitigated');
    expect(successRes.body.custom_fields.mitigation_summary).toBe(
      'Rolled back deployment v1.4.2 to v1.4.1',
    );
  });
});
