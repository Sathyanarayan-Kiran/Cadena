/**
 * Outbound HTTP boundary for native connectors.
 *
 * Adapters never call the global `fetch` directly. They receive a `ConnectorFetch`, which in
 * tests is a deterministic in-process fake of the provider API and in a deployment is
 * `createLiveConnectorFetch()`. The live transport refuses to open a network connection unless
 * `CADENA_CONNECTOR_LIVE_HTTP=enabled`, so no Jira or ServiceNow tenant is contacted until an
 * operator has explicitly authorised it.
 */

export interface ConnectorHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface ConnectorHttpResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type ConnectorFetch = (url: string, init: ConnectorHttpRequest) => Promise<ConnectorHttpResponse>;

/** Failure talking to the provider. `retryable` distinguishes throttling/outages from permanent refusals. */
export class ConnectorRemoteError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** A configured value cannot be resolved or is not a secret reference. Never includes the value. */
export class ConnectorCredentialError extends Error {}

/** The connector configuration cannot work against this provider. */
export class ConnectorConfigurationError extends Error {}

export class ConnectorLiveHttpDisabledError extends ConnectorRemoteError {
  constructor() {
    super(
      'Live connector HTTP is disabled. Set CADENA_CONNECTOR_LIVE_HTTP=enabled once access to the provider has been authorised.',
      null,
      false,
    );
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function liveConnectorHttpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CADENA_CONNECTOR_LIVE_HTTP || '').trim().toLowerCase() === 'enabled';
}

export function createLiveConnectorFetch(env: NodeJS.ProcessEnv = process.env): ConnectorFetch {
  return async (url, init) => {
    if (!liveConnectorHttpEnabled(env)) throw new ConnectorLiveHttpDisabledError();
    if (!url.startsWith('https://')) {
      throw new ConnectorConfigurationError('Live connector requests require an https:// base URL');
    }
    return fetch(url, init) as unknown as Promise<ConnectorHttpResponse>;
  };
}

/**
 * Performs one request and returns parsed JSON (or null for an empty body).
 * Maps provider status codes onto retryable and permanent failures.
 */
export async function requestJson<T = any>(
  fetchFn: ConnectorFetch,
  url: string,
  init: Omit<ConnectorHttpRequest, 'signal'>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: ConnectorHttpResponse;
  try {
    response = await fetchFn(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof ConnectorRemoteError || error instanceof ConnectorConfigurationError) throw error;
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : (error as Error)?.message || 'network error';
    throw new ConnectorRemoteError(`Provider request failed: ${reason}`, null, true);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
    const retryable = response.status === 429 || response.status >= 500;
    const detail = summarizeErrorBody(text);
    throw new ConnectorRemoteError(
      `Provider responded ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      retryable,
      retryAfter,
    );
  }
  if (!text.trim()) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConnectorRemoteError('Provider returned a non-JSON response', response.status, false);
  }
}

/** Supports both legal Retry-After forms: delta-seconds and an HTTP date. */
export function parseRetryAfterSeconds(value: string | null, now: () => number = Date.now): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0.001, seconds);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  return Math.max(0.001, (instant - now()) / 1000);
}

function summarizeErrorBody(text: string): string {
  if (!text) return '';
  try {
    const body = JSON.parse(text);
    const messages: string[] = [
      ...(Array.isArray(body?.errorMessages) ? body.errorMessages : []),
      ...(body?.errors && typeof body.errors === 'object' ? Object.values(body.errors).map(String) : []),
      ...(typeof body?.error?.message === 'string' ? [body.error.message] : []),
      // ServiceNow puts the actionable part (for example a data policy naming a mandatory field) in `detail`.
      ...(typeof body?.error?.detail === 'string' ? [body.error.detail] : []),
    ];
    return messages.join('; ').slice(0, 300);
  } catch {
    return text.slice(0, 120);
  }
}

export function basicAuthHeader(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
}

export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Formats an instant as wall-clock `YYYY-MM-DD HH:mm:ss` in the given IANA zone.
 * Jira JQL and ServiceNow encoded queries interpret literal datetimes in the integration
 * account's profile time zone, so the watermark must be rendered in that zone.
 */
export function formatInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '00';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

export function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    throw new ConnectorConfigurationError(`Unknown time zone '${timeZone}'`);
  }
}
