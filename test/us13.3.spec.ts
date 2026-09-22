import { beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { SyncGuardService } from '../src/modules/integrations/sync-guard.service';

describe('US13.3 — echo-loop suppression', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let guard: SyncGuardService;
  const database = DatabaseService.getInstance();

  beforeAll(async () => {
    await database.initialize();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    guard = moduleRef.get(SyncGuardService);
  });

  const headers = (orgId: string) => ({ 'x-org-id': orgId });
  const identity = (suffix: string) => ({
    system: 'jira', entity_type: 'issue', immutable_id: `issue-${suffix}`,
  });

  const createCorrelation = async (orgId: string, suffix: string) => {
    await request(app.getHttpServer())
      .post('/integrations/correlations')
      .set(headers(orgId))
      .send({
        source: { system: 'servicenow', entity_type: 'incident', immutable_id: `incident-${suffix}` },
        target: identity(suffix),
        relationship: 'counterpart',
      })
      .expect(201);
  };

  it('suppresses a returning webhook only when service-account identity and canonical payload hash match', async () => {
    const orgId = randomUUID();
    const serviceAccount = 'svc-cadena-jira';
    await createCorrelation(orgId, 'fast-path');

    const write = await request(app.getHttpServer())
      .post('/integrations/sync-guard/writes')
      .set(headers(orgId))
      .send({
        identity: identity('fast-path'),
        service_account_id: serviceAccount,
        payload: { status: 'In Progress', priority: 'High', fields: { owner: 'acct-91', labels: ['sync'] } },
      })
      .expect(201);
    expect(write.body.payload_hash).toMatch(/^[a-f0-9]{64}$/);

    // Key order is intentionally different. Canonical JSON hashing still identifies the
    // returned webhook as the exact write made by Cadena's target service account.
    const echo = await request(app.getHttpServer())
      .post('/integrations/sync-guard/evaluate')
      .set(headers(orgId))
      .send({
        identity: { entity_type: 'issue', immutable_id: 'issue-fast-path', system: 'JIRA' },
        actor_id: serviceAccount,
        payload: { fields: { labels: ['sync'], owner: 'acct-91' }, priority: 'High', status: 'In Progress' },
      })
      .expect(201);
    expect(echo.body).toMatchObject({
      payload_hash: write.body.payload_hash,
      suppressed: true,
      action: 'ignore',
      reason: 'self_originated_hash',
      matched_service_account: true,
    });

    // Identity alone is insufficient: a real change by that account must continue.
    const changed = await request(app.getHttpServer())
      .post('/integrations/sync-guard/evaluate')
      .set(headers(orgId))
      .send({
        identity: identity('fast-path'),
        actor_id: serviceAccount,
        payload: { status: 'Done', priority: 'High', fields: { owner: 'acct-91', labels: ['sync'] } },
      })
      .expect(201);
    expect(changed.body).toMatchObject({
      suppressed: false,
      action: 'process',
      reason: 'external_change',
      matched_service_account: false,
    });

    const events = await database.db.query<any>(
      `SELECT event_type, actor_id, payload FROM domain_events
       WHERE org_id = $1 AND event_type IN
         ('IntegrationWriteRecorded', 'IntegrationEchoSuppressed', 'IntegrationChangeAccepted')
       ORDER BY occurred_at ASC`,
      [orgId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'IntegrationWriteRecorded',
      'IntegrationEchoSuppressed',
      'IntegrationChangeAccepted',
    ]);
    expect(events.rows[1]).toMatchObject({ actor_id: serviceAccount });
    expect(events.rows[1].payload).toMatchObject({ reason: 'self_originated_hash', decision: 'ignore' });
  });

  it('falls back to durable content comparison after volatile suppression state is lost', async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    await createCorrelation(orgId, 'restart-path');
    const normalizedContent = {
      summary: 'Checkout latency',
      status: 'Investigating',
      nested: { impact: 'major', responders: ['acct-4', 'acct-7'] },
    };

    await request(app.getHttpServer())
      .post('/integrations/sync-guard/writes')
      .set(headers(orgId))
      .send({
        identity: identity('restart-path'),
        service_account_id: 'svc-cadena-jira',
        payload: normalizedContent,
      })
      .expect(201);

    // This is the process-restart/cache-eviction boundary: only the durable snapshot remains.
    guard.clearVolatileMarkers();

    const afterRestart = await request(app.getHttpServer())
      .post('/integrations/sync-guard/evaluate')
      .set(headers(orgId))
      .send({
        identity: identity('restart-path'),
        actor_id: 'jira-webhook-actor-without-service-account-metadata',
        payload: normalizedContent,
      })
      .expect(201);
    expect(afterRestart.body).toMatchObject({
      suppressed: true,
      action: 'ignore',
      reason: 'content_noop',
      matched_service_account: false,
    });

    const snapshot = await database.db.query<any>(
      `SELECT payload_hash, canonical_payload, observation_source
       FROM integration_sync_snapshots WHERE org_id = $1`,
      [orgId],
    );
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({ observation_source: 'outbound_write' });
    expect(snapshot.rows[0].canonical_payload).toEqual(normalizedContent);

    // The same immutable id in another tenant cannot observe or exploit this snapshot.
    await request(app.getHttpServer())
      .post('/integrations/sync-guard/evaluate')
      .set(headers(otherOrgId))
      .send({ identity: identity('restart-path'), actor_id: 'svc-cadena-jira', payload: normalizedContent })
      .expect(404);

    await request(app.getHttpServer())
      .post('/integrations/sync-guard/evaluate')
      .set(headers(orgId))
      .send({ identity: identity('restart-path'), actor_id: 'human-1', payload: [] })
      .expect(422);
  });
});

