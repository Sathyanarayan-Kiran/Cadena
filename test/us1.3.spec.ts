import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US1.3 — Custom Fields JSON Schema Validation & Defaults', () => {
  let app: INestApplication;

  const orgId = '44444444-4444-4444-4444-444444444444';
  const teamId = '55555555-5555-5555-5555-555555555555';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('US1.3: validates custom fields against registered JSON schema', async () => {
    // 1. Register a custom field JSON schema for `story` requiring story_points to be an integer >= 1
    await request(app.getHttpServer())
      .post('/workitems/custom-fields/schemas')
      .send({
        type: 'story',
        schema: {
          type: 'object',
          properties: {
            story_points: { type: 'integer', minimum: 1 },
            sprint: { type: 'string' },
          },
          required: ['story_points'],
          additionalProperties: true,
        },
        defaults: { story_points: 1, sprint: 'Backlog' },
      })
      .expect(201);

    // 2. Attempt to create a Story with invalid custom_fields (story_points as string "invalid")
    const invalidRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story Invalid Custom Fields',
        team_id: teamId,
        org_id: orgId,
        custom_fields: { story_points: 'invalid_string' },
      })
      .expect(422);

    expect(invalidRes.body.statusCode).toBe(422);
    expect(invalidRes.body.message).toContain('Custom fields validation failed');

    // 3. Create a Story with valid custom_fields
    const validRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story Valid Custom Fields',
        team_id: teamId,
        org_id: orgId,
        custom_fields: { story_points: 5, sprint: 'Sprint 24' },
      })
      .expect(201);

    expect(validRes.body.custom_fields.story_points).toBe(5);
    expect(validRes.body.custom_fields.sprint).toBe('Sprint 24');
  });

  it('US1.3: resolves missing custom fields to documented default on read', async () => {
    // 1. Create a Story item BEFORE registering new default field
    const createRes = await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Legacy Story Created Before Schema Update',
        team_id: teamId,
        org_id: orgId,
        custom_fields: { story_points: 3 },
      })
      .expect(201);

    const itemId = createRes.body.id;

    // 2. Register updated schema with documented default for new field `rca_summary`
    await request(app.getHttpServer())
      .post('/workitems/custom-fields/schemas')
      .send({
        type: 'story',
        schema: {
          type: 'object',
          properties: {
            story_points: { type: 'integer' },
            rca_summary: { type: 'string' },
          },
        },
        defaults: {
          rca_summary: 'No RCA required',
          sprint: 'Unassigned',
        },
      })
      .expect(201);

    // 3. Read the item via list endpoint
    const listRes = await request(app.getHttpServer())
      .get('/workitems')
      .set('x-org-id', orgId)
      .expect(200);

    const legacyItem = listRes.body.find((item: any) => item.id === itemId);
    expect(legacyItem).toBeDefined();
    expect(legacyItem.custom_fields.story_points).toBe(3);
    // Missing field `rca_summary` resolves to documented default
    expect(legacyItem.custom_fields.rca_summary).toBe('No RCA required');
    expect(legacyItem.custom_fields.sprint).toBe('Unassigned');
  });
});
