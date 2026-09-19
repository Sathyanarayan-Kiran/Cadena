import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US1.2 — Work Item Filtering & Multi-Tenant Isolation', () => {
  let app: INestApplication;

  const orgA = '11111111-1111-1111-1111-111111111111';
  const orgB = '22222222-2222-2222-2222-222222222222';
  const team1 = '33333333-3333-3333-3333-333333333333';

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('US1.2: filters work items by state and aging bucket', async () => {
    // 1. Create items with different states and aging buckets for orgA
    // Item 1: state = in_review, persisted aging bucket = red
    await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story In Review Red Aging',
        team_id: team1,
        org_id: orgA,
      });

    // Manually set status to in_review for Item 1
    const db = DatabaseService.getInstance().db;
    await db.query(`UPDATE work_items SET status = 'in_review', aging_bucket = 'red' WHERE title = 'Story In Review Red Aging'`);

    // Item 2: state = in_review, custom_fields = { aging_bucket: 'green' }
    await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story In Review Green Aging',
        team_id: team1,
        org_id: orgA,
      });
    await db.query(`UPDATE work_items SET status = 'in_review' WHERE title = 'Story In Review Green Aging'`);

    // Item 3: state = Proposed, custom_fields = { aging_bucket: 'red' }
    await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Story Proposed Red Aging',
        team_id: team1,
        org_id: orgA,
      });
    await db.query(`UPDATE work_items SET aging_bucket = 'red' WHERE title = 'Story Proposed Red Aging'`);

    // Query GET /workitems?state=in_review&aging_bucket=red for orgA
    const res = await request(app.getHttpServer())
      .get('/workitems?state=in_review&aging_bucket=red')
      .set('x-org-id', orgA)
      .expect(200);

    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe('Story In Review Red Aging');
    expect(res.body[0].status).toBe('in_review');
    expect(res.body[0].aging_bucket).toBe('red');
  });

  it('US1.2: scopes work item queries strictly to caller org_id', async () => {
    // Create items for Org A and Org B
    await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'story',
        title: 'Org A Secret Story',
        team_id: team1,
        org_id: orgA,
      });

    await request(app.getHttpServer())
      .post('/workitems')
      .send({
        type: 'incident',
        title: 'Org B Secret Incident',
        team_id: team1,
        org_id: orgB,
      });

    // Call GET /workitems as Org A
    const resOrgA = await request(app.getHttpServer())
      .get('/workitems')
      .set('x-org-id', orgA)
      .expect(200);

    const titlesA = resOrgA.body.map((i: any) => i.title);
    expect(titlesA).toContain('Org A Secret Story');
    expect(titlesA).not.toContain('Org B Secret Incident');

    // Call GET /workitems as Org B
    const resOrgB = await request(app.getHttpServer())
      .get('/workitems')
      .set('x-org-id', orgB)
      .expect(200);

    const titlesB = resOrgB.body.map((i: any) => i.title);
    expect(titlesB).toContain('Org B Secret Incident');
    expect(titlesB).not.toContain('Org A Secret Story');
  });

  it('US1.2: denies cross-tenant item reads and links by id', async () => {
    const itemA = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgA)
      .send({ type: 'story', title: 'Org A Link Source', team_id: team1, org_id: orgA })
      .expect(201);

    const itemB = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgB)
      .send({ type: 'story', title: 'Org B Private Target', team_id: team1, org_id: orgB })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/workitems/${itemB.body.id}`)
      .set('x-org-id', orgA)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/workitems/${itemA.body.id}/links`)
      .set('x-org-id', orgA)
      .send({ target_id: itemB.body.id, link_type: 'relates_to' })
      .expect(400);
  });
});
