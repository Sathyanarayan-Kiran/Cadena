import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import type { FlowBucket } from './flow-profile';

export const CLASSIFICATIONS = ['active', 'waiting', 'blocked', 'unclassified'] as const;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidClassificationError extends Error {}

export interface ClassificationRow {
  id: string;
  team_id: string | null;
  state: string;
  classification: FlowBucket;
  version: number;
  changed_by: string;
  created_at: string;
}

export interface ResolvedClassification {
  classification: FlowBucket;
  version: number | null;
  scope: 'team' | 'org' | 'none';
}

export type ClassificationResolver = (teamId: string | null, state: string) => ResolvedClassification;

const toRow = (row: any): ClassificationRow => ({
  id: row.id,
  team_id: row.team_id ?? null,
  state: row.state,
  classification: row.classification,
  version: Number(row.version),
  changed_by: row.changed_by,
  created_at: new Date(row.created_at).toISOString(),
});

/**
 * Which workflow states are worked, waiting or blocked (US21.1).
 *
 * Classification is a lens over recorded history, never an edit of it: each change appends a new version
 * (audited through the event store) and later calculations use the current version. A team row overrides the
 * org-wide default for that state, and a state with neither is `unclassified`, which is never treated as active.
 */
@Injectable()
export class FlowClassificationService {
  private readonly dbService = DatabaseService.getInstance();
  private readonly outbox = new EventOutboxService();

  /** Current classification per (team, state) for an org, optionally only one scope. */
  public async list(orgId: string, teamId?: string | null): Promise<ClassificationRow[]> {
    await this.dbService.initialize();
    if (teamId) this.requireUuid(teamId, 'team_id');
    const result = await this.dbService.db.query<any>(
      `SELECT DISTINCT ON (COALESCE(team_id, $2::uuid), state) *
       FROM flow_state_classifications
       WHERE org_id = $1 ${teamId === undefined ? '' : teamId === null ? 'AND team_id IS NULL' : 'AND team_id = $3'}
       ORDER BY COALESCE(team_id, $2::uuid), state, version DESC`,
      teamId ? [orgId, NIL_UUID, teamId] : [orgId, NIL_UUID],
    );
    return result.rows.map(toRow);
  }

  public async history(orgId: string, filter: { teamId?: string | null; state?: string }): Promise<ClassificationRow[]> {
    await this.dbService.initialize();
    const params: unknown[] = [orgId];
    let where = 'org_id = $1';
    if (filter.teamId) {
      this.requireUuid(filter.teamId, 'team_id');
      params.push(filter.teamId);
      where += ` AND team_id = $${params.length}`;
    } else if (filter.teamId === null) {
      where += ' AND team_id IS NULL';
    }
    if (filter.state) {
      params.push(filter.state);
      where += ` AND state = $${params.length}`;
    }
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM flow_state_classifications WHERE ${where} ORDER BY created_at DESC, version DESC, state`,
      params,
    );
    return result.rows.map(toRow);
  }

  /**
   * Sets states for one scope (`teamId` null is the org default). A state whose classification already
   * matches the current version is left alone, so re-saving an unchanged form creates no history.
   */
  public async set(
    orgId: string,
    actorId: string,
    teamId: string | null,
    states: Array<{ state?: unknown; classification?: unknown }>,
  ): Promise<{ changed: ClassificationRow[]; unchanged: number }> {
    await this.dbService.initialize();
    if (!Array.isArray(states) || states.length === 0) throw new InvalidClassificationError('states must be a non-empty array');
    if (states.length > 200) throw new InvalidClassificationError('at most 200 states can be classified per request');

    const parsed = new Map<string, FlowBucket>();
    for (const entry of states) {
      const state = typeof entry?.state === 'string' ? entry.state.trim() : '';
      if (!state) throw new InvalidClassificationError('every entry needs a non-empty state');
      if (!CLASSIFICATIONS.includes(entry.classification as FlowBucket)) {
        throw new InvalidClassificationError(`classification for '${state}' must be one of: ${CLASSIFICATIONS.join(', ')}`);
      }
      if (parsed.has(state)) throw new InvalidClassificationError(`state '${state}' is listed more than once`);
      parsed.set(state, entry.classification as FlowBucket);
    }
    if (teamId !== null) {
      this.requireUuid(teamId, 'team_id');
      const team = await this.dbService.db.query<any>(`SELECT id FROM teams WHERE id = $1 AND org_id = $2`, [teamId, orgId]);
      if (!team.rows.length) throw new InvalidClassificationError('team_id does not belong to this organization');
    }

    // Read current versions before opening the transaction: PGlite serializes callers of one connection.
    const current = new Map((await this.list(orgId, teamId)).map((row) => [row.state, row]));
    const events: Array<Awaited<ReturnType<EventOutboxService['enqueue']>>> = [];
    const changed: ClassificationRow[] = [];
    let unchanged = 0;

    await this.dbService.db.transaction(async (tx) => {
      for (const [state, classification] of parsed) {
        const previous = current.get(state);
        // A first "unclassified" on a scope with nothing to override records nothing worth versioning.
        if (previous ? previous.classification === classification : classification === 'unclassified' && teamId === null) {
          unchanged += 1;
          continue;
        }
        const id = randomUUID();
        const version = (previous?.version ?? 0) + 1;
        const inserted = await tx.query<any>(
          `INSERT INTO flow_state_classifications (id, org_id, team_id, state, classification, version, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [id, orgId, teamId, state, classification, version, actorId],
        );
        const row = toRow(inserted.rows[0]);
        changed.push(row);
        events.push(await this.outbox.enqueue(tx, {
          event_type: 'FlowClassificationChanged',
          work_item_id: id,
          org_id: orgId,
          actor: { type: 'user', id: actorId },
          payload: {
            org_id: orgId,
            team_id: teamId,
            state,
            before: previous ? { classification: previous.classification, version: previous.version } : null,
            after: { classification, version },
          },
        }));
      }
    });
    for (const event of events) await this.outbox.dispatch(event);
    return { changed, unchanged };
  }

  /** A synchronous lookup over the current rows, so a report resolves thousands of intervals with one query. */
  public async resolver(orgId: string): Promise<ClassificationResolver> {
    const rows = await this.list(orgId);
    const byKey = new Map(rows.map((row) => [`${row.team_id ?? ''}|${row.state}`, row]));
    return (teamId, state) => {
      const team = teamId ? byKey.get(`${teamId}|${state}`) : undefined;
      const hit = team ?? byKey.get(`|${state}`);
      if (!hit) return { classification: 'unclassified', version: null, scope: 'none' };
      return { classification: hit.classification, version: hit.version, scope: hit.team_id ? 'team' : 'org' };
    };
  }

  private requireUuid(value: string, field: string): void {
    if (!UUID.test(value)) throw new InvalidClassificationError(`${field} must be a UUID`);
  }
}
