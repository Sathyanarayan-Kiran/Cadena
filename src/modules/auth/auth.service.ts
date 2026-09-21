import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';

export interface Principal {
  org_id: string;
  actor_id: string;
  roles: string[];
  /** How the caller proved who they are, for diagnostics and the audit trail. */
  source: 'credential' | 'bootstrap' | 'dev_header';
  credential_id?: string;
}

export interface CredentialRecord {
  id: string;
  org_id: string;
  actor_id: string;
  name: string;
  roles: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface IssueCredentialDto {
  name?: string;
  actor_id?: string;
  roles?: string[];
}

export const PLATFORM_ADMIN_ROLE = 'platform_admin';
const TOKEN_PREFIX = 'cdn_';

export class InvalidCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialError';
  }
}

/**
 * Verified identity for the platform.
 *
 * Every tenant boundary in this codebase was previously enforced against `x-org-id`, a
 * header the caller supplies. The isolation logic was correct but rested on a false
 * premise: anyone could claim any tenant. This turns the tenant into something the caller
 * has to prove.
 *
 * Tokens are shown once at issue and stored only as a SHA-256 hash. Lookup is *by* that
 * hash, so verification is an indexed equality test on a digest rather than a comparison
 * against a stored secret — there is no plaintext token in the database to leak.
 */
@Injectable()
export class AuthService {
  private dbService = DatabaseService.getInstance();

  /** Header-based identity is a development convenience and must be opted into. */
  public static devHeadersAllowed(): boolean {
    return process.env.CADENA_ALLOW_HEADER_AUTH === 'true';
  }

  public static bootstrapToken(): string | null {
    const token = process.env.CADENA_BOOTSTRAP_TOKEN?.trim();
    return token ? token : null;
  }

  private hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  public async issueCredential(
    orgId: string,
    dto: IssueCredentialDto,
  ): Promise<CredentialRecord & { token: string }> {
    await this.dbService.initialize();
    const name = dto.name?.trim();
    if (!name) throw new InvalidCredentialError('name is required');

    const roles = (dto.roles ?? []).map((role) => String(role).trim()).filter(Boolean);
    const actorId = dto.actor_id?.trim() || `credential:${name}`;
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    const id = randomUUID();

    const result = await this.dbService.db.query<any>(
      `INSERT INTO api_credentials (id, org_id, actor_id, name, token_hash, roles, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING *`,
      [id, orgId, actorId, name, this.hash(token), roles],
    );

    // The only moment the plaintext exists outside the caller's hands.
    return { ...this.map(result.rows[0]), token };
  }

  public async listCredentials(orgId: string): Promise<CredentialRecord[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM api_credentials WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId],
    );
    return result.rows.map((row) => this.map(row));
  }

  public async revokeCredential(orgId: string, id: string): Promise<CredentialRecord> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `UPDATE api_credentials SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
       RETURNING *`,
      [id, orgId],
    );
    if (result.rows.length === 0) {
      // Scoped by tenant, and an already-revoked credential is not an error worth
      // distinguishing from a missing one.
      throw new InvalidCredentialError(`Credential '${id}' not found or already revoked`);
    }
    return this.map(result.rows[0]);
  }

  /** Resolves a bearer token to its principal, or null when it is unknown or revoked. */
  public async verifyToken(token: string): Promise<Principal | null> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM api_credentials WHERE token_hash = $1 AND revoked_at IS NULL`,
      [this.hash(token)],
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    await this.dbService.db.query(
      `UPDATE api_credentials SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [row.id],
    );
    return {
      org_id: row.org_id,
      actor_id: row.actor_id,
      roles: row.roles || [],
      source: 'credential',
      credential_id: row.id,
    };
  }

  private map(row: any): CredentialRecord {
    return {
      id: row.id,
      org_id: row.org_id,
      actor_id: row.actor_id,
      name: row.name,
      roles: row.roles || [],
      created_at: this.iso(row.created_at),
      last_used_at: row.last_used_at ? this.iso(row.last_used_at) : null,
      revoked_at: row.revoked_at ? this.iso(row.revoked_at) : null,
    };
  }

  private iso(value: any): string {
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}
