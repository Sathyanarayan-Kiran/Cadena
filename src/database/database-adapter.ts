import { PGlite } from '@electric-sql/pglite';
import { Pool, PoolClient, PoolConfig, QueryResultRow } from 'pg';

export interface DatabaseQueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface DatabaseQueryable {
  query<T = any>(sql: string, params?: any[]): Promise<DatabaseQueryResult<T>>;
}

export interface DatabaseAdapter extends DatabaseQueryable {
  exec(sql: string): Promise<unknown>;
  transaction<T>(callback: (tx: DatabaseQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Preserves the existing embedded pilot behaviour behind the shared query contract. */
export class PGliteDatabaseAdapter implements DatabaseAdapter {
  constructor(private readonly client: PGlite) {}

  public query<T = any>(sql: string, params?: any[]): Promise<DatabaseQueryResult<T>> {
    return this.client.query<T>(sql, params);
  }

  public exec(sql: string): Promise<unknown> {
    return this.client.exec(sql);
  }

  public transaction<T>(callback: (tx: DatabaseQueryable) => Promise<T>): Promise<T> {
    return this.client.transaction((tx) => callback(tx));
  }

  public close(): Promise<void> {
    return this.client.close();
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function postgresSslConfig(env: NodeJS.ProcessEnv): PoolConfig['ssl'] {
  const mode = (env.CADENA_DATABASE_SSL || 'verify-full').trim().toLowerCase();
  if (mode === 'disable') return false;
  if (mode !== 'verify-full' && mode !== 'require') {
    throw new Error('CADENA_DATABASE_SSL must be verify-full, require, or disable');
  }

  const encodedCa = env.CADENA_DATABASE_CA_BASE64?.trim();
  return {
    rejectUnauthorized: mode === 'verify-full',
    ...(encodedCa ? { ca: Buffer.from(encodedCa, 'base64').toString('utf8') } : {}),
  };
}

/** Pooled managed-PostgreSQL adapter used when DATABASE_URL is configured. */
export class ManagedPostgresDatabaseAdapter implements DatabaseAdapter {
  private readonly pool: Pool;

  constructor(databaseUrl: string, env: NodeJS.ProcessEnv = process.env) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: positiveInteger(env.CADENA_DATABASE_POOL_MAX, 10),
      connectionTimeoutMillis: positiveInteger(env.CADENA_DATABASE_CONNECT_TIMEOUT_MS, 10_000),
      idleTimeoutMillis: positiveInteger(env.CADENA_DATABASE_IDLE_TIMEOUT_MS, 30_000),
      ssl: postgresSslConfig(env),
      application_name: env.CADENA_SERVICE_NAME?.trim() || 'cadena-api',
    });
  }

  public async query<T = any>(sql: string, params?: any[]): Promise<DatabaseQueryResult<T>> {
    const result = await this.pool.query<T & QueryResultRow>(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  public async exec(sql: string): Promise<unknown> {
    return this.pool.query(sql);
  }

  public async transaction<T>(callback: (tx: DatabaseQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await callback(this.queryable(client));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public close(): Promise<void> {
    return this.pool.end();
  }

  private queryable(client: PoolClient): DatabaseQueryable {
    return {
      query: async <T = any>(sql: string, params?: any[]) => {
        const result = await client.query<T & QueryResultRow>(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      },
    };
  }
}
