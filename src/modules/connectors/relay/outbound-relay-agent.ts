import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConnectorFetch, ConnectorHttpRequest } from '../connector-http';
import { ConnectorRelayDelivery } from '../connector.types';

interface StoredExecution {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface OutboundRelayAgentConfig {
  controlPlaneUrl: string;
  relayId: string;
  token: string;
  targetOrigin: string;
  ledgerDirectory: string;
  /** Provider credentials stay on the relay and override headers supplied by the control plane. */
  providerHeaders?: Record<string, string>;
}

const RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
];

/** One immutable file per delivery makes a successful provider result durable before acknowledgement. */
export class RelayExecutionLedger {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  public get(deliveryId: string): StoredExecution | undefined {
    const path = this.path(deliveryId);
    if (!existsSync(path)) return undefined;
    try { return JSON.parse(readFileSync(path, 'utf8')) as StoredExecution; } catch { return undefined; }
  }

  public put(deliveryId: string, result: StoredExecution): void {
    const finalPath = this.path(deliveryId);
    if (existsSync(finalPath)) return;
    const temporary = join(this.directory, `.${createHash('sha256').update(deliveryId).digest('hex')}.${Date.now()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(result), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, finalPath);
  }

  private path(deliveryId: string): string {
    return join(this.directory, `${createHash('sha256').update(deliveryId).digest('hex')}.json`);
  }
}

/**
 * Headless relay loop. It opens no listener: every control-plane interaction is an outbound POST,
 * and configuration refuses anything other than HTTPS on the effective port 443.
 */
export class OutboundRelayAgent {
  private readonly controlPlane: URL;
  private readonly allowedTargetOrigin: string;
  private readonly ledger: RelayExecutionLedger;

  constructor(
    private readonly config: OutboundRelayAgentConfig,
    private readonly controlFetch: ConnectorFetch,
    private readonly targetFetch: ConnectorFetch,
  ) {
    this.controlPlane = new URL(config.controlPlaneUrl);
    if (this.controlPlane.protocol !== 'https:' || (this.controlPlane.port && this.controlPlane.port !== '443')) {
      throw new Error('Relay controlPlaneUrl must use outbound HTTPS on port 443');
    }
    if (!config.relayId.trim() || !config.token.trim()) throw new Error('Relay id and token are required');
    this.allowedTargetOrigin = new URL(config.targetOrigin).origin;
    this.ledger = new RelayExecutionLedger(config.ledgerDirectory);
  }

  /** Polls once and processes at most one delivery, preserving the control-plane FIFO order. */
  public async runOnce(waitSeconds = 25): Promise<boolean> {
    const delivery = await this.poll(waitSeconds);
    if (!delivery) return false;
    if (new URL(delivery.request.url).origin !== this.allowedTargetOrigin) {
      await this.acknowledge(delivery, undefined, 'Delivery target is outside the relay targetOrigin');
      return true;
    }

    let result = this.ledger.get(delivery.id);
    if (!result) {
      try {
        const response = await this.targetFetch(delivery.request.url, {
          method: delivery.request.method,
          headers: { ...delivery.request.headers, ...(this.config.providerHeaders || {}) },
          ...(delivery.request.body === undefined ? {} : { body: delivery.request.body }),
        });
        const headers = Object.fromEntries(RESPONSE_HEADERS
          .map((name) => [name, response.headers.get(name)] as const)
          .filter((entry): entry is readonly [string, string] => entry[1] !== null));
        result = { status: response.status, headers, body: await response.text() };
        // This must precede acknowledgement: if the ACK connection drops, the replay reads this
        // result and never repeats the provider request.
        this.ledger.put(delivery.id, result);
      } catch (error) {
        await this.acknowledge(delivery, undefined, (error as Error)?.message || 'provider network error');
        return true;
      }
    }
    await this.acknowledge(delivery, result);
    return true;
  }

  public async run(signal?: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal?.aborted) {
      try {
        await this.runOnce(25);
        failures = 0;
      } catch {
        failures += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (failures - 1), 30_000)));
      }
    }
  }

  private async poll(waitSeconds: number): Promise<ConnectorRelayDelivery | null> {
    const response = await this.controlFetch(this.controlUrl('poll'), {
      method: 'POST',
      headers: this.controlHeaders(),
      body: JSON.stringify({ waitSeconds }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Relay poll failed with HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    const body = text ? JSON.parse(text) : {};
    return body.delivery || null;
  }

  private async acknowledge(delivery: ConnectorRelayDelivery, result?: StoredExecution, error?: string): Promise<void> {
    const response = await this.controlFetch(this.controlUrl(`deliveries/${delivery.id}/ack`), {
      method: 'POST',
      headers: this.controlHeaders(),
      body: JSON.stringify({ leaseId: delivery.leaseId, ...(result ? { response: result } : { error }) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Relay acknowledgement failed with HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  private controlUrl(suffix: string): string {
    return new URL(`/integrations/relay/${this.config.relayId}/${suffix}`, this.controlPlane).toString();
  }

  private controlHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  }
}
