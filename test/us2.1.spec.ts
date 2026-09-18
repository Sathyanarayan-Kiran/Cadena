import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US2.1 — Workflow & State Machine Engine (Definitions & Versioning)', () => {
  let app: INestApplication;

  const orgId = '66666666-6666-6666-6666-666666666666';
  const teamId = '77777777-7777-7777-7777-777777777777';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('US2.1: publishes workflow definition and preserves in-flight item versions', async () => {
    // 1. Publish Workflow Definition v1 for `story`
    const pubV1 = await request(app.getHttpServer())
      .post('/workflows/definitions')
      .send({
        type: 'story',
        states: ['Draft', 'InReview', 'Done'],
        initial_state: 'Draft',
        terminal_states: ['Done'],
        transitions: [
          { from: 'Draft', to: 'InReview' },
          { from: 'InReview', to: 'Done' },
        ],
      })
      .expect(201);

    expect(pubV1.body.version).toBe(1);

    // 2. Create Story Item 1 (should inherit v1 definition)
    const itemV1Res = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story Item 1 under v1',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    expect(itemV1Res.body.workflow_version).toBe(1);
    expect(itemV1Res.body.status).toBe('Draft');

    // 3. Publish Workflow Definition v2 for `story` with a new initial state 'Triage'
    const pubV2 = await request(app.getHttpServer())
      .post('/workflows/definitions')
      .send({
        type: 'story',
        states: ['Triage', 'Draft', 'InReview', 'Done'],
        initial_state: 'Triage',
        terminal_states: ['Done'],
        transitions: [
          { from: 'Triage', to: 'Draft' },
          { from: 'Draft', to: 'InReview' },
          { from: 'InReview', to: 'Done' },
        ],
      })
      .expect(201);

    expect(pubV2.body.version).toBe(2);

    // 4. Create Story Item 2 (should inherit v2 definition)
    const itemV2Res = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story Item 2 under v2',
        team_id: teamId,
        org_id: orgId,
      })
      .expect(201);

    expect(itemV2Res.body.workflow_version).toBe(2);
    expect(itemV2Res.body.status).toBe('Triage');

    // 5. Verify Item 1 preserves workflow_version = 1
    const fetchItemV1 = await request(app.getHttpServer())
      .get('/workitems')
      .set('x-org-id', orgId)
      .expect(200);

    const legacyItem = fetchItemV1.body.find((i: any) => i.id === itemV1Res.body.id);
    expect(legacyItem.workflow_version).toBe(1);
    expect(legacyItem.status).toBe('Draft');
  });

  it('US2.1: rejects invalid workflow definition with specific validation error', async () => {
    // 1. Definition with missing terminal state
    const missingTerminalRes = await request(app.getHttpServer())
      .post('/workflows/definitions')
      .send({
        type: 'story',
        states: ['Draft', 'InProgress'],
        initial_state: 'Draft',
        terminal_states: [],
        transitions: [{ from: 'Draft', to: 'InProgress' }],
      })
      .expect(400);

    expect(missingTerminalRes.body.message).toContain('missing terminal state');

    // 2. Definition with unreachable state
    const unreachableRes = await request(app.getHttpServer())
      .post('/workflows/definitions')
      .send({
        type: 'incident',
        states: ['Triaged', 'Investigating', 'OrphanState', 'Closed'],
        initial_state: 'Triaged',
        terminal_states: ['Closed'],
        transitions: [
          { from: 'Triaged', to: 'Investigating' },
          { from: 'Investigating', to: 'Closed' },
        ],
      })
      .expect(400);

    expect(unreachableRes.body.message).toContain('unreachable state');
    expect(unreachableRes.body.errors).toContain('unreachable state(s) detected: OrphanState');
  });
});
