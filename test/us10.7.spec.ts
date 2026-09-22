import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { EventStoreService } from '../src/modules/events/event-store.service';
import { verifyTenantAuditChain } from '../src/modules/audit/audit-integrity';

describe('US10.7 — cryptographically verifiable audit export', () => {
  let app: INestApplication;
  const dirs: string[] = [];

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('hash-chains field changes, transitions and integration transactions and detects source tampering', async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const teamId = randomUUID();
    const actorId = randomUUID();
    const item = (await request(app.getHttpServer())
      .post('/workitems')
      .set('x-org-id', orgId)
      .set('x-actor-id', actorId)
      .send({ type: 'story', title: 'Verifiable history', team_id: teamId, org_id: orgId })
      .expect(201)).body;

    await request(app.getHttpServer())
      .patch(`/workitems/${item.id}`)
      .set('x-org-id', orgId)
      .set('x-actor-id', actorId)
      .send({ priority: 'P1', custom_fields: { compliance_owner: 'risk-team' } })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workitems/${item.id}/transitions`)
      .set('x-org-id', orgId)
      .set('x-actor-id', actorId)
      .set('x-actor-role', 'Developer')
      .send({ to_state: 'Planned' })
      .expect(201);

    const integrationEventId = randomUUID();
    await new EventStoreService().record({
      event_id: integrationEventId,
      event_type: 'IntegrationTransactionCompleted',
      schema_version: 1,
      timestamp: new Date().toISOString(),
      actor: { type: 'integration', id: 'integration:jira:sync' },
      work_item_id: item.id,
      payload: {
        org_id: orgId,
        provider: 'jira',
        transaction_id: 'sync-1047',
        not_persisted: undefined,
        before: { sync_status: 'queued' },
        after: { sync_status: 'completed' },
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/audit/export?work_item_id=${item.id}`)
      .set('x-org-id', orgId)
      .set('x-actor-id', actorId)
      .expect(200);
    expect(response.body.integrity).toMatchObject({
      algorithm: 'SHA-256',
      proof_version: 1,
      chain_scope: 'tenant',
      chain_verified: true,
      exported_event_count: response.body.event_count,
      exported_events_verified: response.body.event_count,
      verified: true,
    });
    expect(response.body.integrity.chain_length).toBeGreaterThanOrEqual(response.body.event_count);
    expect(response.body.integrity.chain_head).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.events.every((event: any) =>
      event.actor.id && event.timestamp && event.integrity.algorithm === 'SHA-256'
      && event.integrity.verified && /^[a-f0-9]{64}$/.test(event.integrity.hash))).toBe(true);

    const integration = response.body.events.find((event: any) => event.id === integrationEventId);
    expect(integration).toMatchObject({
      event_type: 'IntegrationTransactionCompleted',
      actor: { type: 'integration', id: 'integration:jira:sync' },
      before: { sync_status: 'queued' },
      after: { sync_status: 'completed' },
      integrity: { verified: true },
    });
    await request(app.getHttpServer())
      .get(`/audit/export?work_item_id=${item.id}`)
      .set('x-org-id', otherOrgId)
      .expect(404);

    // A source-row rewrite cannot silently inherit the proof recorded for the original event.
    await DatabaseService.getInstance().db.query(
      `UPDATE domain_events SET payload = $1 WHERE event_id = $2`,
      [JSON.stringify({ org_id: orgId, before: { sync_status: 'queued' }, after: { sync_status: 'failed' } }), integrationEventId],
    );
    const tampered = await request(app.getHttpServer())
      .get(`/audit/export?work_item_id=${item.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(tampered.body.integrity.chain_verified).toBe(false);
    expect(tampered.body.integrity.verified).toBe(false);
    expect(tampered.body.events.find((event: any) => event.id === integrationEventId).integrity.verified).toBe(false);

    await DatabaseService.getInstance().db.query(`DELETE FROM domain_events WHERE event_id = $1`, [integrationEventId]);
    const deleted = await request(app.getHttpServer())
      .get(`/audit/export?work_item_id=${item.id}`)
      .set('x-org-id', orgId)
      .expect(200);
    expect(deleted.body.events.some((event: any) => event.id === integrationEventId)).toBe(false);
    expect(deleted.body.integrity.chain_length).toBeGreaterThan(deleted.body.event_count);
    expect(deleted.body.integrity.chain_verified).toBe(false);
    expect(deleted.body.integrity.verified).toBe(false);
  });

  it('backfills immutable events from an existing database into a deterministic chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadena-audit-chain-'));
    dirs.push(dir);
    const orgId = randomUUID();
    const eventId = randomUUID();
    const first = DatabaseService.createIsolated(dir);
    await first.initialize();
    await first.db.query(
      `INSERT INTO domain_events
       (event_id, org_id, event_type, schema_version, work_item_id, actor_type, actor_id, payload, occurred_at)
       VALUES ($1, $2, 'HistoricalIntegrationTransaction', 1, $3, 'integration', 'legacy:connector', $4, $5)`,
      [eventId, orgId, randomUUID(), JSON.stringify({ before: null, after: { imported: true } }), new Date().toISOString()],
    );
    await first.close();

    const reopened = DatabaseService.createIsolated(dir);
    await reopened.initialize();
    const entries = await reopened.db.query<any>(
      `SELECT source, event_id, previous_hash, event_hash FROM audit_integrity_entries WHERE org_id = $1`,
      [orgId],
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0]).toMatchObject({ source: 'domain_events', event_id: eventId, previous_hash: null });
    expect(entries.rows[0].event_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifyTenantAuditChain(reopened.db, orgId)).toMatchObject({
      chain_length: 1,
      chain_head: entries.rows[0].event_hash,
      chain_verified: true,
    });
    await reopened.close();
  });
});
