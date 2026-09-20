import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US1.1 — Canonical WorkItem Schema', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('US1.1: creates work item with valid type and default status', async () => {
    // 1. Create a Story work item
    const storyRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Implement User Login',
        team_id: '00000000-0000-0000-0000-000000000001',
        org_id: '00000000-0000-0000-0000-000000000099',
      })
      .expect(201);

    expect(storyRes.body).toHaveProperty('id');
    expect(storyRes.body.type).toBe('story');
    expect(storyRes.body.title).toBe('Implement User Login');
    expect(storyRes.body.status).toBe('Proposed');

    // 2. Create an Incident work item
    const incidentRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Database Outage in EU Region',
        team_id: '00000000-0000-0000-0000-000000000002',
        org_id: '00000000-0000-0000-0000-000000000099',
      })
      .expect(201);

    expect(incidentRes.body).toHaveProperty('id');
    expect(incidentRes.body.type).toBe('incident');
    expect(incidentRes.body.title).toBe('Database Outage in EU Region');
    expect(incidentRes.body.status).toBe('Triaged');
  });

  it('US1.1: rejects unrecognized type with 422', async () => {
    const res = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'feature_request_invalid',
        title: 'Unsupported Type Test',
        team_id: '00000000-0000-0000-0000-000000000001',
        org_id: '00000000-0000-0000-0000-000000000099',
      })
      .expect(422);

    expect(res.body.statusCode).toBe(422);
    expect(res.body.valid_types).toEqual(['epic', 'story', 'incident', 'release']);
    expect(res.body.message).toContain('Unrecognized work item type');
  });
});
