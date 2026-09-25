import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { ConnectorService } from '../src/modules/connectors/connector.service';
import { ConnectorFetch } from '../src/modules/connectors/connector-http';
import { ConnectorRelayService } from '../src/modules/connectors/relay/connector-relay.service';
import { OutboundRelayAgent } from '../src/modules/connectors/relay/outbound-relay-agent';
import { FakeJiraApi } from '../src/modules/connectors/sandbox/provider-sandbox';

process.env.CADENA_NATIVE_QUERY_SCHEDULER = 'disabled';
process.env.CADENA_BACKFILL_SCHEDULER = 'disabled';

describe('US16.3 — outbound-only relay connectivity', () => {
  let app: INestApplication;
  let connectors: ConnectorService;
  let relays: ConnectorRelayService;
  const database = DatabaseService.getInstance();
  const orgId = randomUUID();
  const actor = 'security-architect';
  const ledgerDirectory = mkdtempSync(join(tmpdir(), 'cadena-relay-ledger-'));
  const jira = new FakeJiraApi('http://jira.internal');
  const providerAuthorization = `Basic ${Buffer.from('sync@acme.test:jira-token-value').toString('base64')}`;
  let connectorId: string;
  let relayId: string;
  let relayToken: string;

  beforeAll(async () => {
    await database.initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0); // Concurrent long-poll and admin requests need one stable listener.
    connectors = app.get(ConnectorService);
    relays = app.get(ConnectorRelayService);
    jira.addIssue({ key: 'CAD-1630', summary: 'Only reachable behind firewall', status: 'To Do' });
  });

  afterAll(async () => {
    connectors.registerAdapter(new (await import('../src/modules/connectors/jira-connector.adapter')).JiraConnectorAdapter());
    if (app) await app.close();
    rmSync(ledgerDirectory, { recursive: true, force: true });
  });

  const headers = () => ({ 'x-org-id': orgId, 'x-actor-id': actor });
  const http = () => request(app.getHttpServer());

  const controlFetch: ConnectorFetch = async (url, init) => {
    const parsed = new URL(url);
    let call = http().post(`${parsed.pathname}${parsed.search}`);
    for (const [name, value] of Object.entries(init.headers || {})) call = call.set(name, value);
    if (init.body) call = call.send(JSON.parse(init.body));
    const response = await call;
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: { get: (name: string) => response.headers[name.toLowerCase()] || null },
      text: async () => response.text || JSON.stringify(response.body || {}),
    };
  };

  const agent = (control: ConnectorFetch = controlFetch) => new OutboundRelayAgent({
    controlPlaneUrl: 'https://cadena.example',
    relayId,
    token: relayToken,
    targetOrigin: 'http://jira.internal',
    ledgerDirectory,
    providerHeaders: { Authorization: providerAuthorization },
  }, control, jira.fetch);

  async function drive<T>(pending: Promise<T>, relayAgent: OutboundRelayAgent): Promise<T> {
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    for (let turn = 0; !settled && turn < 30; turn += 1) await relayAgent.runOnce(1);
    expect(settled, 'connector operation did not finish through the relay').toBe(true);
    return pending;
  }

  it('provisions a hashed credential and refuses any control plane that is not outbound HTTPS on port 443', async () => {
    expect(() => new OutboundRelayAgent({
      controlPlaneUrl: 'http://cadena.example', relayId: 'relay', token: 'token',
      targetOrigin: 'http://jira.internal', ledgerDirectory,
    }, controlFetch, jira.fetch)).toThrow('outbound HTTPS on port 443');
    expect(() => new OutboundRelayAgent({
      controlPlaneUrl: 'https://cadena.example:8443', relayId: 'relay', token: 'token',
      targetOrigin: 'http://jira.internal', ledgerDirectory,
    }, controlFetch, jira.fetch)).toThrow('outbound HTTPS on port 443');

    const created = await http().post('/integrations/connectors').set(headers()).send({
      name: 'Jira behind firewall',
      provider: 'jira',
      baseUrl: 'http://jira.internal',
      projectKeys: ['CAD'],
      connectivity: { mode: 'relay' },
    }).expect(201);
    connectorId = created.body.id;
    expect(created.body.config.credentials).toEqual({});
    expect(created.body.config.connectivity).toEqual({ mode: 'relay' });

    const provisioned = await http().post(`/integrations/connectors/${connectorId}/relay`).set(headers())
      .send({ name: 'DMZ relay' }).expect(201);
    relayId = provisioned.body.id;
    relayToken = provisioned.body.token;
    expect(relayToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(provisioned.body).toMatchObject({ connectorId, name: 'DMZ relay', status: 'waiting' });
    const status = await http().get(`/integrations/connectors/${connectorId}/relay`).set(headers()).expect(200);
    expect(status.body.token).toBeUndefined();

    const stored = await database.db.query<any>(
      `SELECT token_hash FROM integration_connector_relays WHERE id = $1`, [relayId],
    );
    expect(stored.rows[0].token_hash).not.toContain(relayToken);
    await http().post(`/integrations/relay/${relayId}/poll`)
      .set('authorization', 'Bearer wrong-token').send({ waitSeconds: 0 }).expect(401);
  });

  it('tests, discovers, activates and synchronizes without the control plane opening a provider connection', async () => {
    const relayAgent = agent();
    const tested = http().post(`/integrations/connectors/${connectorId}/test`).set(headers()).then((value) => value);
    expect((await drive(tested, relayAgent)).status).toBe(201);

    const discovered = http().post(`/integrations/connectors/${connectorId}/discover`).set(headers()).then((value) => value);
    expect((await drive(discovered, relayAgent)).status).toBe(201);
    await http().post(`/integrations/connectors/${connectorId}/activate`).set(headers()).expect(201);

    const synchronized = http().post(`/integrations/connectors/${connectorId}/sync`).set(headers()).then((value) => value);
    const syncResponse = await drive(synchronized, relayAgent);
    expect(syncResponse.status).toBe(201);
    expect(syncResponse.body.twinsCreated).toBe(1);
    const twins = await http().get(`/integrations/connectors/${connectorId}/twins`).set(headers()).expect(200);
    expect(twins.body[0]).toMatchObject({ nativeKey: 'CAD-1630', title: 'Only reachable behind firewall' });

    const queued = await database.db.query<any>(
      `SELECT headers FROM integration_relay_requests WHERE relay_id = $1`, [relayId],
    );
    expect(queued.rows.length).toBeGreaterThan(0);
    for (const row of queued.rows) {
      const storedHeaders = typeof row.headers === 'string' ? JSON.parse(row.headers) : row.headers;
      expect(Object.keys(storedHeaders).map((key) => key.toLowerCase())).not.toContain('authorization');
    }
    expect(jira.requests.every((entry) => entry.headers.Authorization === providerAuthorization)).toBe(true);
  });

  it('redelivers the queue head after disconnect, reuses its durable result, then delivers the next item in order', async () => {
    const connector = await connectors.getConnector(orgId, connectorId);
    const targetOrder: string[] = [];
    const targetFetch: ConnectorFetch = async (url, init) => {
      targetOrder.push(new URL(url).searchParams.get('order') || 'missing');
      return jira.fetch(url, init);
    };

    const first = relays.request(connector, 'fifo-operation-1', 'http://jira.internal/rest/api/3/myself?order=1', {
      method: 'GET', headers: { Authorization: 'must-not-be-persisted' },
    });
    await vi.waitFor(async () => expect(Number((await database.db.query<any>(
      `SELECT COUNT(*) AS count FROM integration_relay_requests WHERE relay_id = $1 AND status = 'pending'`, [relayId],
    )).rows[0].count)).toBe(1));
    const second = relays.request(connector, 'fifo-operation-2', 'http://jira.internal/rest/api/3/myself?order=2', {
      method: 'GET', headers: {},
    });
    await vi.waitFor(async () => expect(Number((await database.db.query<any>(
      `SELECT COUNT(*) AS count FROM integration_relay_requests WHERE relay_id = $1 AND status = 'pending'`, [relayId],
    )).rows[0].count)).toBe(2));

    let dropFirstAck = true;
    const flakyControl: ConnectorFetch = async (url, init) => {
      if (dropFirstAck && url.endsWith('/ack')) {
        dropFirstAck = false;
        throw new Error('simulated outbound disconnect before acknowledgement');
      }
      return controlFetch(url, init);
    };
    const disconnectedAgent = new OutboundRelayAgent({
      controlPlaneUrl: 'https://cadena.example', relayId, token: relayToken,
      targetOrigin: 'http://jira.internal', ledgerDirectory,
      providerHeaders: { Authorization: providerAuthorization },
    }, flakyControl, targetFetch);
    await expect(disconnectedAgent.runOnce(0)).rejects.toThrow('simulated outbound disconnect');
    expect(targetOrder).toEqual(['1']);
    expect(await agent().runOnce(0)).toBe(false); // The leased queue head blocks the later item.

    const head = await database.db.query<any>(
      `SELECT id FROM integration_relay_requests WHERE relay_id = $1 AND status = 'leased'
       ORDER BY queue_position LIMIT 1`, [relayId],
    );
    await database.db.query(
      `UPDATE integration_relay_requests SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE id = $1`, [head.rows[0].id],
    );

    const reconnectedAgent = new OutboundRelayAgent({
      controlPlaneUrl: 'https://cadena.example', relayId, token: relayToken,
      targetOrigin: 'http://jira.internal', ledgerDirectory,
      providerHeaders: { Authorization: providerAuthorization },
    }, controlFetch, targetFetch);
    expect(await reconnectedAgent.runOnce(0)).toBe(true); // ACKs the saved result; no provider call.
    expect((await first).status).toBe(200);
    expect(targetOrder).toEqual(['1']);
    expect(await reconnectedAgent.runOnce(0)).toBe(true);
    expect((await second).status).toBe(200);
    expect(targetOrder).toEqual(['1', '2']);

    const deliveries = await database.db.query<any>(
      `SELECT status, attempts FROM integration_relay_requests
       WHERE relay_id = $1 AND idempotency_key IN (
         SELECT idempotency_key FROM integration_relay_requests WHERE url LIKE '%order=%'
       ) ORDER BY queue_position`, [relayId],
    );
    expect(deliveries.rows.map((row) => [row.status, Number(row.attempts)])).toEqual([
      ['completed', 2],
      ['completed', 1],
    ]);
  });
});
