import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { InProcessEventBus } from '../src/modules/events/event-bus';
import { EventConsumerRegistry } from '../src/modules/events/consumer-registry.service';
import { EventStoreService } from '../src/modules/events/event-store.service';

/**
 * Epic 5 — idempotent consumption (US5.2), dead-lettering with alerting (US5.3),
 * and operator replay (US5.5).
 *
 * Consumers are registered here rather than exercised through a production one, because
 * the framework's contract is what is under test: a handler that throws must be retried,
 * then dead-lettered, and a redelivery must be a no-op.
 */
describe('Epic 5 — reliable event consumption', () => {
  let app: INestApplication;
  const orgId = '55000000-0000-0000-0000-000000000001';
  const bus = () => InProcessEventBus.getInstance();
  const server = () => app.getHttpServer();

  // Per-consumer call logs, so "was it retried" and "was it skipped" are observable.
  const calls: Record<string, string[]> = {};
  let failuresRemaining = 0;

  beforeAll(async () => {
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    new EventStoreService().attach();

    const registry = new EventConsumerRegistry();

    registry.register({
      name: 'test-reliable',
      eventTypes: ['Epic5ProbeEvent'],
      handle: (event) => { (calls['test-reliable'] ||= []).push(event.event_id); },
    });

    registry.register({
      name: 'test-always-fails',
      eventTypes: ['Epic5FailingEvent'],
      maxAttempts: 3,
      retryDelayMs: 1,
      handle: (event) => {
        (calls['test-always-fails'] ||= []).push(event.event_id);
        throw new Error('handler exploded');
      },
    });

    registry.register({
      name: 'test-recovers',
      eventTypes: ['Epic5RecoverableEvent'],
      maxAttempts: 2,
      retryDelayMs: 1,
      handle: (event) => {
        (calls['test-recovers'] ||= []).push(event.event_id);
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('transient: downstream unavailable');
        }
      },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  const publish = (type: string, payload: Record<string, unknown> = {}) =>
    bus().publish(type, randomUUID(), { type: 'system', id: 'epic5-test' }, { org_id: orgId, ...payload });

  it('US5.2 — processes an event once per consumer and treats redelivery as a no-op', async () => {
    const event = await publish('Epic5ProbeEvent', { note: 'first' });
    expect(calls['test-reliable']).toContain(event.event_id);
    const afterFirst = calls['test-reliable'].length;

    // Same envelope delivered again: the handler must not run a second time.
    const registry = new EventConsumerRegistry();
    const repeat = await registry.dispatch('test-reliable', event);
    expect(repeat.outcome).toBe('skipped_duplicate');
    expect(calls['test-reliable']).toHaveLength(afterFirst);

    const consumption = await DatabaseService.getInstance().db.query<any>(
      `SELECT status, attempts FROM event_consumptions WHERE consumer = 'test-reliable' AND event_id = $1`,
      [event.event_id],
    );
    expect(consumption.rows[0]).toMatchObject({ status: 'processed' });
  });

  it('US5.2 — two concurrent deliveries of one event run the side effect once', async () => {
    // The reviewer's reproduction: a read-then-write check let both callers pass. The claim
    // is now a single statement, so exactly one of these wins the right to run the handler.
    const event = {
      event_id: randomUUID(),
      event_type: 'Epic5ProbeEvent',
      schema_version: 1,
      timestamp: new Date().toISOString(),
      actor: { type: 'system' as const, id: 'epic5-race' },
      work_item_id: randomUUID(),
      payload: { org_id: orgId },
    };

    const registry = new EventConsumerRegistry();
    const before = (calls['test-reliable'] || []).length;
    const [a, b] = await Promise.all([
      registry.dispatch('test-reliable', event),
      registry.dispatch('test-reliable', event),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['processed', 'skipped_duplicate']);
    expect((calls['test-reliable'] || []).length).toBe(before + 1);
    expect((calls['test-reliable'] || []).filter((id) => id === event.event_id)).toHaveLength(1);
  });

  it('US5.2 — recovers an abandoned processing claim on application startup', async () => {
    const event = {
      event_id: randomUUID(),
      event_type: 'Epic5ProbeEvent',
      schema_version: 1,
      timestamp: new Date().toISOString(),
      actor: { type: 'system' as const, id: 'epic5-recovery' },
      work_item_id: randomUUID(),
      payload: { org_id: orgId },
    };
    const registry = new EventConsumerRegistry();
    await DatabaseService.getInstance().db.query(
      `INSERT INTO event_consumptions
       (consumer, event_id, status, attempts, first_attempt_at, last_attempt_at)
       VALUES ('test-reliable', $1, 'processing', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [event.event_id],
    );

    // A persisted `processing` row at startup can only belong to the previous process.
    await registry.onModuleInit();
    const recovered = await registry.dispatch('test-reliable', event);

    expect(recovered.outcome).toBe('processed');
    expect((calls['test-reliable'] || []).filter((id) => id === event.event_id)).toHaveLength(1);
  });

  it('retries a transient failure and succeeds without dead-lettering', async () => {
    failuresRemaining = 1;
    const event = await publish('Epic5RecoverableEvent');

    // Two invocations: one that threw, one that succeeded.
    expect(calls['test-recovers'].filter((id) => id === event.event_id)).toHaveLength(2);

    const dlq = await request(server()).get('/dlq').set('x-org-id', orgId).expect(200);
    expect(dlq.body.find((e: any) => e.event_id === event.event_id)).toBeUndefined();
  });

  it('US5.3 — dead-letters after exhausting retries and raises a depth alert', async () => {
    bus().clearEmittedEvents();
    const event = await publish('Epic5FailingEvent', { detail: 'unprocessable' });

    // maxAttempts of 3 means three handler invocations, then the queue.
    expect(calls['test-always-fails'].filter((id) => id === event.event_id)).toHaveLength(3);

    const dlq = await request(server()).get('/dlq').set('x-org-id', orgId).expect(200);
    const entry = dlq.body.find((e: any) => e.event_id === event.event_id);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      consumer: 'test-always-fails',
      event_type: 'Epic5FailingEvent',
      attempts: 3,
      status: 'dead',
    });
    expect(entry.last_error).toContain('handler exploded');
    expect(entry.envelope.payload).toMatchObject({ detail: 'unprocessable' });

    // An alert fires whenever depth exceeds zero.
    const alert = bus().emittedEvents.find((e) => e.event_type === 'DeadLetterQueueAlert');
    expect(alert?.payload).toMatchObject({ consumer: 'test-always-fails', org_id: orgId });
    expect(alert?.payload.depth).toBeGreaterThan(0);

    const depth = await request(server()).get('/dlq/depth').set('x-org-id', orgId).expect(200);
    expect(depth.body.alerting).toBe(true);
    expect(depth.body.by_consumer['test-always-fails']).toBeGreaterThan(0);
    expect(depth.body.registered_consumers).toContain('notifications');
  });

  it('US5.5 — replays a corrected payload and clears the entry', async () => {
    failuresRemaining = 5; // exceeds maxAttempts, so this one lands in the queue
    const event = await publish('Epic5RecoverableEvent', { broken: true });

    const dlq = await request(server()).get('/dlq').set('x-org-id', orgId).expect(200);
    const entry = dlq.body.find((e: any) => e.event_id === event.event_id);
    expect(entry.status).toBe('dead');

    // The operator corrects the condition and re-injects with an amended payload.
    failuresRemaining = 0;
    const replay = await request(server())
      .post(`/dlq/${entry.id}/replay`)
      .set('x-org-id', orgId)
      .send({ payload: { org_id: orgId, broken: false, corrected_by: 'operator' } })
      .expect(201);

    expect(replay.body.outcome).toBe('processed');
    expect(replay.body.entry.status).toBe('replayed');
    expect(replay.body.entry.resolved_at).toBeTruthy();
    // Identity is preserved: a replay is the same event tried again, not a new one.
    expect(replay.body.entry.event_id).toBe(event.event_id);
    expect(replay.body.entry.envelope.payload).toMatchObject({ corrected_by: 'operator' });

    const depth = await request(server()).get('/dlq/depth').set('x-org-id', orgId).expect(200);
    expect(depth.body.by_consumer['test-recovers'] ?? 0).toBe(0);
  });

  it('keeps a failed replay in the queue rather than losing it', async () => {
    failuresRemaining = 99;
    const event = await publish('Epic5RecoverableEvent', { still: 'broken' });
    const dlq = await request(server()).get('/dlq?consumer=test-recovers').set('x-org-id', orgId).expect(200);
    const entry = dlq.body.find((e: any) => e.event_id === event.event_id);

    const replay = await request(server())
      .post(`/dlq/${entry.id}/replay`)
      .set('x-org-id', orgId)
      .send({})
      .expect(201);

    expect(replay.body.outcome).toBe('dead_lettered');
    expect(replay.body.entry.status).toBe('dead');
    expect(replay.body.entry.resolved_at).toBeNull();
    failuresRemaining = 0;
  });

  it('discards an abandoned entry so it stops counting toward depth', async () => {
    const before = await request(server()).get('/dlq/depth').set('x-org-id', orgId).expect(200);
    const dlq = await request(server())
      .get('/dlq?consumer=test-recovers&status=dead')
      .set('x-org-id', orgId)
      .expect(200);
    const entry = dlq.body[0];

    const discarded = await request(server())
      .post(`/dlq/${entry.id}/discard`)
      .set('x-org-id', orgId)
      .send({ reason: 'superseded by a later event' })
      .expect(201);

    expect(discarded.body.status).toBe('discarded');
    expect(discarded.body.last_error).toContain('superseded');

    const after = await request(server()).get('/dlq/depth').set('x-org-id', orgId).expect(200);
    expect(after.body.total).toBe(before.body.total - 1);
  });

  it('rejects replaying a discarded entry and an unknown id', async () => {
    const dlq = await request(server())
      .get('/dlq?status=discarded')
      .set('x-org-id', orgId)
      .expect(200);

    const rejected = await request(server())
      .post(`/dlq/${dlq.body[0].id}/replay`)
      .set('x-org-id', orgId)
      .send({})
      .expect(422);
    expect(rejected.body.message).toContain('discarded');

    await request(server())
      .post(`/dlq/${randomUUID()}/replay`)
      .set('x-org-id', orgId)
      .send({})
      .expect(404);

    await request(server()).get('/dlq').expect(400);
  });

  it('routes notification events through the framework rather than a bare subscription', async () => {
    expect(EventConsumerRegistry.registered()).toContain('notifications');
    // The production consumer is registered with the same contract the tests exercise,
    // so a persistent notification fault surfaces in the queue instead of a log line.
    expect(EventConsumerRegistry.get('notifications')?.eventTypes).toEqual(
      expect.arrayContaining(['SLAWarning', 'SLABreached', 'SLAEscalated']),
    );
  });
});
