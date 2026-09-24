import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { DatabaseQueryable } from '../../database/database-adapter';
import { EventOutboxService } from '../events/event-outbox.service';
import { ConnectorContext } from './connector.interface';
import { ConnectorConfigurationError, ConnectorLoadShedError, ConnectorRemoteError } from './connector-http';
import {
  ConnectorRateGovernanceMetrics,
  ConnectorRateGovernancePolicy,
  ConnectorRecord,
} from './connector.types';

export const DEFAULT_RATE_GOVERNANCE: ConnectorRateGovernancePolicy = {
  requestsPerMinute: 600,
  headroomPercentage: 90,
  maxConcurrent: 4,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  jitterRatio: 0.2,
  shedAfterPressureResponses: 2,
};

/** A recovery probe that never reports back (a crashed worker) stops blocking other probes after this. */
const PROBE_LEASE_MS = 30_000;

type SheddingState = ConnectorRateGovernanceMetrics['loadShedding']['state'];

interface GateState {
  inFlight: number;
  queued: number;
  limit: number;
  waiters: Array<() => void>;
}

interface TargetDescriptor {
  targetKey: string;
  targetOrigin: string;
  policy: ConnectorRateGovernancePolicy;
}

interface RateGovernorDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function validateRateGovernance(input: unknown): ConnectorRateGovernancePolicy {
  if (input === undefined || input === null) return { ...DEFAULT_RATE_GOVERNANCE };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConnectorConfigurationError('rateGovernance must be an object');
  }
  const value = input as Record<string, unknown>;
  const allowed = ['requestsPerMinute', 'headroomPercentage', 'maxConcurrent', 'baseBackoffMs', 'maxBackoffMs', 'jitterRatio', 'shedAfterPressureResponses'];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ConnectorConfigurationError(`rateGovernance does not support ${unknown.join(', ')}`);

  const integer = (key: string, fallback: number, min: number, max: number): number => {
    if (value[key] === undefined) return fallback;
    if (!Number.isInteger(value[key]) || Number(value[key]) < min || Number(value[key]) > max) {
      throw new ConnectorConfigurationError(`rateGovernance.${key} must be a whole number between ${min} and ${max}`);
    }
    return Number(value[key]);
  };
  const jitter = value.jitterRatio === undefined ? DEFAULT_RATE_GOVERNANCE.jitterRatio : Number(value.jitterRatio);
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new ConnectorConfigurationError('rateGovernance.jitterRatio must be between 0 and 1');
  }
  const policy: ConnectorRateGovernancePolicy = {
    requestsPerMinute: integer('requestsPerMinute', DEFAULT_RATE_GOVERNANCE.requestsPerMinute, 1, 60_000),
    headroomPercentage: integer('headroomPercentage', DEFAULT_RATE_GOVERNANCE.headroomPercentage, 1, 100),
    maxConcurrent: integer('maxConcurrent', DEFAULT_RATE_GOVERNANCE.maxConcurrent, 1, 100),
    baseBackoffMs: integer('baseBackoffMs', DEFAULT_RATE_GOVERNANCE.baseBackoffMs, 1, 60_000),
    maxBackoffMs: integer('maxBackoffMs', DEFAULT_RATE_GOVERNANCE.maxBackoffMs, 1, 3_600_000),
    jitterRatio: jitter,
    shedAfterPressureResponses: integer('shedAfterPressureResponses', DEFAULT_RATE_GOVERNANCE.shedAfterPressureResponses, 1, 20),
  };
  if (policy.maxBackoffMs < policy.baseBackoffMs) {
    throw new ConnectorConfigurationError('rateGovernance.maxBackoffMs must be at least baseBackoffMs');
  }
  return policy;
}

/**
 * Process-wide admission control backed by a durable quota window and retry gate.
 * The database row coordinates every worker; the in-process gate bounds simultaneous sockets.
 *
 * Load shedding (US16.2): when the target keeps answering with database semaphore pressure,
 * retrying each queued item against it only deepens the exhaustion. Once `shedAfterPressureResponses`
 * consecutive calls have met pressure (one blip is retried per item as before), a
 * target-wide shedding window opens (the target's Retry-After, or the jittered exponential delay), and
 * every call in it is refused before a request is sent. When the window ends one call is admitted
 * as a probe: success closes the window, renewed pressure reopens it for longer. Opening and
 * closing are recorded as domain events so the condition is visible, not just survived.
 */
export class ConnectorRateGovernor {
  private readonly dbService = DatabaseService.getInstance();
  private readonly outbox = new EventOutboxService();
  private readonly gates = new Map<string, GateState>();
  private readonly policies = new Map<string, ConnectorRateGovernancePolicy>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(dependencies: RateGovernorDependencies = {}) {
    this.now = dependencies.now || Date.now;
    this.sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies.random || Math.random;
  }

  public describe(connector: ConnectorRecord): TargetDescriptor {
    let origin: string;
    try {
      const url = new URL(String(connector.config.baseUrl || ''));
      origin = `${url.protocol}//${url.host}`.toLowerCase();
    } catch {
      throw new ConnectorConfigurationError('Rate governance requires a valid connector baseUrl');
    }
    return {
      targetKey: createHash('sha256').update(origin).digest('hex'),
      targetOrigin: origin,
      policy: validateRateGovernance(connector.config.rateGovernance),
    };
  }

  /** Registers a connector policy before traffic starts; connectors sharing a target use the safer limits. */
  public async registerPolicy(connector: ConnectorRecord): Promise<void> {
    await this.dbService.initialize();
    const described = this.describe(connector);
    const rows = await this.dbService.db.query<any>(
      `SELECT id, org_id, provider, name, config FROM integration_connectors WHERE org_id = $1`,
      [connector.orgId],
    );
    const policies: ConnectorRateGovernancePolicy[] = [];
    for (const row of rows.rows) {
      try {
        const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
        const candidate = this.describe({ ...connector, id: row.id, provider: row.provider, name: row.name, config });
        if (candidate.targetKey === described.targetKey) policies.push(candidate.policy);
      } catch {
        // Invalid connector configuration is handled by its own lifecycle; it cannot widen a target budget.
      }
    }
    const merged = policies.reduce((current, candidate) => this.saferPolicy(current, candidate), described.policy);
    const target = { ...described, policy: merged };
    this.policies.set(`${connector.orgId}:${target.targetKey}`, merged);
    const nowIso = new Date(this.now()).toISOString();
    await this.dbService.db.query(
      `INSERT INTO integration_rate_governance
       (org_id, target_key, target_origin, requests_per_minute, headroom_percentage, max_concurrent, window_started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, target_key) DO UPDATE SET
         target_origin = EXCLUDED.target_origin,
         requests_per_minute = EXCLUDED.requests_per_minute,
         headroom_percentage = EXCLUDED.headroom_percentage,
         max_concurrent = EXCLUDED.max_concurrent,
         updated_at = EXCLUDED.updated_at`,
      [connector.orgId, target.targetKey, target.targetOrigin, target.policy.requestsPerMinute,
        target.policy.headroomPercentage, target.policy.maxConcurrent, nowIso],
    );
  }

  public async execute<T>(ctx: ConnectorContext, operation: () => Promise<T>): Promise<T> {
    const target = this.governedTarget(ctx.connector);
    const gateKey = `${ctx.connector.orgId}:${target.targetKey}`;
    const release = await this.acquireConcurrency(gateKey, target.policy.maxConcurrent);
    try {
      // Throws ConnectorLoadShedError, without calling the target, while the target is shedding.
      const probe = await this.acquireQuota(ctx.connector.orgId, target);
      try {
        const result = await operation();
        await this.recordSuccess(ctx.connector, target, probe);
        return result;
      } catch (error) {
        throw await this.recordFailure(ctx.connector, target, error, probe);
      }
    } finally {
      release();
    }
  }

  /** Whether calls to this connector's target are currently refused, for callers that can skip work up front. */
  public async sheddingStatus(connector: ConnectorRecord): Promise<{ state: SheddingState; until: string | null; reason: string | null }> {
    await this.dbService.initialize();
    const target = this.describe(connector);
    const result = await this.dbService.db.query<any>(
      `SELECT shedding_since, shed_until, shed_reason FROM integration_rate_governance WHERE org_id = $1 AND target_key = $2`,
      [connector.orgId, target.targetKey],
    );
    const row = result.rows[0];
    const state = this.sheddingState(row);
    return { state, until: state === 'normal' ? null : isoOrNull(row?.shed_until), reason: state === 'normal' ? null : row?.shed_reason || null };
  }

  public async listStoredMetrics(orgId: string): Promise<Array<Omit<ConnectorRateGovernanceMetrics, 'connectors' | 'backlog'>>> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM integration_rate_governance WHERE org_id = $1 ORDER BY target_origin`, [orgId],
    );
    return result.rows.map((row) => this.mapStoredMetric(orgId, row));
  }

  public emptyMetric(orgId: string, connector: ConnectorRecord): Omit<ConnectorRateGovernanceMetrics, 'connectors' | 'backlog'> {
    const target = this.describe(connector);
    const live = this.live(orgId, target.targetKey, target.policy.maxConcurrent);
    const effective = this.effectiveLimit(target.policy);
    return {
      targetKey: target.targetKey,
      targetOrigin: target.targetOrigin,
      quota: {
        requestsPerMinute: target.policy.requestsPerMinute,
        headroomPercentage: target.policy.headroomPercentage,
        effectiveLimit: effective,
        used: 0,
        remaining: effective,
        windowStartedAt: null,
        resetsAt: null,
      },
      concurrency: live,
      backoff: { blockedUntil: null, consecutiveFailures: 0, lastDelayMs: 0, throttleEvents: 0, semaphorePressureEvents: 0, retryEvents: 0 },
      loadShedding: { state: 'normal', since: null, until: null, reason: null, episodes: 0, shedRequests: 0 },
      requests: { total: 0, succeeded: 0, failed: 0, shapedWaitMs: 0 },
    };
  }

  private async acquireConcurrency(key: string, limit: number): Promise<() => void> {
    const gate = this.gates.get(key) || { inFlight: 0, queued: 0, limit, waiters: [] };
    gate.limit = Math.min(gate.limit, limit);
    this.gates.set(key, gate);
    if (gate.inFlight >= gate.limit) {
      gate.queued += 1;
      await new Promise<void>((resolve) => gate.waiters.push(resolve));
      gate.queued -= 1;
    }
    gate.inFlight += 1;
    return () => {
      gate.inFlight = Math.max(0, gate.inFlight - 1);
      while (gate.inFlight < gate.limit && gate.waiters.length) {
        const next = gate.waiters.shift();
        next?.();
        break;
      }
    };
  }

  /** Admits one call against the durable quota. Returns a probe token when this call tests recovery from shedding. */
  private async acquireQuota(orgId: string, target: TargetDescriptor): Promise<string | undefined> {
    await this.dbService.initialize();
    for (;;) {
      const nowMs = this.now();
      const admission = await this.dbService.db.transaction(async (tx): Promise<{ wait: number; shed?: { until: number; reason: string | null }; probe?: string }> => {
        const nowIso = new Date(nowMs).toISOString();
        await tx.query(
          `INSERT INTO integration_rate_governance
           (org_id, target_key, target_origin, requests_per_minute, headroom_percentage, max_concurrent, window_started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, target_key) DO NOTHING`,
          [orgId, target.targetKey, target.targetOrigin, target.policy.requestsPerMinute,
            target.policy.headroomPercentage, target.policy.maxConcurrent, nowIso],
        );
        const selected = await tx.query<any>(
          `SELECT * FROM integration_rate_governance WHERE org_id = $1 AND target_key = $2 FOR UPDATE`,
          [orgId, target.targetKey],
        );
        const row = selected.rows[0];
        const shedding = this.sheddingState(row, nowMs);
        const probeHeld = row.probe_owner && row.probe_expires_at && epoch(row.probe_expires_at) > nowMs;
        if (shedding === 'shedding' || (shedding === 'probing' && probeHeld)) {
          await tx.query(
            `UPDATE integration_rate_governance SET shed_requests = shed_requests + 1, updated_at = $3
             WHERE org_id = $1 AND target_key = $2`,
            [orgId, target.targetKey, nowIso],
          );
          // While another call probes, check back shortly rather than at the probe's lease expiry.
          const until = shedding === 'shedding'
            ? epoch(row.shed_until)
            : Math.min(epoch(row.probe_expires_at), nowMs + target.policy.baseBackoffMs);
          return { wait: 0, shed: { until, reason: row.shed_reason || null } };
        }
        const windowStart = epoch(row.window_started_at);
        const expired = nowMs >= windowStart + 60_000;
        const used = expired ? 0 : Number(row.used_requests || 0);
        const start = expired ? nowMs : windowStart;
        const effective = Math.max(1, Math.floor(
          Math.min(Number(row.requests_per_minute), target.policy.requestsPerMinute)
          * Math.min(Number(row.headroom_percentage), target.policy.headroomPercentage) / 100,
        ));
        const quotaWait = used >= effective ? Math.max(1, start + 60_000 - nowMs) : 0;
        // Retry delay is returned to the durable caller (work order, scheduled query or backfill),
        // which persists its own next-attempt time. It is not slept here: doing so would pin an HTTP
        // request and could make a different queue item expire and replay inside the same drain.
        const wait = quotaWait;
        await tx.query(
          `UPDATE integration_rate_governance
           SET target_origin = $3, requests_per_minute = LEAST(requests_per_minute, $4),
               headroom_percentage = LEAST(headroom_percentage, $5),
               max_concurrent = LEAST(max_concurrent, $6), window_started_at = $7, used_requests = $8,
               shaped_wait_ms = shaped_wait_ms + $9, updated_at = $10
           WHERE org_id = $1 AND target_key = $2`,
          [orgId, target.targetKey, target.targetOrigin, target.policy.requestsPerMinute,
            target.policy.headroomPercentage, target.policy.maxConcurrent, new Date(start).toISOString(),
            wait ? used : used + 1, wait, nowIso],
        );
        if (!wait) {
          await tx.query(
            `UPDATE integration_rate_governance SET total_requests = total_requests + 1
             WHERE org_id = $1 AND target_key = $2`, [orgId, target.targetKey],
          );
        }
        if (!wait && shedding === 'probing') {
          const probe = randomUUID();
          await tx.query(
            `UPDATE integration_rate_governance SET probe_owner = $3, probe_expires_at = $4
             WHERE org_id = $1 AND target_key = $2`,
            [orgId, target.targetKey, probe, new Date(nowMs + PROBE_LEASE_MS).toISOString()],
          );
          return { wait, probe };
        }
        return { wait };
      });
      if (admission.shed) {
        throw new ConnectorLoadShedError(target.targetOrigin, new Date(admission.shed.until), admission.shed.reason, nowMs);
      }
      if (!admission.wait) return admission.probe;
      await this.sleep(admission.wait);
    }
  }

  private async recordSuccess(connector: ConnectorRecord, target: TargetDescriptor, probe?: string): Promise<void> {
    const orgId = connector.orgId;
    const nowIso = new Date(this.now()).toISOString();
    await this.dbService.db.query(
      `UPDATE integration_rate_governance
       SET succeeded_requests = succeeded_requests + 1, consecutive_failures = 0, pressure_streak = 0,
           retry_not_before = CASE WHEN retry_not_before <= $3 THEN NULL ELSE retry_not_before END,
           last_status = 200, updated_at = $3
       WHERE org_id = $1 AND target_key = $2`,
      [orgId, target.targetKey, nowIso],
    );
    if (!probe) return;
    // Only the admitted probe can end shedding: a call sent before the window opened proves nothing.
    const event = await this.dbService.db.transaction(async (tx) => {
      const selected = await tx.query<any>(
        `SELECT shedding_since, shed_requests FROM integration_rate_governance
         WHERE org_id = $1 AND target_key = $2 AND probe_owner = $3 FOR UPDATE`,
        [orgId, target.targetKey, probe],
      );
      const row = selected.rows[0];
      if (!row?.shedding_since) return null;
      await tx.query(
        `UPDATE integration_rate_governance
         SET shedding_since = NULL, shed_until = NULL, shed_reason = NULL, probe_owner = NULL, probe_expires_at = NULL
         WHERE org_id = $1 AND target_key = $2`,
        [orgId, target.targetKey],
      );
      const since = isoOrNull(row.shedding_since)!;
      return this.enqueueSheddingEvent(tx, connector, target, 'ConnectorLoadSheddingEnded', {
        shedding_since: since,
        recovered_at: nowIso,
        duration_ms: Math.max(0, Date.parse(nowIso) - Date.parse(since)),
        shed_requests_total: Number(row.shed_requests || 0),
      });
    });
    if (event) await this.outbox.dispatch(event);
  }

  private enqueueSheddingEvent(
    tx: DatabaseQueryable,
    connector: ConnectorRecord,
    target: TargetDescriptor,
    eventType: 'ConnectorLoadSheddingStarted' | 'ConnectorLoadSheddingEnded',
    payload: Record<string, unknown>,
  ) {
    return this.outbox.enqueue(tx, {
      event_type: eventType,
      work_item_id: connector.id,
      org_id: connector.orgId,
      actor: { type: 'system', id: 'rate-governor' },
      payload: { connector_id: connector.id, provider: connector.provider, target_origin: target.targetOrigin, ...payload },
    });
  }

  private async recordFailure(connector: ConnectorRecord, target: TargetDescriptor, error: unknown, probe?: string): Promise<unknown> {
    const orgId = connector.orgId;
    const remote = error instanceof ConnectorRemoteError ? error : null;
    const retryable = Boolean(remote?.retryable);
    const throttle = remote?.status === 429;
    const pressure = remote?.status === 503 || /semaphore|too many requests|temporarily unavailable/i.test(remote?.message || '');
    let delayMs = 0;
    const nowMs = this.now();
    const event = await this.dbService.db.transaction(async (tx) => {
      const selected = await tx.query<any>(
        `SELECT consecutive_failures, shedding_since, pressure_streak FROM integration_rate_governance
         WHERE org_id = $1 AND target_key = $2 FOR UPDATE`,
        [orgId, target.targetKey],
      );
      const failures = Number(selected.rows[0]?.consecutive_failures || 0) + 1;
      if (retryable) {
        if (remote?.retryAfterSeconds) {
          delayMs = Math.ceil(remote.retryAfterSeconds * 1000);
        } else {
          const exponential = Math.min(target.policy.maxBackoffMs, target.policy.baseBackoffMs * 2 ** (failures - 1));
          const factor = 1 + (this.random() * 2 - 1) * target.policy.jitterRatio;
          delayMs = Math.max(1, Math.min(target.policy.maxBackoffMs, Math.round(exponential * factor)));
        }
      }
      const blockedUntil = delayMs ? new Date(nowMs + delayMs).toISOString() : null;
      await tx.query(
        `UPDATE integration_rate_governance
         SET failed_requests = failed_requests + 1, consecutive_failures = $3,
             retry_not_before = CASE WHEN $4::timestamptz IS NULL THEN retry_not_before
                                    WHEN retry_not_before IS NULL OR retry_not_before < $4 THEN $4
                                    ELSE retry_not_before END,
             last_delay_ms = $5,
             throttle_events = throttle_events + $6,
             semaphore_pressure_events = semaphore_pressure_events + $7,
             retry_events = retry_events + $8, last_status = $9, updated_at = $10
         WHERE org_id = $1 AND target_key = $2`,
        [orgId, target.targetKey, failures, blockedUntil, delayMs, throttle ? 1 : 0, pressure ? 1 : 0,
          retryable ? 1 : 0, remote?.status, new Date(nowMs).toISOString()],
      );
      const underPressure = Boolean(pressure && retryable && blockedUntil);
      const streak = underPressure ? Number(selected.rows[0]?.pressure_streak || 0) + 1 : 0;
      await tx.query(
        `UPDATE integration_rate_governance SET pressure_streak = $3 WHERE org_id = $1 AND target_key = $2`,
        [orgId, target.targetKey, streak],
      );
      const alreadyShedding = Boolean(selected.rows[0]?.shedding_since);
      if (!underPressure || (!alreadyShedding && streak < target.policy.shedAfterPressureResponses)) {
        // A probe that failed for another reason proves nothing either way; the next call probes again.
        if (probe) {
          await tx.query(
            `UPDATE integration_rate_governance SET probe_owner = NULL, probe_expires_at = NULL
             WHERE org_id = $1 AND target_key = $2 AND probe_owner = $3`,
            [orgId, target.targetKey, probe],
          );
        }
        return null;
      }
      const opening = !alreadyShedding;
      const reason = (remote?.message || 'semaphore pressure').slice(0, 300);
      await tx.query(
        `UPDATE integration_rate_governance
         SET shedding_since = COALESCE(shedding_since, $3),
             shed_until = CASE WHEN shed_until IS NULL OR shed_until < $4 THEN $4 ELSE shed_until END,
             shed_reason = $5, shed_episodes = shed_episodes + $6, probe_owner = NULL, probe_expires_at = NULL
         WHERE org_id = $1 AND target_key = $2`,
        [orgId, target.targetKey, new Date(nowMs).toISOString(), blockedUntil, reason, opening ? 1 : 0],
      );
      if (!opening) return null;
      return this.enqueueSheddingEvent(tx, connector, target, 'ConnectorLoadSheddingStarted', {
        shedding_until: blockedUntil,
        status: remote?.status ?? null,
        consecutive_pressure_responses: streak,
        reason,
      });
    });
    if (event) await this.outbox.dispatch(event);
    if (remote && retryable && !remote.retryAfterSeconds) {
      return new ConnectorRemoteError(remote.message, remote.status, true, delayMs / 1000);
    }
    return error;
  }

  private mapStoredMetric(orgId: string, row: any): Omit<ConnectorRateGovernanceMetrics, 'connectors' | 'backlog'> {
    const effective = Math.max(1, Math.floor(Number(row.requests_per_minute) * Number(row.headroom_percentage) / 100));
    const started = new Date(row.window_started_at).toISOString();
    const live = this.live(orgId, row.target_key, Number(row.max_concurrent));
    return {
      targetKey: row.target_key,
      targetOrigin: row.target_origin,
      quota: {
        requestsPerMinute: Number(row.requests_per_minute),
        headroomPercentage: Number(row.headroom_percentage),
        effectiveLimit: effective,
        used: Number(row.used_requests),
        remaining: Math.max(0, effective - Number(row.used_requests)),
        windowStartedAt: started,
        resetsAt: new Date(Date.parse(started) + 60_000).toISOString(),
      },
      concurrency: live,
      backoff: {
        blockedUntil: row.retry_not_before ? new Date(row.retry_not_before).toISOString() : null,
        consecutiveFailures: Number(row.consecutive_failures),
        lastDelayMs: Number(row.last_delay_ms),
        throttleEvents: Number(row.throttle_events),
        semaphorePressureEvents: Number(row.semaphore_pressure_events),
        retryEvents: Number(row.retry_events),
      },
      loadShedding: this.mapShedding(row),
      requests: {
        total: Number(row.total_requests),
        succeeded: Number(row.succeeded_requests),
        failed: Number(row.failed_requests),
        shapedWaitMs: Number(row.shaped_wait_ms),
      },
    };
  }

  private sheddingState(row: any, nowMs = this.now()): SheddingState {
    if (!row?.shedding_since) return 'normal';
    return row.shed_until && epoch(row.shed_until) > nowMs ? 'shedding' : 'probing';
  }

  private mapShedding(row: any): ConnectorRateGovernanceMetrics['loadShedding'] {
    const state = this.sheddingState(row);
    return {
      state,
      since: state === 'normal' ? null : isoOrNull(row.shedding_since),
      until: state === 'normal' ? null : isoOrNull(row.shed_until),
      reason: state === 'normal' ? null : row.shed_reason || null,
      episodes: Number(row.shed_episodes || 0),
      shedRequests: Number(row.shed_requests || 0),
    };
  }

  private live(orgId: string, targetKey: string, fallbackLimit: number) {
    const gate = this.gates.get(`${orgId}:${targetKey}`);
    return { limit: gate?.limit || fallbackLimit, inFlight: gate?.inFlight || 0, queued: gate?.queued || 0 };
  }

  private effectiveLimit(policy: ConnectorRateGovernancePolicy): number {
    return Math.max(1, Math.floor(policy.requestsPerMinute * policy.headroomPercentage / 100));
  }

  private governedTarget(connector: ConnectorRecord): TargetDescriptor {
    const target = this.describe(connector);
    const key = `${connector.orgId}:${target.targetKey}`;
    return { ...target, policy: this.policies.get(key) || target.policy };
  }

  private saferPolicy(current: ConnectorRateGovernancePolicy, candidate: ConnectorRateGovernancePolicy): ConnectorRateGovernancePolicy {
    return {
      requestsPerMinute: Math.min(current.requestsPerMinute, candidate.requestsPerMinute),
      headroomPercentage: Math.min(current.headroomPercentage, candidate.headroomPercentage),
      maxConcurrent: Math.min(current.maxConcurrent, candidate.maxConcurrent),
      baseBackoffMs: Math.max(current.baseBackoffMs, candidate.baseBackoffMs),
      maxBackoffMs: Math.max(current.maxBackoffMs, candidate.maxBackoffMs),
      jitterRatio: Math.min(current.jitterRatio, candidate.jitterRatio),
      shedAfterPressureResponses: Math.min(current.shedAfterPressureResponses, candidate.shedAfterPressureResponses),
    };
  }
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  return new Date(value instanceof Date ? value.getTime() : String(value)).toISOString();
}

function epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value));
}

let sharedGovernor: ConnectorRateGovernor | undefined;

export function getConnectorRateGovernor(): ConnectorRateGovernor {
  if (!sharedGovernor) sharedGovernor = new ConnectorRateGovernor();
  return sharedGovernor;
}
