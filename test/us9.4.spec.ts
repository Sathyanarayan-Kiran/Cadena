import { describe, it, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { EventStoreService } from '../src/modules/events/event-store.service';
import { postGitAndWait } from './integration-webhook-helpers';

describe('US9.4 — DORA and ITIL metrics computed from recorded history', () => {
  let app: INestApplication;
  const orgId = '94000000-0000-0000-0000-000000000001';
  const teamId = '94000000-0000-0000-0000-000000000002';
  const otherOrgId = '94000000-0000-0000-0000-00000000000f';

  const server = () => app.getHttpServer();
  const db = () => DatabaseService.getInstance().db;

  const keys: Record<string, { id: string; key: string }> = {};

  async function create(alias: string, type: string, title: string, extra: object = {}) {
    const res = await request(server())
      .post('/workitems')
      .set('x-org-id', orgId)
      .send({ type, title, team_id: teamId, org_id: orgId, ...extra })
      .expect(201);
    keys[alias] = { id: res.body.id, key: res.body.key };
    return res.body;
  }

  async function git(deliveryId: string, body: object) {
    return postGitAndWait(server(), orgId, deliveryId, body);
  }

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // Durable history is what the metrics read; attach explicitly since Nest lifecycle
    // hooks do not run for providers under the vitest transform.
    new EventStoreService().attach();

    // --- a delivery history: two releases shipped, one of which broke production ---
    await create('release1', 'release', 'Release 5.0.0');
    await create('release2', 'release', 'Release 5.0.1');
    await create('story1', 'story', 'Checkout retry logic');
    await create('story2', 'story', 'Basket totals rounding');

    await git('m-commit-1', {
      provider: 'github', event_type: 'push', repository: 'cadena/platform',
      commits: [{ sha: 'aaa111', message: `feat: ${keys.story1.key} retry logic` }],
    });
    await git('m-commit-2', {
      provider: 'github', event_type: 'push', repository: 'cadena/platform',
      commits: [{ sha: 'bbb222', message: `fix: ${keys.story2.key} rounding` }],
    });

    // Backdate the commits so lead time is a measurable span rather than milliseconds.
    await db().query(
      `UPDATE external_artifacts SET created_at = $1 WHERE artifact_type = 'commit' AND org_id = $2`,
      [new Date(Date.now() - 48 * 3_600_000).toISOString(), orgId],
    );

    for (const release of ['release1', 'release2']) {
      await request(server())
        .post(`/workitems/${keys[release].id}/transitions`)
        .set('x-org-id', orgId)
        .send({ to_state: 'Ready' })
        .expect(201);
    }

    await git('m-deploy-1', {
      provider: 'github', event_type: 'deployment', repository: 'cadena/platform',
      deployment: {
        id: 'deploy-5.0.0', environment: 'production', status: 'success',
        release_key: keys.release1.key, work_item_keys: [keys.story1.key],
      },
    });
    await git('m-deploy-2', {
      provider: 'github', event_type: 'deployment', repository: 'cadena/platform',
      deployment: {
        id: 'deploy-5.0.1', environment: 'production', status: 'success',
        release_key: keys.release2.key, work_item_keys: [keys.story2.key],
      },
    });

    // Release 5.0.0 caused an incident. That edge is what makes change failure rate real.
    const incident = await create('incident', 'incident', 'Checkout 500s after 5.0.0 rollout', {
      severity: 'SEV1', priority: 'P0', tags: ['auto-created'],
    });
    await request(server())
      .post(`/workitems/${incident.id}/links`)
      .set('x-org-id', orgId)
      .send({ target_id: keys.release1.id, link_type: 'caused_by' })
      .expect(201);

    for (const [state, role] of [['Investigating', 'on_call'], ['Mitigated', 'on_call'], ['Resolved', 'incident_commander']]) {
      await request(server())
        .post(`/workitems/${incident.id}/transitions`)
        .set('x-org-id', orgId)
        .set('x-actor-role', role)
        .send({ to_state: state, fields: { mitigation_summary: 'Rolled back the release.' } })
        .expect(201);
    }

    // A second incident that nobody has resolved, so restore-time coverage is partial.
    await create('incident2', 'incident', 'Latency drift in search', { severity: 'SEV3' });
  });

  it('derives deployment frequency and lead time from delivery artefacts', async () => {
    const res = await request(server()).get('/metrics/flow').set('x-org-id', orgId).expect(200);
    const dora = res.body.dora;

    expect(dora.deployment_frequency.total).toBe(2);
    expect(dora.deployment_frequency.environments).toEqual({ production: 2 });
    expect(dora.deployment_frequency.per_week).toBeGreaterThan(0);

    // Both deployments trace back to a commit, roughly two days earlier.
    expect(dora.lead_time_for_changes.count).toBe(2);
    expect(dora.lead_time_for_changes.median_hours).toBeGreaterThan(47);
    expect(dora.lead_time_for_changes.median_hours).toBeLessThan(49);
    expect(res.body.coverage.deployments_with_commit_evidence).toBe(2);
  });

  it('computes change failure rate from the Incident caused_by Release edge', async () => {
    const res = await request(server()).get('/metrics/flow').set('x-org-id', orgId).expect(200);
    const cfr = res.body.dora.change_failure_rate;

    expect(cfr.deployments).toBe(2);
    expect(cfr.failed_deployments).toBe(1);
    expect(cfr.rate).toBe(0.5);

    // The rate ships with its evidence so it can be audited, not taken on trust.
    expect(cfr.failures).toHaveLength(1);
    expect(cfr.failures[0]).toMatchObject({
      deployment: 'deploy-5.0.0',
      release_key: keys.release1.key,
      incident_key: keys.incident.key,
      severity: 'SEV1',
    });
  });

  it('computes time to restore from the incident state history', async () => {
    const res = await request(server()).get('/metrics/flow').set('x-org-id', orgId).expect(200);
    const restore = res.body.dora.time_to_restore_service;

    // Only the resolved incident counts; the open one is excluded rather than assumed.
    expect(restore.count).toBe(1);
    expect(restore.median_hours).not.toBeNull();
    expect(restore.median_hours).toBeGreaterThanOrEqual(0);
    expect(res.body.coverage.incidents_with_resolution_history).toBe(1);
  });

  it('reports ITIL operational counts alongside the delivery metrics', async () => {
    const res = await request(server()).get('/metrics/flow').set('x-org-id', orgId).expect(200);
    const itil = res.body.itil;

    expect(itil.incidents_opened).toBe(2);
    expect(itil.incidents_resolved).toBe(1);
    expect(itil.by_severity).toMatchObject({ SEV1: 1, SEV3: 1 });
    expect(itil.auto_created).toBe(1);
    expect(itil.reopened).toBe(0);
  });

  it('honours the requested window and rejects an invalid range', async () => {
    const past = await request(server())
      .get('/metrics/flow?from=2020-01-01T00:00:00.000Z&to=2020-02-01T00:00:00.000Z')
      .set('x-org-id', orgId)
      .expect(200);
    expect(past.body.dora.deployment_frequency.total).toBe(0);
    expect(past.body.dora.change_failure_rate.rate).toBeNull();
    expect(past.body.itil.incidents_opened).toBe(0);

    const bad = await request(server())
      .get('/metrics/flow?from=not-a-date')
      .set('x-org-id', orgId)
      .expect(422);
    expect(bad.body.message).toContain('ISO 8601');

    const reversed = await request(server())
      .get('/metrics/flow?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z')
      .set('x-org-id', orgId)
      .expect(422);
    expect(reversed.body.message).toContain('earlier than');
  });

  it('scopes every metric to the calling tenant', async () => {
    const other = await request(server()).get('/metrics/flow').set('x-org-id', otherOrgId).expect(200);
    expect(other.body.dora.deployment_frequency.total).toBe(0);
    expect(other.body.dora.change_failure_rate.failures).toEqual([]);
    expect(other.body.itil.incidents_opened).toBe(0);

    await request(server()).get('/metrics/flow').expect(400);
  });

  it('keeps a durable, queryable event history', async () => {
    const events = await request(server())
      .get('/events?limit=500')
      .set('x-org-id', orgId)
      .expect(200);

    expect(events.body.length).toBeGreaterThan(0);
    const types = new Set(events.body.map((e: any) => e.event_type));
    expect(types.has('WorkItemCreated')).toBe(true);
    expect(types.has('WorkItemStateChanged')).toBe(true);

    // Envelope fields survive the round trip through storage.
    const sample = events.body.find((e: any) => e.event_type === 'WorkItemStateChanged');
    expect(sample).toMatchObject({ schema_version: 1, org_id: orgId });
    expect(sample.actor).toHaveProperty('type');
    expect(new Date(sample.occurred_at).toString()).not.toBe('Invalid Date');

    const filtered = await request(server())
      .get('/events?event_type=WorkItemCreated')
      .set('x-org-id', orgId)
      .expect(200);
    expect(filtered.body.every((e: any) => e.event_type === 'WorkItemCreated')).toBe(true);
  });
});
