import { beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US4.4 — Exportable lineage report', () => {
  let app: INestApplication;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const teamId = randomUUID();
  const actorId = 'compliance-reviewer';

  const createItem = async (type: string, title: string) => {
    const response = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type, title, team_id: teamId, org_id: orgId })
      .expect(201);
    return response.body;
  };

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('creates a timestamped full-graph document and preserves it as an immutable snapshot', async () => {
    const epic = await createItem('epic', 'Payments reliability');
    const story = await createItem('story', 'Harden payment retries');
    const release = await createItem('release', 'Release 8.4');
    const incident = await createItem('incident', 'Payment requests timed out');

    await request(app.getHttpServer())
      .post(`/workitems/${story.id}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: epic.id, link_type: 'child_of' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/workitems/${story.id}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: release.id, link_type: 'deployed_in' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/workitems/${incident.id}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: release.id, link_type: 'caused_by' })
      .expect(201);

    // The scenario in the acceptance criterion is a completed incident.
    await DatabaseService.getInstance().db.query(
      `UPDATE work_items SET status = 'Closed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [incident.id],
    );

    const created = await request(app.getHttpServer())
      .post(`/workitems/${incident.id}/lineage-exports`)
      .set('x-org-id', orgId)
      .set('x-actor-id', actorId)
      .expect(201);

    expect(created.headers.location).toBe(created.body.download_url);
    expect(created.body).toMatchObject({
      schema: 'cadena.lineage-report.v1',
      root_work_item_id: incident.id,
      root_key: incident.key,
      org_id: orgId,
      generated_by: actorId,
      summary: { node_count: 4, edge_count: 3 },
    });
    expect(new Date(created.body.generated_at).toString()).not.toBe('Invalid Date');
    expect(created.body.nodes.map((node: any) => node.id)).toEqual(
      expect.arrayContaining([incident.id, release.id, story.id, epic.id]),
    );
    expect(created.body.nodes.every((node: any) => node.created_at && node.updated_at)).toBe(true);
    expect(created.body.edges.every((edge: any) => edge.created_at)).toBe(true);

    // Change the live graph after the report was produced.
    const followUp = await createItem('story', 'Follow-up remediation');
    await request(app.getHttpServer())
      .post(`/workitems/${incident.id}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: followUp.id, link_type: 'fixed_by' })
      .expect(201);

    const downloaded = await request(app.getHttpServer())
      .get(created.body.download_url)
      .set('x-org-id', orgId)
      .expect(200);

    expect(downloaded.headers['content-disposition']).toContain('attachment;');
    expect(downloaded.headers['cache-control']).toBe('private, immutable');
    expect(downloaded.body).toEqual(created.body);
    expect(downloaded.body.nodes.some((node: any) => node.id === followUp.id)).toBe(false);

    // A tenant cannot discover or retrieve another tenant's export by identifier.
    await request(app.getHttpServer())
      .get(created.body.download_url)
      .set('x-org-id', otherOrgId)
      .expect(404);
  });
});
