import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { RbacService } from '../src/modules/rbac/rbac.service';

describe('US10.3 — RBAC Transition Gating & User Role Resolution', () => {
  let app: INestApplication;

  const orgId = '10101010-1010-1010-1010-101010101010';
  const teamId = '20202020-2020-2020-2020-202020202020';
  const devActorId = '30303030-3030-3030-3030-303030303030';
  const icActorId = '40404040-4040-4040-4040-404040404040';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    // Create org and team references
    const db = DatabaseService.getInstance().db;
    await db.query(`INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [orgId, 'Test Org']);
    await db.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [teamId, orgId, 'Ops Team']);

    // Seed people with distinct roles
    const rbacService = new RbacService();
    await rbacService.createPerson({
      id: devActorId,
      org_id: orgId,
      team_id: teamId,
      name: 'Alice Developer',
      email: 'alice@company.com',
      role: 'developer',
    });

    await rbacService.createPerson({
      id: icActorId,
      org_id: orgId,
      team_id: teamId,
      name: 'Bob Commander',
      email: 'bob@company.com',
      role: 'incident_commander',
    });

    // Publish Workflow for incident with role guard on transition to 'resolved'
    await request(app.getHttpServer())
      .post('/workflows/definitions')
      .send({
        type: 'incident',
        states: ['Triaged', 'Investigating', 'Resolved', 'Closed'],
        initial_state: 'Triaged',
        terminal_states: ['Closed'],
        transitions: [
          { from: 'Triaged', to: 'Investigating' },
          { from: 'Investigating', to: 'Resolved', guard: 'incident_commander' },
          { from: 'Resolved', to: 'Closed' },
        ],
      })
      .expect(201);
  });

  it('US10.3: rejects transition when actor role lacks permission', async () => {
    // 1. Create Incident item
    const incRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Payment Gateway Down',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    const incId = incRes.body.id;

    // Advance to Investigating
    await request(app.getHttpServer())
      .post(`/workitems/${incId}/transitions`)
      .send({ to_state: 'Investigating' })
      .expect(201);

    // 2. Attempt transition to 'Resolved' as Alice (developer) via x-actor-id header
    const failRes = await request(app.getHttpServer())
      .post(`/workitems/${incId}/transitions`)
      .set('x-actor-id', devActorId)
      .send({ to_state: 'Resolved' })
      .expect(409);

    expect(failRes.body.error).toBe('guard_failed');
    expect(failRes.body.missing_role).toBe('incident_commander');

    // 3. Attempt transition to 'Resolved' as Bob (incident_commander) via x-actor-id header
    const successRes = await request(app.getHttpServer())
      .post(`/workitems/${incId}/transitions`)
      .set('x-actor-id', icActorId)
      .send({ to_state: 'Resolved' })
      .expect(201);

    expect(successRes.body.to_state).toBe('Resolved');
    expect(successRes.body.status).toBe('Resolved');
  });
});
