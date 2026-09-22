import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventOutboxService } from '../events/event-outbox.service';
import {
  CorrelationEntityInput,
  CorrelationGraph,
  CorrelationLink,
  CorrelationNode,
  CorrelationNotFoundError,
  CorrelationPairResult,
  CreateCorrelationDto,
  InvalidCorrelationError,
  UpdateCorrelationMetadataDto,
} from './correlation.types';

const MAX_CORRELATION_DEPTH = 10;
const TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const RELATIONSHIP_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Durable, tenant-scoped identity graph for records that remain authoritative elsewhere.
 *
 * Display keys and URLs may move; `(system, entity_type, immutable_id)` never does. Links
 * reference normalized nodes through tenant-qualified foreign keys, which makes an orphan or
 * cross-tenant edge impossible even if a future connector writes directly to these tables.
 */
@Injectable()
export class CorrelationService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();

  public async createPair(
    orgId: string,
    dto: CreateCorrelationDto,
    actorId: string,
  ): Promise<CorrelationPairResult> {
    await this.dbService.initialize();
    const sourceInput = this.normalizeEntity(dto?.source, 'source');
    const targetInput = this.normalizeEntity(dto?.target, 'target');
    const relationship = this.normalizeRelationship(dto?.relationship || 'counterpart');

    if (this.sameIdentity(sourceInput, targetInput)) {
      throw new InvalidCorrelationError('source and target must identify different records');
    }

    let pair!: CorrelationPairResult;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;

    await this.dbService.db.transaction(async (tx) => {
      const source = this.mapNode((await tx.query<any>(this.nodeUpsertSql(), [
        randomUUID(), orgId, sourceInput.system, sourceInput.entity_type,
        sourceInput.immutable_id, sourceInput.display_key, sourceInput.url,
      ])).rows[0]);
      const target = this.mapNode((await tx.query<any>(this.nodeUpsertSql(), [
        randomUUID(), orgId, targetInput.system, targetInput.entity_type,
        targetInput.immutable_id, targetInput.display_key, targetInput.url,
      ])).rows[0]);

      const existing = await this.findExistingLink(tx, orgId, source.id, target.id, relationship);
      let linkRow = existing;
      let created = false;
      if (!linkRow) {
        const inserted = await tx.query<any>(
          `INSERT INTO integration_correlation_links
           (id, org_id, source_node_id, target_node_id, relationship, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           RETURNING *`,
          [randomUUID(), orgId, source.id, target.id, relationship, actorId],
        );
        linkRow = inserted.rows[0];
        created = true;
      }

      const storedSource = linkRow.source_node_id === source.id ? source : target;
      const storedTarget = linkRow.target_node_id === target.id ? target : source;
      pair = {
        created,
        source,
        target,
        link: this.mapLink(linkRow, storedSource, storedTarget),
      };

      event = await this.outbox.enqueue(tx, {
        event_type: created ? 'CorrelationPairCreated' : 'CorrelationPairResolved',
        work_item_id: linkRow.id,
        org_id: orgId,
        actor: { type: 'integration', id: actorId },
        payload: {
          org_id: orgId,
          correlation_id: linkRow.id,
          relationship,
          created,
          source: this.eventIdentity(source),
          target: this.eventIdentity(target),
        },
      });
    });

    if (event) await this.outbox.dispatch(event);
    return pair;
  }

  public async resolve(
    orgId: string,
    system: string,
    entityType: string,
    immutableId: string,
    depth = MAX_CORRELATION_DEPTH,
  ): Promise<CorrelationGraph> {
    await this.dbService.initialize();
    const identity = this.normalizeEntity(
      { system, entity_type: entityType, immutable_id: immutableId },
      'identity',
    );
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_CORRELATION_DEPTH) {
      throw new InvalidCorrelationError(`depth must be an integer from 1 to ${MAX_CORRELATION_DEPTH}`);
    }

    const rootResult = await this.dbService.db.query<any>(
      `SELECT * FROM integration_correlation_nodes
       WHERE org_id = $1 AND system = $2 AND entity_type = $3 AND immutable_id = $4`,
      [orgId, identity.system, identity.entity_type, identity.immutable_id],
    );
    if (rootResult.rows.length === 0) {
      throw new CorrelationNotFoundError('Correlation identity not found');
    }

    const root = this.mapNode(rootResult.rows[0]);
    const nodes = new Map<string, CorrelationNode>([[root.id, { ...root, distance: 0 }]]);
    const links = new Map<string, CorrelationLink>();
    let frontier = [root.id];

    for (let distance = 1; distance <= depth && frontier.length > 0; distance += 1) {
      const placeholders = frontier.map((_, index) => `$${index + 2}`).join(', ');
      const result = await this.dbService.db.query<any>(
        `SELECT link.*,
                source.org_id AS source_org_id, source.system AS source_system,
                source.entity_type AS source_entity_type, source.immutable_id AS source_immutable_id,
                source.display_key AS source_display_key, source.url AS source_url,
                source.created_at AS source_created_at, source.updated_at AS source_updated_at,
                target.org_id AS target_org_id, target.system AS target_system,
                target.entity_type AS target_entity_type, target.immutable_id AS target_immutable_id,
                target.display_key AS target_display_key, target.url AS target_url,
                target.created_at AS target_created_at, target.updated_at AS target_updated_at
         FROM integration_correlation_links link
         JOIN integration_correlation_nodes source ON source.id = link.source_node_id AND source.org_id = link.org_id
         JOIN integration_correlation_nodes target ON target.id = link.target_node_id AND target.org_id = link.org_id
         WHERE link.org_id = $1
           AND (link.source_node_id IN (${placeholders}) OR link.target_node_id IN (${placeholders}))
         ORDER BY link.created_at ASC, link.id ASC`,
        [orgId, ...frontier],
      );

      const next: string[] = [];
      for (const row of result.rows) {
        const source = this.mapJoinedNode(row, 'source');
        const target = this.mapJoinedNode(row, 'target');
        if (!nodes.has(source.id)) {
          nodes.set(source.id, { ...source, distance });
          next.push(source.id);
        }
        if (!nodes.has(target.id)) {
          nodes.set(target.id, { ...target, distance });
          next.push(target.id);
        }
        if (!links.has(row.id)) links.set(row.id, this.mapLink(row, source, target));
      }
      frontier = next;
    }

    const nodeList = Array.from(nodes.values()).sort((a, b) =>
      (a.distance || 0) - (b.distance || 0)
      || a.system.localeCompare(b.system)
      || a.immutable_id.localeCompare(b.immutable_id));
    const linkList = Array.from(links.values()).filter((link) =>
      nodes.has(link.source_node_id) && nodes.has(link.target_node_id));

    return {
      root: { ...root, distance: 0 },
      depth,
      nodes: nodeList,
      links: linkList,
      summary: {
        node_count: nodeList.length,
        link_count: linkList.length,
        direct_counterparts: linkList.filter((link) =>
          link.relationship === 'counterpart'
          && (link.source_node_id === root.id || link.target_node_id === root.id)).length,
        max_distance: Math.max(...nodeList.map((node) => node.distance || 0)),
      },
    };
  }

  public async updateMetadata(
    orgId: string,
    nodeId: string,
    dto: UpdateCorrelationMetadataDto,
    actorId: string,
  ): Promise<CorrelationNode> {
    await this.dbService.initialize();
    if (!this.isUuid(nodeId)) throw new InvalidCorrelationError('node id must be a UUID');
    const input = dto as Record<string, unknown> | null;
    if (!input || (!Object.hasOwn(input, 'display_key') && !Object.hasOwn(input, 'url'))) {
      throw new InvalidCorrelationError('display_key or url is required');
    }
    for (const immutableField of ['system', 'entity_type', 'immutable_id']) {
      if (Object.hasOwn(input, immutableField)) {
        throw new InvalidCorrelationError(`${immutableField} is immutable; create a new identity instead`);
      }
    }

    const displayKey = this.optionalText(dto.display_key, 'display_key');
    const url = this.optionalText(dto.url, 'url');
    let updated!: CorrelationNode;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;

    await this.dbService.db.transaction(async (tx) => {
      const existing = await tx.query<any>(
        `SELECT * FROM integration_correlation_nodes WHERE id = $1 AND org_id = $2`,
        [nodeId, orgId],
      );
      if (existing.rows.length === 0) throw new CorrelationNotFoundError('Correlation node not found');
      const before = this.mapNode(existing.rows[0]);
      const result = await tx.query<any>(
        `UPDATE integration_correlation_nodes
         SET display_key = CASE WHEN $3 THEN $4 ELSE display_key END,
             url = CASE WHEN $5 THEN $6 ELSE url END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND org_id = $2
         RETURNING *`,
        [
          nodeId,
          orgId,
          Object.hasOwn(input, 'display_key'),
          displayKey,
          Object.hasOwn(input, 'url'),
          url,
        ],
      );
      updated = this.mapNode(result.rows[0]);
      event = await this.outbox.enqueue(tx, {
        event_type: 'CorrelationMetadataUpdated',
        work_item_id: nodeId,
        org_id: orgId,
        actor: { type: 'integration', id: actorId },
        payload: {
          org_id: orgId,
          identity: this.eventIdentity(updated),
          before: { display_key: before.display_key, url: before.url },
          after: { display_key: updated.display_key, url: updated.url },
        },
      });
    });

    if (event) await this.outbox.dispatch(event);
    return updated;
  }

  private nodeUpsertSql(): string {
    return `INSERT INTO integration_correlation_nodes
            (id, org_id, system, entity_type, immutable_id, display_key, url, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (org_id, system, entity_type, immutable_id)
            DO UPDATE SET
              display_key = COALESCE(EXCLUDED.display_key, integration_correlation_nodes.display_key),
              url = COALESCE(EXCLUDED.url, integration_correlation_nodes.url),
              updated_at = CASE
                WHEN EXCLUDED.display_key IS NOT NULL OR EXCLUDED.url IS NOT NULL
                  THEN CURRENT_TIMESTAMP
                ELSE integration_correlation_nodes.updated_at
              END
            RETURNING *`;
  }

  private async findExistingLink(
    tx: any,
    orgId: string,
    sourceId: string,
    targetId: string,
    relationship: string,
  ): Promise<any | null> {
    const symmetric = relationship === 'counterpart';
    const result = await tx.query(
      `SELECT * FROM integration_correlation_links
       WHERE org_id = $1 AND relationship = $4
         AND ((source_node_id = $2 AND target_node_id = $3)
              OR ($5 AND source_node_id = $3 AND target_node_id = $2))
       LIMIT 1`,
      [orgId, sourceId, targetId, relationship, symmetric],
    );
    return result.rows[0] || null;
  }

  private normalizeEntity(input: CorrelationEntityInput | undefined, label: string): CorrelationEntityInput {
    if (!input || typeof input !== 'object') {
      throw new InvalidCorrelationError(`${label} is required`);
    }
    const system = this.requiredToken(input.system, `${label}.system`);
    const entityType = this.requiredToken(input.entity_type, `${label}.entity_type`);
    const immutableId = this.requiredText(input.immutable_id, `${label}.immutable_id`);
    return {
      system,
      entity_type: entityType,
      immutable_id: immutableId,
      display_key: this.optionalText(input.display_key, `${label}.display_key`),
      url: this.optionalText(input.url, `${label}.url`),
    };
  }

  private normalizeRelationship(value: unknown): string {
    const normalized = this.requiredText(value, 'relationship').toLowerCase();
    if (!RELATIONSHIP_PATTERN.test(normalized)) {
      throw new InvalidCorrelationError('relationship must start with a letter and contain only lowercase letters, digits, or underscores');
    }
    return normalized;
  }

  private requiredToken(value: unknown, field: string): string {
    const normalized = this.requiredText(value, field).toLowerCase();
    if (!TOKEN_PATTERN.test(normalized)) {
      throw new InvalidCorrelationError(`${field} must start with a letter and contain only letters, digits, dots, dashes, or underscores`);
    }
    return normalized;
  }

  private requiredText(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new InvalidCorrelationError(`${field} is required`);
    }
    const normalized = value.trim();
    if (normalized.length > 512) throw new InvalidCorrelationError(`${field} must be 512 characters or fewer`);
    return normalized;
  }

  private optionalText(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new InvalidCorrelationError(`${field} must be a string or null`);
    const normalized = value.trim();
    if (normalized.length > 2048) throw new InvalidCorrelationError(`${field} is too long`);
    return normalized || null;
  }

  private sameIdentity(left: CorrelationEntityInput, right: CorrelationEntityInput): boolean {
    return left.system === right.system
      && left.entity_type === right.entity_type
      && left.immutable_id === right.immutable_id;
  }

  private eventIdentity(node: CorrelationNode) {
    return {
      node_id: node.id,
      system: node.system,
      entity_type: node.entity_type,
      immutable_id: node.immutable_id,
      display_key: node.display_key,
    };
  }

  private mapNode(row: any): CorrelationNode {
    return {
      id: row.id,
      org_id: row.org_id,
      system: row.system,
      entity_type: row.entity_type,
      immutable_id: row.immutable_id,
      display_key: row.display_key ?? null,
      url: row.url ?? null,
      created_at: this.toIso(row.created_at),
      updated_at: this.toIso(row.updated_at),
    };
  }

  private mapJoinedNode(row: any, side: 'source' | 'target'): CorrelationNode {
    return this.mapNode({
      id: row[`${side}_node_id`],
      org_id: row[`${side}_org_id`],
      system: row[`${side}_system`],
      entity_type: row[`${side}_entity_type`],
      immutable_id: row[`${side}_immutable_id`],
      display_key: row[`${side}_display_key`],
      url: row[`${side}_url`],
      created_at: row[`${side}_created_at`],
      updated_at: row[`${side}_updated_at`],
    });
  }

  private mapLink(row: any, source: CorrelationNode, target: CorrelationNode): CorrelationLink {
    return {
      id: row.id,
      org_id: row.org_id,
      source_node_id: row.source_node_id,
      target_node_id: row.target_node_id,
      relationship: row.relationship,
      created_by: row.created_by,
      created_at: this.toIso(row.created_at),
      references: {
        source: {
          node_id: source.id,
          system: source.system,
          field: 'cadena_counterpart_id',
          value: target.immutable_id,
        },
        target: {
          node_id: target.id,
          system: target.system,
          field: 'cadena_counterpart_id',
          value: source.immutable_id,
        },
      },
    };
  }

  private toIso(value: any): string {
    return typeof value === 'string' ? new Date(value).toISOString() : new Date(value).toISOString();
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}

export { MAX_CORRELATION_DEPTH };
