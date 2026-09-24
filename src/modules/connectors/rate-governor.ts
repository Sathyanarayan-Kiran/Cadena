import { createHash } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { ConnectorContext } from './connector.interface';
import { ConnectorConfigurationError, ConnectorRemoteError } from './connector-http';
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
};

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
  const allowed = ['requestsPerMinute', 'headroomPercentage', 'maxConcurrent', 'baseBackoffMs', 'maxBackoffMs', 'jitterRatio'];
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
  };
  if (policy.maxBackoffMs < policy.baseBackoffMs) {
    throw new ConnectorConfigurationError('rateGovernance.maxBackoffMs must be at least baseBackoffMs');
  }
  return policy;
}

/**
 * Process-wide admission control backed by a durable quota window and retry gate.
 * The database row coordinates every worker; the in-process gate bounds simultaneous sockets.
 */
export class ConnectorRateGovernor {
  private readonly dbService = DatabaseService.getInstance();
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
      await this.acquireQuota(ctx.connector.orgId, target);
      try {
        const result = await operation();
        await this.recordSuccess(ctx.connector.orgId, target);
        return result;
      } catch (error) {
        throw await this.recordFailure(ctx.connector.orgId, target, error);
      }
    } finally {
      release();
    }
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

  private async acquireQuota(orgId: string, target: TargetDescriptor): Promise<void> {
    await this.dbService.initialize();
    for (;;) {
      const nowMs = this.now();
      const waitMs = await this.dbService.db.transaction(async (tx) => {
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
        return wait;
      });
      if (!waitMs) return;
      await this.sleep(waitMs);
    }
  }

  private async recordSuccess(orgId: string, target: TargetDescriptor): Promise<void> {
    await this.dbService.db.query(
      `UPDATE integration_rate_governance
       SET succeeded_requests = succeeded_requests + 1, consecutive_failures = 0,
           retry_not_before = CASE WHEN retry_not_before <= $3 THEN NULL ELSE retry_not_before END,
           last_status = 200, updated_at = $3
       WHERE org_id = $1 AND target_key = $2`,
      [orgId, target.targetKey, new Date(this.now()).toISOString()],
    );
  }

  private async recordFailure(orgId: string, target: TargetDescriptor, error: unknown): Promise<unknown> {
    const remote = error instanceof ConnectorRemoteError ? error : null;
    const retryable = Boolean(remote?.retryable);
    const throttle = remote?.status === 429;
    const pressure = remote?.status === 503 || /semaphore|too many requests|temporarily unavailable/i.test(remote?.message || '');
    let delayMs = 0;
    const nowMs = this.now();
    await this.dbService.db.transaction(async (tx) => {
      const selected = await tx.query<any>(
        `SELECT consecutive_failures FROM integration_rate_governance
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
    });
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
      requests: {
        total: Number(row.total_requests),
        succeeded: Number(row.succeeded_requests),
        failed: Number(row.failed_requests),
        shapedWaitMs: Number(row.shaped_wait_ms),
      },
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
    };
  }
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
