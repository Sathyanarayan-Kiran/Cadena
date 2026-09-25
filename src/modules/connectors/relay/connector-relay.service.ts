import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { DatabaseService } from '../../../database/database.service';
import { EventOutboxService } from '../../events/event-outbox.service';
import {
  ConnectorRelayAck,
  ConnectorRelayDelivery,
  ConnectorRelayRegistration,
  ConnectorRecord,
} from '../connector.types';
import {
  ConnectorConfigurationError,
  ConnectorFetch,
  ConnectorHttpRequest,
  ConnectorHttpResponse,
  ConnectorRemoteError,
} from '../connector-http';

const MAX_LONG_POLL_SECONDS = 30;
const RELAY_LEASE_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 65_000;
const POLL_INTERVAL_MS = 100;
const SENSITIVE_HEADER = /^(authorization|cookie|proxy-authorization|x-api-key)$/i;
const RESPONSE_HEADER_LIMIT = 50;

function iso(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

class StoredRelayResponse implements ConnectorHttpResponse {
  public readonly ok: boolean;
  public readonly headers: { get(name: string): string | null };

  constructor(
    public readonly status: number,
    headers: Record<string, string>,
    private readonly body: string,
  ) {
    this.ok = status >= 200 && status < 300;
    const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    this.headers = { get: (name) => normalized.get(name.toLowerCase()) ?? null };
  }

  public async text(): Promise<string> { return this.body; }
}

/**
 * Durable RPC bridge for provider HTTP calls made through an agent behind the customer's firewall.
 * The cloud side never opens a connection to the provider: it persists a credential-free request,
 * and the relay claims it by long-polling the control plane over outbound HTTPS.
 */
@Injectable()
export class ConnectorRelayService {
  private readonly database = DatabaseService.getInstance();
  private readonly outbox = new EventOutboxService();

  public async provision(
    orgId: string,
    connectorId: string,
    name: string | undefined,
    actorId: string,
  ): Promise<ConnectorRelayRegistration> {
    await this.database.initialize();
    const connectorResult = await this.database.db.query<any>(
      `SELECT * FROM integration_connectors WHERE id = $1 AND org_id = $2`,
      [connectorId, orgId],
    );
    const connector = connectorResult.rows[0];
    if (!connector) throw new NotFoundException(`Connector ${connectorId} not found`);
    const config = parseJson<Record<string, unknown>>(connector.config, {});
    const connectivity = config.connectivity as Record<string, unknown> | undefined;
    if (connectivity?.mode !== 'relay') {
      throw new ConflictException('Connector connectivity.mode must be relay before a relay can be provisioned');
    }

    const relayName = typeof name === 'string' && name.trim() ? name.trim() : `${connector.name} relay`;
    if (relayName.length > 160) throw new BadRequestException('Relay name must be 160 characters or fewer');
    const token = randomBytes(32).toString('base64url');
    const hash = tokenHash(token).toString('hex');
    const relayId = typeof connectivity.relayId === 'string' ? connectivity.relayId : randomUUID();
    let row: any;
    let event: Awaited<ReturnType<EventOutboxService['enqueue']>> | undefined;
    await this.database.db.transaction(async (tx) => {
      const saved = await tx.query<any>(
        `INSERT INTO integration_connector_relays
         (id, org_id, connector_id, name, token_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (connector_id) DO UPDATE
         SET name = EXCLUDED.name, token_hash = EXCLUDED.token_hash, revoked_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [relayId, orgId, connectorId, relayName, hash],
      );
      row = saved.rows[0];
      const nextConfig = { ...config, connectivity: { mode: 'relay', relayId: row.id } };
      await tx.query(
        `UPDATE integration_connectors SET config = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND org_id = $3`,
        [JSON.stringify(nextConfig), connectorId, orgId],
      );
      event = await this.outbox.enqueue(tx, {
        event_type: 'ConnectorRelayProvisioned',
        work_item_id: connectorId,
        org_id: orgId,
        actor: { type: 'user', id: actorId },
        payload: { connector_id: connectorId, relay_id: row.id, name: relayName, token_rotated: true },
      });
    });
    if (event) await this.outbox.dispatch(event);
    return { ...this.mapRegistration(row), token };
  }

  public async status(orgId: string, connectorId: string): Promise<ConnectorRelayRegistration> {
    await this.database.initialize();
    const result = await this.database.db.query<any>(
      `SELECT relay.* FROM integration_connector_relays relay
       JOIN integration_connectors connector ON connector.id = relay.connector_id
       WHERE relay.connector_id = $1 AND relay.org_id = $2 AND connector.org_id = $2
         AND relay.revoked_at IS NULL`,
      [connectorId, orgId],
    );
    if (!result.rows.length) throw new NotFoundException(`Connector ${connectorId} has no active relay`);
    return this.mapRegistration(result.rows[0]);
  }

  /** A per-operation transport. Reusing operationId makes a timed-out provider call idempotent. */
  public createFetch(connector: ConnectorRecord, operationId: string): ConnectorFetch {
    return (url, init) => this.request(connector, operationId, url, init);
  }

  public async request(
    connector: ConnectorRecord,
    operationId: string,
    url: string,
    init: ConnectorHttpRequest,
  ): Promise<ConnectorHttpResponse> {
    await this.database.initialize();
    const connectivity = connector.config.connectivity as Record<string, unknown> | undefined;
    const relayId = typeof connectivity?.relayId === 'string' ? connectivity.relayId : '';
    if (connectivity?.mode !== 'relay' || !relayId) {
      throw new ConnectorConfigurationError('Relay-mode connector has not been provisioned');
    }
    this.assertTarget(connector, url);
    const headers = Object.fromEntries(Object.entries(init.headers || {})
      .filter(([key]) => !SENSITIVE_HEADER.test(key))
      .map(([key, value]) => [key.toLowerCase(), String(value)]));
    const dedupeKey = createHash('sha256')
      .update([relayId, operationId, init.method, url, init.body || ''].join('\n'))
      .digest('hex');
    const requestId = randomUUID();
    await this.database.db.query(
      `INSERT INTO integration_relay_requests
       (id, org_id, relay_id, connector_id, idempotency_key, method, url, headers, body, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       ON CONFLICT (relay_id, idempotency_key) DO NOTHING`,
      [requestId, connector.orgId, relayId, connector.id, dedupeKey, init.method, url, JSON.stringify(headers), init.body ?? null],
    );
    const existing = await this.database.db.query<any>(
      `SELECT * FROM integration_relay_requests WHERE relay_id = $1 AND idempotency_key = $2`,
      [relayId, dedupeKey],
    );
    const row = existing.rows[0];
    if (!row) throw new ConnectorRemoteError('Relay request could not be persisted', null, true);
    if (row.status === 'failed') {
      await this.database.db.query(
        `UPDATE integration_relay_requests
         SET status = 'pending', error_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'failed'`,
        [row.id],
      );
    }
    return this.waitForResponse(row.id, init.signal);
  }

  public async poll(relayId: string, authorization: string | undefined, waitSeconds = 25): Promise<ConnectorRelayDelivery | null> {
    const relay = await this.authenticate(relayId, authorization);
    const seconds = Number.isFinite(Number(waitSeconds))
      ? Math.min(MAX_LONG_POLL_SECONDS, Math.max(0, Number(waitSeconds))) : 25;
    const deadline = Date.now() + seconds * 1000;
    await this.database.db.query(
      `UPDATE integration_connector_relays SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [relayId],
    );
    do {
      const leaseId = randomUUID();
      const expires = new Date(Date.now() + RELAY_LEASE_MS).toISOString();
      const claimed = await this.database.db.query<any>(
        `UPDATE integration_relay_requests SET status = 'leased', lease_id = $1,
             lease_expires_at = $2, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT head.id FROM integration_relay_requests head
           WHERE head.relay_id = $3 AND head.status IN ('pending', 'leased')
           ORDER BY head.queue_position ASC LIMIT 1
         )
           AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
           AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
         RETURNING *`,
        [leaseId, expires, relayId],
      );
      if (claimed.rows.length) return this.mapDelivery(claimed.rows[0]);
      if (Date.now() >= deadline) return null;
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return null;
  }

  public async acknowledge(
    relayId: string,
    authorization: string | undefined,
    deliveryId: string,
    ack: ConnectorRelayAck,
  ): Promise<{ acknowledged: true; replay: boolean }> {
    await this.authenticate(relayId, authorization);
    if (!ack || typeof ack.leaseId !== 'string' || !ack.leaseId) {
      throw new BadRequestException('leaseId is required');
    }
    if (Boolean(ack.response) === Boolean(ack.error)) {
      throw new BadRequestException('Supply exactly one of response or error');
    }
    const current = await this.database.db.query<any>(
      `SELECT * FROM integration_relay_requests WHERE id = $1 AND relay_id = $2`,
      [deliveryId, relayId],
    );
    const row = current.rows[0];
    if (!row) throw new NotFoundException(`Relay delivery ${deliveryId} not found`);
    if (row.status === 'completed') return { acknowledged: true, replay: true };
    if (row.status !== 'leased' || row.lease_id !== ack.leaseId) {
      throw new ConflictException('Relay delivery lease is no longer current');
    }

    if (ack.error) {
      const backoffMs = Math.min(1000 * 2 ** Math.max(0, Number(row.attempts || 1) - 1), 30_000);
      await this.database.db.query(
        `UPDATE integration_relay_requests
         SET status = 'pending', error_message = $1, lease_id = NULL, lease_expires_at = NULL,
             next_attempt_at = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND relay_id = $4 AND lease_id = $5`,
        [ack.error.slice(0, 500), new Date(Date.now() + backoffMs).toISOString(), deliveryId, relayId, ack.leaseId],
      );
      return { acknowledged: true, replay: false };
    }

    const response = ack.response!;
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new BadRequestException('response.status must be an HTTP status code');
    }
    const headers = this.validateResponseHeaders(response.headers);
    await this.database.db.query(
      `UPDATE integration_relay_requests
       SET status = 'completed', response_status = $1, response_headers = $2, response_body = $3,
           error_message = NULL, lease_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND relay_id = $5 AND lease_id = $6`,
      [response.status, JSON.stringify(headers), response.body ?? '', deliveryId, relayId, ack.leaseId],
    );
    return { acknowledged: true, replay: false };
  }

  private async waitForResponse(requestId: string, signal?: AbortSignal): Promise<ConnectorHttpResponse> {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      if (signal?.aborted) throw new ConnectorRemoteError('Relay request was aborted; queued work was retained', null, true);
      const result = await this.database.db.query<any>(
        `SELECT status, response_status, response_headers, response_body, error_message
         FROM integration_relay_requests WHERE id = $1`,
        [requestId],
      );
      const row = result.rows[0];
      if (!row) throw new ConnectorRemoteError('Relay request disappeared before completion', null, true);
      if (row.status === 'completed') {
        return new StoredRelayResponse(
          Number(row.response_status),
          parseJson(row.response_headers, {}),
          String(row.response_body ?? ''),
        );
      }
      if (row.status === 'failed') {
        throw new ConnectorRemoteError(`Relay could not reach the provider: ${row.error_message || 'unknown error'}`, null, true);
      }
      await delay(50);
    }
    throw new ConnectorRemoteError('Relay response timed out; queued work was retained for reconnect', null, true);
  }

  private async authenticate(relayId: string, authorization: string | undefined): Promise<any> {
    await this.database.initialize();
    const match = /^Bearer\s+(.+)$/i.exec(authorization || '');
    if (!match) throw new UnauthorizedException('Relay bearer token is required');
    const result = await this.database.db.query<any>(
      `SELECT * FROM integration_connector_relays WHERE id = $1 AND revoked_at IS NULL`,
      [relayId],
    );
    const relay = result.rows[0];
    if (!relay) throw new UnauthorizedException('Relay credential is invalid');
    const supplied = tokenHash(match[1]);
    const expected = Buffer.from(String(relay.token_hash), 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new UnauthorizedException('Relay credential is invalid');
    }
    return relay;
  }

  private assertTarget(connector: ConnectorRecord, url: string): void {
    try {
      const expected = new URL(String(connector.config.baseUrl || '')).origin;
      const actual = new URL(url).origin;
      if (expected !== actual) throw new Error('origin mismatch');
    } catch {
      throw new ConnectorConfigurationError('Relay request URL must stay within the connector baseUrl origin');
    }
  }

  private validateResponseHeaders(value: unknown): Record<string, string> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('response.headers must be an object');
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > RESPONSE_HEADER_LIMIT) throw new BadRequestException('response.headers has too many entries');
    return Object.fromEntries(entries.map(([key, item]) => [key.toLowerCase().slice(0, 100), String(item).slice(0, 1000)]));
  }

  private mapRegistration(row: any): ConnectorRelayRegistration {
    const lastSeenAt = iso(row.last_seen_at);
    return {
      id: row.id,
      connectorId: row.connector_id,
      name: row.name,
      status: lastSeenAt && Date.now() - Date.parse(lastSeenAt) < 90_000 ? 'connected' : 'waiting',
      lastSeenAt,
      createdAt: iso(row.created_at)!,
    };
  }

  private mapDelivery(row: any): ConnectorRelayDelivery {
    return {
      id: row.id,
      relayId: row.relay_id,
      connectorId: row.connector_id,
      sequence: Number(row.queue_position),
      idempotencyKey: row.idempotency_key,
      leaseId: row.lease_id,
      leaseExpiresAt: iso(row.lease_expires_at)!,
      request: {
        method: row.method,
        url: row.url,
        headers: parseJson(row.headers, {}),
        ...(row.body === null || row.body === undefined ? {} : { body: String(row.body) }),
      },
    };
  }
}
