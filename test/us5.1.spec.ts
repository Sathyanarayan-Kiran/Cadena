import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../src/database/database.service';
import { EventOutboxService } from '../src/modules/events/event-outbox.service';
import { InProcessEventBus } from '../src/modules/events/event-bus';
import { LineageService } from '../src/modules/lineage/lineage.service';
import { WorkItemService } from '../src/modules/work-items/work-item.service';
import { WorkflowService } from '../src/modules/workflow/workflow.service';

describe('US5.1 — transactional work-item event outbox', () => {
  const orgId = '51000000-0000-0000-0000-000000000001';
  const teamId = '51000000-0000-0000-0000-000000000002';
  const dbService = DatabaseService.getInstance();
  const bus = InProcessEventBus.getInstance();

  beforeAll(async () => {
    await dbService.initialize();
    await dbService.db.query(
      `INSERT INTO orgs (id, name) VALUES ($1, 'Outbox org') ON CONFLICT DO NOTHING`,
      [orgId],
    );
    await dbService.db.query(
      `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Outbox team') ON CONFLICT DO NOTHING`,
      [teamId, orgId],
    );
  });

  const createStory = (title: string) => new WorkItemService().createWorkItem({
    type: 'story',
    title,
    org_id: orgId,
    team_id: teamId,
  }, 'outbox-tester');

  async function storedOutboxEvent(workItemId: string, eventType: string): Promise<any> {
    const result = await dbService.db.query<any>(
      `SELECT event.event_id, event.event_type, event.org_id, event.payload,
              outbox.status, outbox.attempts, outbox.dispatched_at
       FROM domain_events event
       JOIN event_outbox outbox ON outbox.event_id = event.event_id
       WHERE event.work_item_id = $1 AND event.event_type = $2
       ORDER BY event.occurred_at DESC
       LIMIT 1`,
      [workItemId, eventType],
    );
    return result.rows[0];
  }

  it('commits WorkItemCreated and its immutable event as one dispatched unit', async () => {
    bus.clearEmittedEvents();
    const item = await createStory('Create and event commit together');

    const stored = await storedOutboxEvent(item.id, 'WorkItemCreated');
    expect(stored).toMatchObject({
      event_type: 'WorkItemCreated',
      org_id: orgId,
      status: 'dispatched',
      attempts: 1,
    });
    expect(stored.dispatched_at).toBeTruthy();
    expect(bus.emittedEvents.some((event) => event.event_id === stored.event_id)).toBe(true);
  });

  it('rolls back the state and audit write when the transition event cannot enter the outbox', async () => {
    const item = await createStory('Rollback transition on outbox failure');
    const failingOutbox = {
      enqueue: async () => { throw new Error('simulated outbox insert failure'); },
      dispatch: async () => true,
    } as unknown as EventOutboxService;

    await expect(new WorkflowService(failingOutbox).transitionWorkItem({
      workItemId: item.id,
      orgId,
      toState: 'Planned',
      actorId: 'outbox-tester',
      actorRole: 'developer',
    })).rejects.toThrow('simulated outbox insert failure');

    const persisted = await dbService.db.query<any>(
      `SELECT status FROM work_items WHERE id = $1`,
      [item.id],
    );
    const audits = await dbService.db.query<any>(
      `SELECT id FROM audit_events WHERE work_item_id = $1`,
      [item.id],
    );
    const events = await dbService.db.query<any>(
      `SELECT event_id FROM domain_events
       WHERE work_item_id = $1 AND event_type = 'WorkItemStateChanged'`,
      [item.id],
    );
    expect(persisted.rows[0].status).toBe('Proposed');
    expect(audits.rows).toHaveLength(0);
    expect(events.rows).toHaveLength(0);
  });

  it('commits state transitions and typed links with their outbox events', async () => {
    const source = await createStory('Source work item');
    const target = await createStory('Target work item');

    await new WorkflowService().transitionWorkItem({
      workItemId: source.id,
      orgId,
      toState: 'Planned',
      actorId: 'outbox-tester',
      actorRole: 'developer',
    });
    const stateEvent = await storedOutboxEvent(source.id, 'WorkItemStateChanged');
    expect(stateEvent).toMatchObject({ status: 'dispatched', attempts: 1, org_id: orgId });
    const statePayload = typeof stateEvent.payload === 'string'
      ? JSON.parse(stateEvent.payload)
      : stateEvent.payload;
    expect(statePayload).toMatchObject({ from_state: 'Proposed', to_state: 'Planned', org_id: orgId });

    await new LineageService().createLink(source.id, target.id, 'blocks', 'outbox-tester', orgId);
    const linkEvent = await storedOutboxEvent(source.id, 'LinkCreated');
    expect(linkEvent).toMatchObject({ status: 'dispatched', attempts: 1, org_id: orgId });
    const linkPayload = typeof linkEvent.payload === 'string'
      ? JSON.parse(linkEvent.payload)
      : linkEvent.payload;
    expect(linkPayload).toMatchObject({
      org_id: orgId,
      link: { source_id: source.id, target_id: target.id, link_type: 'blocks' },
    });
  });

  it('recovers a committed but undispatched envelope on application bootstrap without changing its id', async () => {
    const item = await createStory('Recover after commit-before-dispatch stop');
    const outbox = new EventOutboxService();
    const eventId = randomUUID();
    bus.clearEmittedEvents();

    await dbService.db.transaction((tx) => outbox.enqueue(tx, {
      event_id: eventId,
      event_type: 'US5.1RecoveryProbe',
      work_item_id: item.id,
      org_id: orgId,
      actor: { type: 'system', id: 'recovery-test' },
      payload: { org_id: orgId, committed: true },
    }));

    const before = await dbService.db.query<any>(
      `SELECT status, attempts FROM event_outbox WHERE event_id = $1`,
      [eventId],
    );
    expect(before.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(bus.emittedEvents.some((event) => event.event_id === eventId)).toBe(false);

    await outbox.onApplicationBootstrap();

    const after = await dbService.db.query<any>(
      `SELECT status, attempts, dispatched_at FROM event_outbox WHERE event_id = $1`,
      [eventId],
    );
    expect(after.rows[0]).toMatchObject({ status: 'dispatched', attempts: 1 });
    expect(after.rows[0].dispatched_at).toBeTruthy();
    expect(bus.emittedEvents.filter((event) => event.event_id === eventId)).toHaveLength(1);
    expect(await outbox.recoverPending()).toBe(0);
  });
});
