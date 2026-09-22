export type RuntimeMode = 'local' | 'staging' | 'production';

/**
 * How the workspace presents work (US20.2).
 * - `connector-led`: Jira/ServiceNow are the systems of record; local work-item creation is refused.
 * - `pilot`: local demonstration with seeded data; creation lives under Pilot actions. Local runtime only.
 * - `standalone`: local work management is intentionally enabled alongside connectors.
 */
export type InteractionMode = 'connector-led' | 'pilot' | 'standalone';

export interface RuntimeConfig {
  mode: RuntimeMode;
  interactionMode: InteractionMode;
  /** Wires connectors to in-process sandbox provider APIs. Local runtime only. */
  connectorSandbox: boolean;
  port: number;
  seedDemoData: boolean;
  trustProxy: number | false;
  corsOrigins: string[];
  buildSha: string | null;
  serviceName: string;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected true or false, received '${value}'`);
}

function parseMode(value: string | undefined): RuntimeMode {
  const mode = (value || 'local').trim().toLowerCase();
  if (mode === 'local' || mode === 'staging' || mode === 'production') return mode;
  throw new Error('CADENA_RUNTIME_MODE must be local, staging, or production');
}

function parseInteractionMode(value: string | undefined, runtime: RuntimeMode): InteractionMode {
  const mode = (value || (runtime === 'local' ? 'pilot' : 'connector-led')).trim().toLowerCase();
  if (mode !== 'connector-led' && mode !== 'pilot' && mode !== 'standalone') {
    throw new Error('CADENA_INTERACTION_MODE must be connector-led, pilot, or standalone');
  }
  if (mode === 'pilot' && runtime !== 'local') {
    throw new Error(`${runtime} mode forbids CADENA_INTERACTION_MODE=pilot; use connector-led or standalone`);
  }
  return mode;
}

function parsePort(value: string | undefined): number {
  const port = Number(value || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}

function validateDatabaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    if (url.searchParams.has(key)) {
      throw new Error(`DATABASE_URL must not include ${key}; use CADENA_DATABASE_SSL and CADENA_DATABASE_CA_BASE64`);
    }
  }
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = parseMode(env.CADENA_RUNTIME_MODE);
  const databaseUrl = env.DATABASE_URL?.trim();
  const dataDir = env.CADENA_DATA_DIR?.trim();
  const headerAuth = booleanValue(env.CADENA_ALLOW_HEADER_AUTH, false);
  const seedDemoData = booleanValue(env.CADENA_SEED_DEMO_DATA, mode === 'local');
  const sslMode = (env.CADENA_DATABASE_SSL || (databaseUrl ? 'verify-full' : 'disable')).trim().toLowerCase();

  const interactionMode = parseInteractionMode(env.CADENA_INTERACTION_MODE, mode);
  const sandboxText = (env.CADENA_CONNECTOR_SANDBOX || '').trim().toLowerCase();
  if (sandboxText && sandboxText !== 'enabled' && sandboxText !== 'disabled') {
    throw new Error('CADENA_CONNECTOR_SANDBOX must be enabled or disabled');
  }
  const connectorSandbox = sandboxText === 'enabled';
  if (connectorSandbox && mode !== 'local') throw new Error(`${mode} mode forbids CADENA_CONNECTOR_SANDBOX=enabled`);

  if (databaseUrl) validateDatabaseUrl(databaseUrl);
  if (databaseUrl && dataDir) throw new Error('Configure DATABASE_URL or CADENA_DATA_DIR, not both');

  if (mode !== 'local') {
    if (!databaseUrl) throw new Error(`${mode} mode requires DATABASE_URL`);
    if (headerAuth) throw new Error(`${mode} mode forbids CADENA_ALLOW_HEADER_AUTH=true`);
    if (sslMode !== 'verify-full') throw new Error(`${mode} mode requires CADENA_DATABASE_SSL=verify-full`);
    const bootstrapToken = env.CADENA_BOOTSTRAP_TOKEN?.trim() || '';
    if (bootstrapToken.length < 32) {
      throw new Error(`${mode} mode requires a CADENA_BOOTSTRAP_TOKEN of at least 32 characters`);
    }
  }

  const trustProxyText = env.CADENA_TRUST_PROXY?.trim();
  const trustProxy = trustProxyText ? Number(trustProxyText) : false;
  if (trustProxy !== false && (!Number.isInteger(trustProxy) || trustProxy < 1 || trustProxy > 10)) {
    throw new Error('CADENA_TRUST_PROXY must be an integer from 1 to 10');
  }

  return {
    mode,
    interactionMode,
    connectorSandbox,
    port: parsePort(env.PORT),
    seedDemoData,
    trustProxy,
    corsOrigins: (env.CADENA_CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
    buildSha: env.CADENA_BUILD_SHA?.trim() || null,
    serviceName: env.CADENA_SERVICE_NAME?.trim() || 'cadena-api',
  };
}
