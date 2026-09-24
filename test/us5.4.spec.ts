import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { waitForDelivery } from './integration-webhook-helpers';

describe('US5.4 — durable HTTP 202 webhook ingestion', () => {
  let app: INestApplication;
  const orgId = '54000000-0000-0000-0000-000000000001';
  const teamId = '54000000-0000-0000-0000-000000000002';
  const previousDelay = process.env.CADENA_INBOUND_WORKER_DELAY_MS;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    process.env.CADENA_INBOUND_WORKER_DELAY_MS = '80';
    const db = DatabaseService.getInstance().db;
    await DatabaseService.getInstance().initialize();
    await db.query(`INSERT INTO orgs (id, name) VALUES ($1, 'Async ingestion org') ON CONFLICT DO NOTHING`, [orgId]);
    await db.query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Async ingestion team') ON CONFLICT DO NOTHING`,
      [teamId, orgId],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // Listen once up front: supertest otherwise binds an ephemeral listener per
    // request, and the concurrent burst below races those binds on one server.
    await app.listen(0);
  });

  afterAll(async () => {
    if (previousDelay === undefined) delete process.env.CADENA_INBOUND_WORKER_DELAY_MS;
    else process.env.CADENA_INBOUND_WORKER_DELAY_MS = previousDelay;
    await app?.close();
  });

  it('persists and acknowledges a valid webhook before attempting its work-item mutation', async () => {
    const story = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type: 'story', title: 'Async webhook target', team_id: teamId, org_id: orgId })
      .expect(201);

    const deliveryId = 'us5.4-ack-before-work';
    const accepted = await request(server())
      .post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', deliveryId)
      .send({
        provider: 'github', event_type: 'push', repository: 'cadena/platform',
        commit: { sha: 'async-ack-sha', message: `feat: async ${story.body.key}` },
      })
      .expect(202);

    expect(accepted.body).toMatchObject({
      accepted: true, duplicate: false, delivery_id: deliveryId,
      provider: 'github', status: 'queued',
    });
    expect(accepted.body.status_url).toContain(deliveryId);

    const linksBeforeWorker = await request(server())
      .get(`/workitems/${story.body.id}/external-links`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(linksBeforeWorker.body).toHaveLength(0);

    const delivery = await waitForDelivery(server(), 'git', orgId, 'github', deliveryId);
    expect(delivery).toMatchObject({ status: 'completed', attempts: 1 });
    expect(delivery.result.linked_work_item_keys).toEqual([story.body.key]);
  });

  it('queues a burst behind the serial processor and keeps every status queryable', async () => {
    const deliveries = ['us5.4-burst-1', 'us5.4-burst-2', 'us5.4-burst-3'];
    const accepted = await Promise.all(deliveries.map((deliveryId, index) => request(server())
      .post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', deliveryId)
      .send({
        provider: 'github', event_type: 'push', repository: 'cadena/platform',
        commit: { sha: `burst-${index}`, message: `chore: burst ${index}` },
      })
      .expect(202)));

    expect(accepted.every((response) => response.body.status === 'queued')).toBe(true);
    const statuses = await Promise.all(deliveries.map((deliveryId) => request(server())
      .get(`/integrations/git/deliveries/${deliveryId}`)
      .query({ provider: 'github' })
      .set('x-org-id', orgId)
      .expect(200)));
    expect(statuses.some((response) => response.body.status === 'queued')).toBe(true);

    const settled = await Promise.all(deliveries.map((deliveryId) => (
      waitForDelivery(server(), 'git', orgId, 'github', deliveryId)
    )));
    expect(settled.every((delivery) => delivery.status === 'completed')).toBe(true);
  });

  it('acknowledges a duplicate without creating a second job or side effect', async () => {
    const payload = {
      provider: 'github', event_type: 'push', repository: 'cadena/platform',
      commit: { sha: 'duplicate-async-sha', message: 'docs: duplicate async delivery' },
    };
    const deliveryId = 'us5.4-duplicate';
    await request(server()).post('/integrations/git/webhooks')
      .set('x-org-id', orgId).set('x-delivery-id', deliveryId).send(payload).expect(202);
    await waitForDelivery(server(), 'git', orgId, 'github', deliveryId);

    const duplicate = await request(server()).post('/integrations/git/webhooks')
      .set('x-org-id', orgId).set('x-delivery-id', deliveryId).send(payload).expect(202);
    expect(duplicate.body).toMatchObject({ duplicate: true, status: 'completed' });

    const rows = await DatabaseService.getInstance().db.query<any>(
      `SELECT id, attempts FROM integration_deliveries
       WHERE org_id = $1 AND provider = 'github' AND delivery_id = $2`,
      [orgId, deliveryId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].attempts).toBe(1);
  });

  it('retries a processing failure, dead-letters it, and replays a corrected body', async () => {
    const deliveryId = 'us5.4-correctable-failure';
    await request(server()).post('/integrations/git/webhooks')
      .set('x-org-id', orgId)
      .set('x-delivery-id', deliveryId)
      .send({
        provider: 'github', event_type: 'push', repository: 'cadena/platform',
        commit: { message: 'fix: missing sha until operator correction' },
      })
      .expect(202);

    const failed = await waitForDelivery(server(), 'git', orgId, 'github', deliveryId);
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(3);

    const dlq = await request(server()).get('/dlq').set('x-org-id', orgId).expect(200);
    const entry = dlq.body.find((row: any) => (
      row.consumer === 'inbound-webhooks' && row.envelope.payload.delivery_id === deliveryId
    ));
    expect(entry).toBeTruthy();

    const corrected = structuredClone(entry.envelope.payload);
    corrected.body.commit.sha = 'operator-corrected-sha';
    const replay = await request(server())
      .post(`/dlq/${entry.id}/replay`)
      .set('x-org-id', orgId)
      .send({ payload: corrected })
      .expect(201);
    expect(replay.body.outcome).toBe('processed');

    const completed = await waitForDelivery(server(), 'git', orgId, 'github', deliveryId);
    expect(completed.status).toBe('completed');
    expect(completed.attempts).toBe(4);
  });
});
