import { beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('US9.3 — Interactive traceability graph data', () => {
  let app: INestApplication;
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const teamId = randomUUID();

  const createItem = async (type: string, title: string) => {
    const response = await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type, title, team_id: teamId, org_id: orgId })
      .expect(201);
    return response.body;
  };

  const link = async (sourceId: string, targetId: string, linkType: string) => {
    await request(app.getHttpServer())
      .post(`/workitems/${sourceId}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: targetId, link_type: linkType })
      .expect(201);
  };

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('returns a tenant-scoped upstream and downstream graph bounded by configured depth', async () => {
    const epic = await createItem('epic', 'Checkout resilience');
    const root = await createItem('story', 'Retry orchestration');
    const child = await createItem('story', 'Instrument retry outcomes');
    const grandchild = await createItem('story', 'Add retry alerting');

    await link(root.id, epic.id, 'child_of');
    await link(child.id, root.id, 'child_of');
    await link(grandchild.id, child.id, 'child_of');

    const direct = await request(app.getHttpServer())
      .get(`/workitems/${root.id}/lineage-graph?depth=1`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(direct.body).toMatchObject({
      root_id: root.id,
      depth: 1,
      summary: { node_count: 3, edge_count: 2, upstream_nodes: 1, downstream_nodes: 1 },
    });
    expect(direct.body.nodes.find((node: any) => node.id === root.id)).toMatchObject({
      distance: 0,
      directions: ['root'],
    });
    expect(direct.body.nodes.find((node: any) => node.id === epic.id)).toMatchObject({
      distance: 1,
      directions: ['up'],
    });
    expect(direct.body.nodes.find((node: any) => node.id === child.id)).toMatchObject({
      distance: 1,
      directions: ['down'],
    });
    expect(direct.body.nodes.some((node: any) => node.id === grandchild.id)).toBe(false);

    const expanded = await request(app.getHttpServer())
      .get(`/workitems/${root.id}/lineage-graph?depth=2`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(expanded.body.summary).toMatchObject({
      node_count: 4,
      edge_count: 3,
      upstream_nodes: 1,
      downstream_nodes: 2,
    });
    expect(expanded.body.nodes.find((node: any) => node.id === grandchild.id)).toMatchObject({
      distance: 2,
      directions: ['down'],
    });

    await request(app.getHttpServer())
      .get(`/workitems/${root.id}/lineage-graph?depth=2`)
      .set('x-org-id', otherOrgId)
      .expect(404);
  });

  it.each(['0', '11', '1.5', 'many'])('rejects invalid configured depth %s', async (depth) => {
    const item = await createItem('story', `Depth validation ${depth}`);
    const response = await request(app.getHttpServer())
      .get(`/workitems/${item.id}/lineage-graph?depth=${depth}`)
      .set('x-org-id', orgId)
      .expect(422);
    expect(response.body.error).toBe('invalid_lineage_depth');
  });
});
