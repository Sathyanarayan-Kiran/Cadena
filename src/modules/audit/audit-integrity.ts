import { createHash } from 'crypto';

export const AUDIT_HASH_ALGORITHM = 'SHA-256' as const;
export const AUDIT_PROOF_VERSION = 1;
export type AuditEventSource = 'domain_events' | 'audit_events';

export interface IntegrityEventInput {
  source: AuditEventSource;
  event_id: string;
  org_id: string;
  work_item_id: string | null;
  event_type: string;
  actor_type: string;
  actor_id: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export interface AuditIntegrityMetadata {
  algorithm: typeof AUDIT_HASH_ALGORITHM;
  proof_version: number;
  sequence: number;
  previous_hash: string | null;
  hash: string;
  verified: boolean;
}

/** JSON canonicalisation used before hashing; object key order can never change the proof. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

export function canonicalAuditEvent(input: IntegrityEventInput): Record<string, unknown> {
  // Hash the representation that JSONB actually persists (undefined keys omitted, Dates
  // serialized, non-finite numbers normalized), not a richer in-memory object that cannot
  // be reconstructed during later verification.
  const durablePayload = JSON.parse(JSON.stringify(input.payload || {}));
  return {
    proof_version: AUDIT_PROOF_VERSION,
    source: input.source,
    event_id: input.event_id,
    org_id: input.org_id,
    work_item_id: input.work_item_id,
    event_type: input.event_type,
    actor: { type: input.actor_type, id: input.actor_id },
    occurred_at: new Date(input.occurred_at).toISOString(),
    payload: durablePayload,
  };
}

export function calculateAuditHash(previousHash: string | null, canonicalEvent: unknown): string {
  return createHash('sha256')
    .update(previousHash || 'GENESIS', 'utf8')
    .update('\n', 'utf8')
    .update(stableStringify(canonicalEvent), 'utf8')
    .digest('hex');
}

const MAX_APPEND_ATTEMPTS = 8;

/**
 * Appends one idempotent link to the tenant chain using the caller's transaction/queryable.
 *
 * Multiple processes (horizontally scaled API replicas) can call this for the same tenant at
 * the same time. Rather than requiring a single shared connection to hold a lock — which the
 * one-time legacy backfill in `database.service.ts` cannot offer, since it runs ad hoc queries
 * outside a transaction — correctness comes from a database constraint: `audit_integrity_entries`
 * allows at most one entry per `(org_id, previous_hash)`, so two writers racing to extend the
 * same head cannot both commit. The loser's insert fails with a unique-violation on that
 * constraint (Postgres blocks the second inserter until the first's transaction resolves, then
 * either fails it or lets it through), and this function re-reads the now-current head and
 * retries. A genuine attacker forging a fork is still caught by verification; this only stops an
 * honest race from silently splitting the chain.
 */
export async function appendAuditIntegrityEntry(queryable: any, input: IntegrityEventInput): Promise<void> {
  const existing = await queryable.query(
    `SELECT sequence FROM audit_integrity_entries WHERE source = $1 AND event_id = $2`,
    [input.source, input.event_id],
  );
  if (existing.rows?.length) return;

  const canonical = canonicalAuditEvent(input);
  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
    const previous = await queryable.query(
      `SELECT event_hash FROM audit_integrity_entries
       WHERE org_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [input.org_id],
    );
    const previousHash = previous.rows?.[0]?.event_hash || null;
    const eventHash = calculateAuditHash(previousHash, canonical);
    try {
      await queryable.query(
        `INSERT INTO audit_integrity_entries
         (org_id, source, event_id, work_item_id, event_type, occurred_at,
          previous_hash, event_hash, canonical_event, proof_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source, event_id) DO NOTHING`,
        [input.org_id, input.source, input.event_id, input.work_item_id, input.event_type,
          input.occurred_at, previousHash, eventHash, JSON.stringify(canonical), AUDIT_PROOF_VERSION],
      );
      return;
    } catch (error: any) {
      const lostChainRace = error?.code === '23505'
        && String(error.constraint || '').startsWith('audit_integrity_chain_');
      if (!lostChainRace || attempt === MAX_APPEND_ATTEMPTS) throw error;
      // Another writer committed the same previous_hash first; retry against its new head.
    }
  }
}

export function verifyAuditEntry(row: any, current: IntegrityEventInput): AuditIntegrityMetadata {
  const canonical = canonicalAuditEvent(current);
  const expectedHash = calculateAuditHash(row.previous_hash || null, canonical);
  return {
    algorithm: AUDIT_HASH_ALGORITHM,
    proof_version: Number(row.proof_version),
    sequence: Number(row.sequence),
    previous_hash: row.previous_hash || null,
    hash: row.event_hash,
    verified: Number(row.proof_version) === AUDIT_PROOF_VERSION && expectedHash === row.event_hash,
  };
}

export async function verifyTenantAuditChain(queryable: any, orgId: string): Promise<{
  algorithm: typeof AUDIT_HASH_ALGORITHM;
  proof_version: number;
  chain_scope: 'tenant';
  chain_length: number;
  chain_head: string | null;
  chain_verified: boolean;
}> {
  const result = await queryable.query(
    `SELECT integrity.sequence, integrity.source, integrity.event_id,
            integrity.previous_hash, integrity.event_hash,
            integrity.canonical_event, integrity.proof_version,
            domain.event_id AS domain_id, domain.org_id AS domain_org_id,
            domain.work_item_id AS domain_work_item_id, domain.event_type AS domain_event_type,
            domain.actor_type AS domain_actor_type, domain.actor_id AS domain_actor_id,
            domain.payload AS domain_payload, domain.occurred_at AS domain_occurred_at,
            audit.id AS audit_id, item.org_id AS audit_org_id,
            audit.work_item_id::text AS audit_work_item_id, audit.event_type AS audit_event_type,
            audit.actor_type AS audit_actor_type, audit.actor_id AS audit_actor_id,
            audit.payload AS audit_payload, audit.timestamp AS audit_occurred_at
     FROM audit_integrity_entries integrity
     LEFT JOIN domain_events domain
       ON integrity.source = 'domain_events' AND domain.event_id = integrity.event_id
     LEFT JOIN audit_events audit
       ON integrity.source = 'audit_events' AND audit.id = integrity.event_id
     LEFT JOIN work_items item ON item.id = audit.work_item_id
     WHERE integrity.org_id = $1 ORDER BY integrity.sequence ASC`,
    [orgId],
  );
  let previousHash: string | null = null;
  let valid = true;
  for (const row of result.rows || []) {
    const canonical = typeof row.canonical_event === 'string'
      ? JSON.parse(row.canonical_event)
      : row.canonical_event;
    const linked = (row.previous_hash || null) === previousHash;
    const hashMatches = calculateAuditHash(row.previous_hash || null, canonical) === row.event_hash;
    let current: IntegrityEventInput | null = null;
    if (row.source === 'domain_events' && row.domain_id) {
      current = {
        source: 'domain_events',
        event_id: row.domain_id,
        org_id: row.domain_org_id,
        work_item_id: row.domain_work_item_id || null,
        event_type: row.domain_event_type,
        actor_type: row.domain_actor_type,
        actor_id: row.domain_actor_id,
        payload: typeof row.domain_payload === 'string' ? JSON.parse(row.domain_payload) : (row.domain_payload || {}),
        occurred_at: new Date(row.domain_occurred_at).toISOString(),
      };
    } else if (row.source === 'audit_events' && row.audit_id) {
      current = {
        source: 'audit_events',
        event_id: row.audit_id,
        org_id: row.audit_org_id,
        work_item_id: row.audit_work_item_id,
        event_type: row.audit_event_type,
        actor_type: row.audit_actor_type,
        actor_id: row.audit_actor_id,
        payload: typeof row.audit_payload === 'string' ? JSON.parse(row.audit_payload) : (row.audit_payload || {}),
        occurred_at: new Date(row.audit_occurred_at).toISOString(),
      };
    }
    const sourceMatches = current
      ? calculateAuditHash(row.previous_hash || null, canonicalAuditEvent(current)) === row.event_hash
      : false;
    if (!linked || !hashMatches || !sourceMatches || Number(row.proof_version) !== AUDIT_PROOF_VERSION) valid = false;
    previousHash = row.event_hash;
  }
  return {
    algorithm: AUDIT_HASH_ALGORITHM,
    proof_version: AUDIT_PROOF_VERSION,
    chain_scope: 'tenant',
    chain_length: result.rows?.length || 0,
    chain_head: previousHash,
    chain_verified: valid,
  };
}
