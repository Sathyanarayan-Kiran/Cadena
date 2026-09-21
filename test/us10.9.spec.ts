import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

/**
 * US10.9 — authenticated tenant and actor identity.
 *
 * The rest of the suite runs with `CADENA_ALLOW_HEADER_AUTH=true`, which is how the
 * pre-authentication tests keep passing. This file deliberately turns that off for its
 * own duration so it exercises the posture production actually runs under: a bearer token
 * is required, and the tenant is something the caller proves rather than asserts.
 */
describe('US10.9 — authenticated tenant and actor identity', () => {
  let app: INestApplication;
  const orgA = '10700000-0000-0000-0000-00000000000a';
  const orgB = '10700000-0000-0000-0000-00000000000b';
  const teamId = '10700000-0000-0000-0000-000000000002';
  const BOOTSTRAP = 'bootstrap-secret-for-tests';

  let devHeadersWas: string | undefined;
  let bootstrapWas: string | undefined;

  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;

  let tokenA = '';
  let adminTokenA = '';
  let tokenB = '';
  let credentialIdA = '';

  beforeAll(async () => {
    devHeadersWas = process.env.CADENA_ALLOW_HEADER_AUTH;
    bootstrapWas = process.env.CADENA_BOOTSTRAP_TOKEN;
    process.env.CADENA_ALLOW_HEADER_AUTH = 'false';
    process.env.CADENA_BOOTSTRAP_TOKEN = BOOTSTRAP;

    await DatabaseService.getInstance().initialize();
    for (const org of [orgA, orgB]) {
      await db().query(`INSERT INTO orgs (id, name) VALUES ($1, 'Auth org') ON CONFLICT DO NOTHING`, [org]);
    }
    await db().query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Auth team') ON CONFLICT DO NOTHING`,
      [teamId, orgA],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const issue = async (org: string, body: object) => {
      const res = await request(server())
        .post('/auth/credentials')
        .set('Authorization', `Bearer ${BOOTSTRAP}`)
        .set('x-org-id', org)
        .send(body)
        .expect(201);
      return res.body;
    };

    const admin = await issue(orgA, { name: 'org-a-admin', roles: ['platform_admin'] });
    adminTokenA = admin.token;
    credentialIdA = admin.id;
    tokenA = (await issue(orgA, { name: 'org-a-worker', actor_id: 'worker-a', roles: ['on_call'] })).token;
    tokenB = (await issue(orgB, { name: 'org-b-worker', roles: ['developer'] })).token;
  });

  afterAll(async () => {
    await app?.close();
    if (devHeadersWas === undefined) delete process.env.CADENA_ALLOW_HEADER_AUTH;
    else process.env.CADENA_ALLOW_HEADER_AUTH = devHeadersWas;
    if (bootstrapWas === undefined) delete process.env.CADENA_BOOTSTRAP_TOKEN;
    else process.env.CADENA_BOOTSTRAP_TOKEN = bootstrapWas;
  });

  it('refuses an unauthenticated request outright', async () => {
    const anonymous = await request(server()).get('/workitems').expect(401);
    expect(anonymous.body).toMatchObject({ error: 'authentication_required' });

    // The header alone no longer buys anything, which is the entire point.
    const headerOnly = await request(server()).get('/workitems').set('x-org-id', orgA).expect(401);
    expect(headerOnly.body.message).toContain('Header-based identity is disabled');

    await request(server()).get('/workitems').set('Authorization', 'Bearer cdn_nonsense').expect(401);
  });

  it('resolves the tenant from the credential, not from the header', async () => {
    const me = await request(server())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(me.body).toMatchObject({
      org_id: orgA,
      actor_id: 'worker-a',
      roles: ['on_call'],
      source: 'credential',
    });
  });

  it('rejects a request whose header contradicts its credential', async () => {
    const mismatch = await request(server())
      .get('/workitems')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-org-id', orgB)
      .expect(403);
    expect(mismatch.body).toMatchObject({ error: 'tenant_mismatch' });
  });

  it('cannot reach another tenant even by asserting its id', async () => {
    const created = await request(server())
      .post('/workitems')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ type: 'story', title: 'Belongs to org A', team_id: teamId, org_id: orgA })
      .expect(201);

    const ownView = await request(server())
      .get('/workitems')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(ownView.body.some((i: any) => i.id === created.body.id)).toBe(true);

    // Org B holds a valid credential, so this is authenticated but not authorised.
    const otherView = await request(server())
      .get('/workitems')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(otherView.body.some((i: any) => i.id === created.body.id)).toBe(false);

    await request(server())
      .get(`/workitems/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('stores only a hash, never the token itself', async () => {
    const stored = await db().query<any>(
      `SELECT token_hash FROM api_credentials WHERE org_id = $1`,
      [orgA],
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toBe(tokenA);
      expect(row.token_hash).not.toContain('cdn_');
    }

    // Listing credentials must never hand the secret back.
    const listed = await request(server())
      .get('/auth/credentials')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .expect(200);
    expect(listed.body.length).toBeGreaterThan(0);
    for (const credential of listed.body) {
      expect(credential).not.toHaveProperty('token');
      expect(credential).not.toHaveProperty('token_hash');
    }
  });

  it('stops honouring a revoked credential', async () => {
    const throwaway = await request(server())
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({ name: 'temporary' })
      .expect(201);

    await request(server())
      .get('/auth/me')
      .set('Authorization', `Bearer ${throwaway.body.token}`)
      .expect(200);

    await request(server())
      .post(`/auth/credentials/${throwaway.body.id}/revoke`)
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({})
      .expect(201);

    await request(server())
      .get('/auth/me')
      .set('Authorization', `Bearer ${throwaway.body.token}`)
      .expect(401);
  });

  it('restricts credential management to admins and the bootstrap token', async () => {
    // A valid but non-admin credential must not be able to mint more credentials.
    const denied = await request(server())
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'escalation attempt' })
      .expect(403);
    expect(denied.body).toMatchObject({ error: 'admin_required' });

    await request(server())
      .get('/auth/credentials')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);

    // Another tenant's admin cannot revoke this tenant's credential.
    const otherAdmin = await request(server())
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .set('x-org-id', orgB)
      .send({ name: 'org-b-admin', roles: ['platform_admin'] })
      .expect(201);
    await request(server())
      .post(`/auth/credentials/${credentialIdA}/revoke`)
      .set('Authorization', `Bearer ${otherAdmin.body.token}`)
      .send({})
      .expect(404);
  });

  it('requires the bootstrap token to name the tenant it acts for', async () => {
    const unnamed = await request(server())
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ name: 'no tenant given' })
      .expect(400);
    expect(unnamed.body).toMatchObject({ error: 'tenant_required' });
  });

  it('carries the credential role into workflow guard evaluation', async () => {
    const incident = await request(server())
      .post('/workitems')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ type: 'incident', title: 'Guarded by credential role', team_id: teamId, org_id: orgA })
      .expect(201);

    // tokenA holds on_call, which the built-in incident workflow accepts for this move.
    await request(server())
      .post(`/workitems/${incident.body.id}/transitions`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ to_state: 'Investigating' })
      .expect(201);

    // Reaching Resolved needs incident_commander, which this credential does not hold,
    // and the caller cannot grant it to themselves with a header any more.
    const blocked = await request(server())
      .post(`/workitems/${incident.body.id}/transitions`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-actor-role', 'incident_commander')
      .send({ to_state: 'Mitigated', fields: { mitigation_summary: 'done' } })
      .expect(201);
    expect(blocked.body.to_state).toBe('Mitigated');

    const denied = await request(server())
      .post(`/workitems/${incident.body.id}/transitions`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('x-actor-role', 'incident_commander')
      .send({ to_state: 'Resolved' })
      .expect(409);
    expect(denied.body).toMatchObject({ error: 'guard_failed' });
  });

  it('issues opaque, unguessable tokens', async () => {
    const first = await request(server())
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({ name: 'entropy-a' })
      .expect(201);
    const second = await request(server())
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({ name: 'entropy-b' })
      .expect(201);

    expect(first.body.token).toMatch(/^cdn_[0-9a-f]{48}$/);
    expect(first.body.token).not.toBe(second.body.token);
    // Nothing about the token should be derivable from the record it belongs to.
    expect(first.body.token).not.toContain(first.body.id);
    expect(first.body.token).not.toContain(orgA);
  });

  it('rejects a credential with no name', async () => {
    const invalid = await request(server())
      .post('/auth/credentials')
      .set('Authorization', `Bearer ${adminTokenA}`)
      .send({ roles: ['developer'] })
      .expect(422);
    expect(invalid.body.message).toContain('name is required');
  });

  it('leaves an unknown token indistinguishable from a revoked one', async () => {
    const unknown = await request(server())
      .get('/auth/me')
      .set('Authorization', `Bearer cdn_${'0'.repeat(48)}`)
      .expect(401);
    expect(unknown.body.message).toBe('The bearer token is unknown or revoked');
  });

  it('keeps the datastore free of plaintext secrets after all of this', async () => {
    const rows = await db().query<any>(`SELECT token_hash, name FROM api_credentials`);
    const serialised = JSON.stringify(rows.rows);
    expect(serialised).not.toContain(tokenA);
    expect(serialised).not.toContain(adminTokenA);
    expect(serialised).not.toContain(BOOTSTRAP);
    expect(randomUUID()).toBeTruthy();
  });
});
