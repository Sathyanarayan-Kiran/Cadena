import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import { SlaCalculatorService, SlaCalendar } from '../sla/sla-calculator.service';
import { PublishedWorkflowRecord, WorkflowDefinition } from './workflow.types';

const BUILT_IN_WORKFLOWS: Record<string, WorkflowDefinition> = {
  epic: {
    type: 'epic',
    states: ['Proposed', 'Planned', 'In Progress', 'In Review', 'Blocked', 'Done', 'Verified', 'Closed', 'Reopened'],
    initial_state: 'Proposed',
    terminal_states: ['Closed'],
    transitions: [
      { from: 'Proposed', to: 'Planned' },
      { from: 'Planned', to: 'In Progress' },
      { from: 'In Progress', to: 'In Review' },
      { from: 'In Review', to: 'Blocked' },
      { from: 'Blocked', to: 'In Progress' },
      { from: 'In Review', to: 'Done' },
      { from: 'Done', to: 'Verified' },
      { from: 'Verified', to: 'Closed' },
      { from: 'Closed', to: 'Reopened' },
      { from: 'Reopened', to: 'In Progress' },
    ],
  },
  story: {
    type: 'story',
    states: ['Proposed', 'Planned', 'In Progress', 'In Review', 'Blocked', 'Done', 'Verified', 'Closed', 'Reopened'],
    initial_state: 'Proposed',
    terminal_states: ['Closed'],
    transitions: [
      { from: 'Proposed', to: 'Planned' },
      { from: 'Planned', to: 'In Progress' },
      { from: 'In Progress', to: 'In Review' },
      { from: 'In Review', to: 'Blocked' },
      { from: 'Blocked', to: 'In Progress' },
      { from: 'In Review', to: 'Done' },
      { from: 'Done', to: 'Verified' },
      { from: 'Verified', to: 'Closed' },
      { from: 'Closed', to: 'Reopened' },
      { from: 'Reopened', to: 'In Progress' },
    ],
  },
  incident: {
    type: 'incident',
    states: ['Triaged', 'Investigating', 'Mitigated', 'Resolved', 'Post-incident Review', 'Closed'],
    initial_state: 'Triaged',
    terminal_states: ['Closed'],
    transitions: [
      { from: 'Triaged', to: 'Investigating', guard: 'actor.role in [on_call, incident_commander]' },
      { from: 'Investigating', to: 'Mitigated', requires_fields: ['mitigation_summary'] },
      { from: 'Mitigated', to: 'Resolved', guard: 'incident_commander' },
      { from: 'Resolved', to: 'Post-incident Review' },
      { from: 'Post-incident Review', to: 'Closed' },
    ],
  },
  release: {
    type: 'release',
    states: ['Draft', 'Ready', 'Deployed', 'Closed'],
    initial_state: 'Draft',
    terminal_states: ['Closed'],
    transitions: [
      { from: 'Draft', to: 'Ready' },
      { from: 'Ready', to: 'Deployed' },
      { from: 'Deployed', to: 'Closed' },
    ],
  },
};

export class InvalidWorkflowDefinitionError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid WorkflowDefinition: ${errors.join('; ')}`);
    this.name = 'InvalidWorkflowDefinitionError';
  }
}

export class GuardFailedError extends Error {
  public readonly missing_role: string;
  constructor(missingRole: string, reason?: string) {
    super(reason || `actor lacks role '${missingRole}'`);
    this.name = 'GuardFailedError';
    this.missing_role = missingRole;
  }
}

export class MissingRequiredFieldsError extends Error {
  public readonly missing_fields: string[];
  constructor(missingFields: string[]) {
    super(`missing required field(s): ${missingFields.join(', ')}`);
    this.name = 'MissingRequiredFieldsError';
    this.missing_fields = missingFields;
  }
}

export class InvalidTransitionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTransitionError';
  }
}

export interface TransitionContext {
  workItemId: string;
  orgId: string;
  toState: string;
  actorId: string;
  actorRole: string;
  actorType?: 'user' | 'system' | 'integration';
  fields?: Record<string, any>;
}

export class WorkflowService {
  private dbService = DatabaseService.getInstance();
  private slaCalculator = new SlaCalculatorService();

  constructor(private readonly outbox = new EventOutboxService()) {}

  public validateWorkflowDefinition(def: WorkflowDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!def.states || !Array.isArray(def.states) || def.states.length === 0) {
      errors.push('workflow must define at least one state in states array');
    }

    if (!def.initial_state) {
      errors.push('missing initial_state');
    } else if (!def.states?.includes(def.initial_state)) {
      errors.push(`initial_state '${def.initial_state}' is not declared in states list`);
    }

    if (!def.terminal_states || !Array.isArray(def.terminal_states) || def.terminal_states.length === 0) {
      errors.push('missing terminal state');
    } else {
      for (const term of def.terminal_states) {
        if (!def.states?.includes(term)) {
          errors.push(`terminal state '${term}' is not declared in states list`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    const stateSet = new Set(def.states);
    for (const tr of def.transitions || []) {
      if (!stateSet.has(tr.from)) {
        errors.push(`transition source state '${tr.from}' is not in declared states`);
      }
      if (!stateSet.has(tr.to)) {
        errors.push(`transition target state '${tr.to}' is not in declared states`);
      }
    }

    const reachableFromInitial = new Set<string>();
    const queue: string[] = [def.initial_state];
    reachableFromInitial.add(def.initial_state);

    const adjMap = new Map<string, string[]>();
    for (const s of def.states) adjMap.set(s, []);
    for (const tr of def.transitions || []) {
      if (adjMap.has(tr.from)) {
        adjMap.get(tr.from)!.push(tr.to);
      }
    }

    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const next of adjMap.get(curr) || []) {
        if (!reachableFromInitial.has(next)) {
          reachableFromInitial.add(next);
          queue.push(next);
        }
      }
    }

    const unreachableStates = def.states.filter((s) => !reachableFromInitial.has(s));
    if (unreachableStates.length > 0) {
      errors.push(`unreachable state(s) detected: ${unreachableStates.join(', ')}`);
    }

    const terminalSet = new Set(def.terminal_states);
    for (const s of def.states) {
      if (terminalSet.has(s)) continue;

      const visited = new Set<string>();
      const q: string[] = [s];
      visited.add(s);
      let canReachTerminal = false;

      while (q.length > 0) {
        const curr = q.shift()!;
        if (terminalSet.has(curr)) {
          canReachTerminal = true;
          break;
        }
        for (const next of adjMap.get(curr) || []) {
          if (!visited.has(next)) {
            visited.add(next);
            q.push(next);
          }
        }
      }

      if (!canReachTerminal) {
        errors.push(`state '${s}' cannot reach any terminal state`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  public async publishWorkflow(def: WorkflowDefinition): Promise<PublishedWorkflowRecord> {
    const val = this.validateWorkflowDefinition(def);
    if (!val.valid) {
      throw new InvalidWorkflowDefinitionError(val.errors);
    }

    await this.dbService.initialize();

    const res = await this.dbService.db.query<any>(
      `SELECT MAX(version) as max_version FROM workflow_definitions WHERE type = $1`,
      [def.type],
    );
    const nextVersion = (res.rows?.[0]?.max_version || 0) + 1;
    const id = randomUUID();

    await this.dbService.db.query(
      `INSERT INTO workflow_definitions (id, type, version, definition, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [id, def.type, nextVersion, JSON.stringify(def)],
    );

    return {
      id,
      type: def.type,
      version: nextVersion,
      definition: def,
      created_at: new Date().toISOString(),
    };
  }

  public async getWorkflowDefinition(type: string, version?: number): Promise<PublishedWorkflowRecord | null> {
    await this.dbService.initialize();

    let query: string;
    let params: any[];

    if (version) {
      query = `SELECT * FROM workflow_definitions WHERE type = $1 AND version = $2 LIMIT 1`;
      params = [type, version];
    } else {
      query = `SELECT * FROM workflow_definitions WHERE type = $1 ORDER BY version DESC LIMIT 1`;
      params = [type];
    }

    const res = await this.dbService.db.query<any>(query, params);
    if (!res.rows || res.rows.length === 0) {
      const builtIn = BUILT_IN_WORKFLOWS[type];
      if (builtIn && (!version || version === 1)) {
        return {
          id: `built-in:${type}`,
          type,
          version: 1,
          definition: builtIn,
          created_at: '2026-09-18T00:00:00.000Z',
        };
      }
      return null;
    }

    const row = res.rows[0];
    return {
      id: row.id,
      type: row.type,
      version: row.version,
      definition: typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition,
      created_at: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    };
  }

  public async transitionWorkItem(ctx: TransitionContext): Promise<any> {
    await this.dbService.initialize();

    // 1. Fetch work item
    const itemRes = await this.dbService.db.query<any>(
      `SELECT * FROM work_items WHERE id = $1 AND org_id = $2`,
      [ctx.workItemId, ctx.orgId],
    );
    if (!itemRes.rows || itemRes.rows.length === 0) {
      throw new InvalidTransitionError(`Work item '${ctx.workItemId}' not found`);
    }

    const item = itemRes.rows[0];
    const fromState = item.status;
    const itemType = item.type;
    const workflowVersion = item.workflow_version;
    const currentCustomFields = typeof item.custom_fields === 'string' ? JSON.parse(item.custom_fields) : item.custom_fields || {};
    const suppliedFields = ctx.fields || {};
    const mergedFields = { ...currentCustomFields, ...suppliedFields };

    // 2. Fetch Workflow Definition for item's workflow_version
    const wf = await this.getWorkflowDefinition(itemType, workflowVersion);
    const transitions = wf?.definition?.transitions || [];

    // Find matching transition rule
    const matchingRule = transitions.find(
      (t: any) => t.from === fromState && t.to === ctx.toState,
    );

    if (!matchingRule) {
      throw new InvalidTransitionError(`Transition from '${fromState}' to '${ctx.toState}' is not allowed for type '${itemType}' v${workflowVersion}`);
    }

    // 3. Evaluate Role Guard if specified on rule
    if (matchingRule?.guard) {
      this.evaluateRoleGuard(matchingRule.guard, ctx.actorRole);
    }

    // 4. Evaluate Required Fields
    const requiredFields = matchingRule?.requires_fields || [];
    const missingFields: string[] = [];
    for (const reqField of requiredFields) {
      if (mergedFields[reqField] === undefined || mergedFields[reqField] === null || mergedFields[reqField] === '') {
        missingFields.push(reqField);
      }
    }

    if (missingFields.length > 0) {
      throw new MissingRequiredFieldsError(missingFields);
    }

    // 5. Apply State Transition
    const now = new Date().toISOString();
    const policyResult = await this.dbService.db.query<any>(
      `SELECT state, calendar, suspend_sla
       FROM sla_policies
       WHERE org_id = $1 AND item_type = $2 AND (state = $3 OR state = $4)`,
      [ctx.orgId, itemType, fromState, ctx.toState],
    );
    const policies = new Map<string, { calendar: SlaCalendar; suspend_sla: boolean }>();
    for (const row of policyResult.rows || []) {
      policies.set(row.state, { calendar: row.calendar, suspend_sla: Boolean(row.suspend_sla) });
    }

    const fromPolicy = policies.get(fromState);
    const targetPolicy = policies.get(ctx.toState);
    const wasSuspended = Boolean(item.sla_suspended);
    let elapsedBase = Number(item.sla_elapsed_minutes || 0);
    let clockStartedAt: string | null = item.sla_clock_started_at
      ? new Date(item.sla_clock_started_at).toISOString()
      : null;
    let suspended = false;

    if (targetPolicy?.suspend_sla) {
      if (!wasSuspended && fromPolicy) {
        elapsedBase += this.slaCalculator.calculateElapsedMinutes(
          new Date(clockStartedAt || item.entered_state_at || item.created_at),
          new Date(now),
          fromPolicy.calendar,
        );
      }
      suspended = true;
      clockStartedAt = null;
    } else if (wasSuspended) {
      // Leaving a hold state preserves the accumulated duration and starts a fresh active
      // interval. The paused wall-clock gap is therefore never back-filled.
      suspended = false;
      // entered_state_at is written to the same instant below, so a second timestamp is
      // unnecessary. Keeping it null also preserves the established test/fixture contract
      // where backdating entered_state_at controls a normal active clock.
      clockStartedAt = null;
    } else {
      // Normal state changes retain the platform's existing time-in-state semantics.
      elapsedBase = 0;
      suspended = false;
      clockStartedAt = null;
    }

    // 6. Record Audit Event
    const auditId = randomUUID();
    const auditPayload = {
      from_state: fromState,
      to_state: ctx.toState,
      fields: suppliedFields,
    };
    // Additive per US5.1: consumers need the tenant to route or aggregate a transition,
    // and the spec §8.2 envelope has no org field, so it travels in the payload.
    const eventPayload = { ...auditPayload, org_id: ctx.orgId, item_type: itemType };

    const event = await this.dbService.db.transaction(async (tx) => {
      const updated = await tx.query<any>(
        `UPDATE work_items
         SET status = $1,
             entered_state_at = $2,
             custom_fields = $3,
             updated_at = $4,
             sla_elapsed_minutes = $5,
             sla_clock_started_at = $6,
             sla_suspended = $7
         WHERE id = $8 AND org_id = $9 AND status = $10
         RETURNING id`,
        [
          ctx.toState, now, JSON.stringify(mergedFields), now, elapsedBase,
          clockStartedAt, suspended, ctx.workItemId, ctx.orgId, fromState,
        ],
      );
      if (updated.rows.length === 0) {
        throw new InvalidTransitionError('Work item changed before this transition could commit; retry against its current state');
      }

      await tx.query(
        `INSERT INTO audit_events (id, event_type, work_item_id, actor_id, payload, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auditId, 'WorkItemStateChanged', ctx.workItemId, ctx.actorId, JSON.stringify(auditPayload), now],
      );

      return this.outbox.enqueue(tx, {
        event_type: 'WorkItemStateChanged',
        work_item_id: ctx.workItemId,
        org_id: ctx.orgId,
        actor: { type: ctx.actorType || 'user', id: ctx.actorId },
        payload: eventPayload,
        timestamp: now,
      });
    });

    // Publication is deliberately after commit. A stop in this gap is recovered from the
    // pending outbox row with the same event id.
    await this.outbox.dispatch(event);

    return {
      id: ctx.workItemId,
      from_state: fromState,
      to_state: ctx.toState,
      status: ctx.toState,
      custom_fields: mergedFields,
      updated_at: now,
    };
  }

  public async getAvailableTransitions(workItemId: string, orgId: string): Promise<{
    current_state: string;
    transitions: Array<{ to_state: string; requires_fields: string[]; guard?: unknown }>;
  }> {
    await this.dbService.initialize();
    const itemRes = await this.dbService.db.query<any>(
      `SELECT type, status, workflow_version FROM work_items WHERE id = $1 AND org_id = $2`,
      [workItemId, orgId],
    );
    if (!itemRes.rows || itemRes.rows.length === 0) {
      throw new InvalidTransitionError(`Work item '${workItemId}' not found`);
    }

    const item = itemRes.rows[0];
    const workflow = await this.getWorkflowDefinition(item.type, item.workflow_version);
    const transitions = (workflow?.definition.transitions || [])
      .filter((transition) => transition.from === item.status)
      .map((transition) => ({
        to_state: transition.to,
        requires_fields: transition.requires_fields || [],
        guard: transition.guard,
      }));

    return { current_state: item.status, transitions };
  }

  private evaluateRoleGuard(guard: any, actorRole: string): void {
    let allowedRoles: string[] = [];
    let requiredRoleName = 'qualified_role';

    if (typeof guard === 'string') {
      // e.g. "actor.role in [on_call, incident_commander]" or "role:incident_commander"
      if (guard.includes('in [')) {
        const matches = guard.match(/in\s*\[(.*?)\]/);
        if (matches && matches[1]) {
          allowedRoles = matches[1].split(',').map((r) => r.trim());
          requiredRoleName = allowedRoles.join(' or ');
        }
      } else if (guard.includes(':')) {
        const role = guard.split(':')[1].trim();
        allowedRoles = [role];
        requiredRoleName = role;
      } else {
        allowedRoles = [guard];
        requiredRoleName = guard;
      }
    } else if (typeof guard === 'object') {
      if (guard.role) {
        allowedRoles = [guard.role];
        requiredRoleName = guard.role;
      } else if (guard.roles && Array.isArray(guard.roles)) {
        allowedRoles = guard.roles;
        requiredRoleName = guard.roles.join(' or ');
      }
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(actorRole)) {
      throw new GuardFailedError(requiredRoleName, `actor lacks role '${requiredRoleName}'`);
    }
  }
}
