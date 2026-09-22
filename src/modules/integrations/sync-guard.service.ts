import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { stableStringify } from '../audit/audit-integrity';
import { EventOutboxService } from '../events/event-outbox.service';
import {
  EvaluateSyncWebhookDto,
  InvalidSyncGuardError,
  RecordIntegrationWriteDto,
  SyncGuardDecision,
  SyncIdentity,
  SyncIdentityNotFoundError,
} from './sync-guard.types';

const SUPPRESSION_WINDOW_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

interface VolatileWriteMarker {
  expiresAt: number;
}

interface SyncNode extends SyncIdentity {
  id: string;
}

/**
 * Prevents a bidirectional connector from processing its own outbound write on return.
 *
 * The actor+hash marker is deliberately volatile and fast. The last normalized content is
 * deliberately durable. Losing every in-memory marker on restart therefore changes the
 * explanation (`content_noop`) but never changes the safe decision (`ignore`).
 */
@Injectable()
export class SyncGuardService {
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private recentWrites = new Map<string, VolatileWriteMarker>();

  public async recordIntegrationWrite(orgId: string, dto: RecordIntegrationWriteDto) {
    await this.dbService.initialize();
    const identity = this.normalizeIdentity(dto?.identity);
    const serviceAccountId = this.requiredText(dto?.service_account_id, 'service_account_id', 256);
    const payload = this.normalizePayload(dto?.payload);
    const payloadHash = this.hashPayload(payload);
    const node = await this.requireNode(orgId, identity);
    const recordedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SUPPRESSION_WINDOW_MS).toISOString();
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;

    await this.dbService.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO integration_sync_snapshots
         (org_id, node_id, payload_hash, canonical_payload, observed_actor_id,
          observation_source, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'outbound_write', $6)
         ON CONFLICT (org_id, node_id)
         DO UPDATE SET payload_hash = EXCLUDED.payload_hash,
                       canonical_payload = EXCLUDED.canonical_payload,
                       observed_actor_id = EXCLUDED.observed_actor_id,
                       observation_source = EXCLUDED.observation_source,
                       updated_at = EXCLUDED.updated_at`,
        [orgId, node.id, payloadHash, JSON.stringify(payload), serviceAccountId, recordedAt],
      );
      event = await this.outbox.enqueue(tx, {
        event_type: 'IntegrationWriteRecorded',
        work_item_id: node.id,
        org_id: orgId,
        actor: { type: 'integration', id: serviceAccountId },
        payload: {
          org_id: orgId,
          identity,
          payload_hash: payloadHash,
          suppression_window_seconds: SUPPRESSION_WINDOW_MS / 1000,
        },
        timestamp: recordedAt,
      });
    });

    this.pruneExpired();
    this.recentWrites.set(this.markerKey(orgId, node.id, serviceAccountId, payloadHash), {
      expiresAt: Date.parse(expiresAt),
    });
    if (event) await this.outbox.dispatch(event);

    return {
      node_id: node.id,
      identity,
      service_account_id: serviceAccountId,
      payload_hash: payloadHash,
      recorded_at: recordedAt,
      suppression_expires_at: expiresAt,
    };
  }

  public async evaluateWebhook(orgId: string, dto: EvaluateSyncWebhookDto): Promise<SyncGuardDecision> {
    await this.dbService.initialize();
    const identity = this.normalizeIdentity(dto?.identity);
    const actorId = this.requiredText(dto?.actor_id, 'actor_id', 256);
    const payload = this.normalizePayload(dto?.payload);
    const payloadHash = this.hashPayload(payload);
    const node = await this.requireNode(orgId, identity);
    const decidedAt = new Date().toISOString();

    this.pruneExpired();
    const key = this.markerKey(orgId, node.id, actorId, payloadHash);
    const marker = this.recentWrites.get(key);
    let reason: SyncGuardDecision['reason'];
    let matchedServiceAccount = false;

    if (marker && marker.expiresAt >= Date.now()) {
      reason = 'self_originated_hash';
      matchedServiceAccount = true;
    } else {
      const snapshot = await this.dbService.db.query<any>(
        `SELECT payload_hash, canonical_payload
         FROM integration_sync_snapshots
         WHERE org_id = $1 AND node_id = $2`,
        [orgId, node.id],
      );
      const row = snapshot.rows[0];
      const storedPayload = row
        ? (typeof row.canonical_payload === 'string'
          ? JSON.parse(row.canonical_payload)
          : row.canonical_payload)
        : null;
      reason = row
        && row.payload_hash === payloadHash
        && stableStringify(storedPayload) === stableStringify(payload)
        ? 'content_noop'
        : 'external_change';
    }

    const suppressed = reason !== 'external_change';
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | null = null;
    await this.dbService.db.transaction(async (tx) => {
      if (!suppressed) {
        await tx.query(
          `INSERT INTO integration_sync_snapshots
           (org_id, node_id, payload_hash, canonical_payload, observed_actor_id,
            observation_source, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'inbound_change', $6)
           ON CONFLICT (org_id, node_id)
           DO UPDATE SET payload_hash = EXCLUDED.payload_hash,
                         canonical_payload = EXCLUDED.canonical_payload,
                         observed_actor_id = EXCLUDED.observed_actor_id,
                         observation_source = EXCLUDED.observation_source,
                         updated_at = EXCLUDED.updated_at`,
          [orgId, node.id, payloadHash, JSON.stringify(payload), actorId, decidedAt],
        );
      }
      event = await this.outbox.enqueue(tx, {
        event_type: suppressed ? 'IntegrationEchoSuppressed' : 'IntegrationChangeAccepted',
        work_item_id: node.id,
        org_id: orgId,
        actor: { type: 'integration', id: actorId },
        payload: {
          org_id: orgId,
          identity,
          payload_hash: payloadHash,
          decision: suppressed ? 'ignore' : 'process',
          reason,
          matched_service_account: matchedServiceAccount,
        },
        timestamp: decidedAt,
      });
    });

    if (matchedServiceAccount) this.recentWrites.delete(key);
    if (event) await this.outbox.dispatch(event);
    return {
      node_id: node.id,
      identity,
      payload_hash: payloadHash,
      suppressed,
      action: suppressed ? 'ignore' : 'process',
      reason,
      matched_service_account: matchedServiceAccount,
      decided_at: decidedAt,
    };
  }

  /** Exposes only the cache boundary needed to simulate a process restart in acceptance tests. */
  public clearVolatileMarkers(): void {
    this.recentWrites.clear();
  }

  private async requireNode(orgId: string, identity: SyncIdentity): Promise<SyncNode> {
    const result = await this.dbService.db.query<any>(
      `SELECT id, system, entity_type, immutable_id
       FROM integration_correlation_nodes
       WHERE org_id = $1 AND system = $2 AND entity_type = $3 AND immutable_id = $4`,
      [orgId, identity.system, identity.entity_type, identity.immutable_id],
    );
    if (result.rows.length === 0) {
      throw new SyncIdentityNotFoundError('Correlation identity not found in this tenant');
    }
    return result.rows[0] as SyncNode;
  }

  private normalizeIdentity(input: SyncIdentity | undefined): SyncIdentity {
    if (!input || typeof input !== 'object') throw new InvalidSyncGuardError('identity is required');
    const system = this.requiredText(input.system, 'identity.system', 64).toLowerCase();
    const entityType = this.requiredText(input.entity_type, 'identity.entity_type', 64).toLowerCase();
    if (!TOKEN_PATTERN.test(system) || !TOKEN_PATTERN.test(entityType)) {
      throw new InvalidSyncGuardError('identity system and entity_type contain unsupported characters');
    }
    return {
      system,
      entity_type: entityType,
      immutable_id: this.requiredText(input.immutable_id, 'identity.immutable_id', 512),
    };
  }

  private normalizePayload(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new InvalidSyncGuardError('payload must be a JSON object');
    }
    try {
      return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    } catch {
      throw new InvalidSyncGuardError('payload must be JSON serializable');
    }
  }

  private hashPayload(payload: Record<string, unknown>): string {
    return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
  }

  private markerKey(orgId: string, nodeId: string, actorId: string, payloadHash: string): string {
    return `${orgId}\n${nodeId}\n${actorId}\n${payloadHash}`;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, marker] of this.recentWrites) {
      if (marker.expiresAt < now) this.recentWrites.delete(key);
    }
  }

  private requiredText(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new InvalidSyncGuardError(`${field} is required`);
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      throw new InvalidSyncGuardError(`${field} must be ${maxLength} characters or fewer`);
    }
    return normalized;
  }
}

