import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { PublishedWorkflowRecord, WorkflowDefinition } from './workflow.types';

export class InvalidWorkflowDefinitionError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid WorkflowDefinition: ${errors.join('; ')}`);
    this.name = 'InvalidWorkflowDefinitionError';
  }
}

export class WorkflowService {
  private dbService = DatabaseService.getInstance();

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

    // Check transition states validity
    const stateSet = new Set(def.states);
    for (const tr of def.transitions || []) {
      if (!stateSet.has(tr.from)) {
        errors.push(`transition source state '${tr.from}' is not in declared states`);
      }
      if (!stateSet.has(tr.to)) {
        errors.push(`transition target state '${tr.to}' is not in declared states`);
      }
    }

    // Reachability Analysis from initial_state
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
      const neighbors = adjMap.get(curr) || [];
      for (const next of neighbors) {
        if (!reachableFromInitial.has(next)) {
          reachableFromInitial.add(next);
          queue.push(next);
        }
      }
    }

    // Identify unreachable states
    const unreachableStates = def.states.filter((s) => !reachableFromInitial.has(s));
    if (unreachableStates.length > 0) {
      errors.push(`unreachable state(s) detected: ${unreachableStates.join(', ')}`);
    }

    // Verify all non-terminal states can reach at least one terminal state
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
    if (!res.rows || res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      id: row.id,
      type: row.type,
      version: row.version,
      definition: typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition,
      created_at: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    };
  }
}
