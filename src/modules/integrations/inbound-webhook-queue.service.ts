import { Inject, Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { EventConsumerRegistry } from '../events/consumer-registry.service';
import { DomainEventEnvelope } from '../events/event-bus';
import { EventOutboxService } from '../events/event-outbox.service';
import { IntegrationService } from './integration.service';
import { GitWebhookDto } from './integration.types';
import { MonitoringIntegrationService } from './monitoring.service';
import { MonitoringWebhookDto } from './monitoring.types';

export type IntegrationKind = 'git' | 'monitoring';

export interface WebhookAcceptance {
  accepted: true;
  duplicate: boolean;
  delivery_id: string;
  provider: string;
  status: string;
  status_url: string;
}

interface EnqueueInput {
  kind: IntegrationKind;
  orgId: string;
  provider: string;
  deliveryId: string;
  eventType: string;
  body: GitWebhookDto | MonitoringWebhookDto;
}

const MAX_PROCESSING_ATTEMPTS = 3;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Durable HTTP 202 ingestion queue (US5.4).
 *
 * Acceptance writes the delivery row and its `InboundWebhookAccepted` outbox envelope in one
 * transaction, then schedules publication without awaiting it. The consumer is deliberately
 * serial: a slow provider job creates visible queue depth instead of consuming unbounded request
 * workers. EventConsumerRegistry supplies retry, idempotency and DLQ replay.
 */
@Injectable()
export class InboundWebhookQueueService implements OnModuleInit, OnApplicationBootstrap {
  public static readonly CONSUMER_NAME = 'inbound-webhooks';
  private dbService = DatabaseService.getInstance();
  private outbox = new EventOutboxService();
  private processingTail: Promise<void> = Promise.resolve();
  private readonly processingDelayMs = Math.min(
    Math.max(Number(process.env.CADENA_INBOUND_WORKER_DELAY_MS || 0) || 0, 0),
    60_000,
  );

  constructor(
    @Inject(IntegrationService)
    private readonly gitService: IntegrationService,
    @Inject(MonitoringIntegrationService)
    private readonly monitoringService: MonitoringIntegrationService,
  ) {}

  public onModuleInit(): void {
    new EventConsumerRegistry().register({
      name: InboundWebhookQueueService.CONSUMER_NAME,
      eventTypes: ['InboundWebhookAccepted'],
      maxAttempts: MAX_PROCESSING_ATTEMPTS,
      retryDelayMs: 5,
      handle: (event) => this.processSerially(event),
    });
  }

  public async onApplicationBootstrap(): Promise<void> {
    await this.dbService.initialize();
    // PGlite is single-process storage: a processing row present at boot belonged to the
    // stopped process and is safe to make claimable again.
    await this.dbService.db.query(
      `UPDATE integration_deliveries
       SET status = 'queued', claimed_at = NULL
       WHERE status = 'processing'`,
    );
    await this.outbox.recoverPending();
  }

  public async enqueueGit(
    orgId: string,
    body: GitWebhookDto,
    deliveryId: string,
  ): Promise<WebhookAcceptance> {
    this.gitService.validateWebhook(body, deliveryId);
    return this.enqueue({
      kind: 'git', orgId, deliveryId,
      provider: (body.provider || 'github').toLowerCase(),
      eventType: body.event_type,
      body,
    });
  }

  public async enqueueMonitoring(
    orgId: string,
    body: MonitoringWebhookDto,
    deliveryId: string,
  ): Promise<WebhookAcceptance> {
    this.monitoringService.validateWebhook(body, deliveryId);
    return this.enqueue({
      kind: 'monitoring', orgId, deliveryId,
      provider: (body.provider || 'monitoring').toLowerCase(),
      eventType: body.event_type,
      body,
    });
  }

  private async enqueue(input: EnqueueInput): Promise<WebhookAcceptance> {
    await this.dbService.initialize();
    const recordId = randomUUID();
    const accepted = await this.dbService.db.transaction(async (tx) => {
      const inserted = await tx.query<any>(
        `INSERT INTO integration_deliveries
         (id, org_id, provider, integration_kind, delivery_id, event_type, status,
          attempts, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0, $7, CURRENT_TIMESTAMP)
         ON CONFLICT (org_id, provider, delivery_id) DO NOTHING
         RETURNING id, status`,
        [
          recordId, input.orgId, input.provider, input.kind, input.deliveryId,
          input.eventType, JSON.stringify(input.body),
        ],
      );

      if (inserted.rows.length === 0) {
        const existing = await tx.query<any>(
          `SELECT id, status FROM integration_deliveries
           WHERE org_id = $1 AND provider = $2 AND delivery_id = $3`,
          [input.orgId, input.provider, input.deliveryId],
        );
        return { duplicate: true, status: existing.rows[0].status, event: null };
      }

      const event = await this.outbox.enqueue(tx, {
        event_type: 'InboundWebhookAccepted',
        work_item_id: recordId,
        org_id: input.orgId,
        actor: { type: 'integration', id: input.provider },
        payload: {
          org_id: input.orgId,
          delivery_record_id: recordId,
          integration_kind: input.kind,
          provider: input.provider,
          delivery_id: input.deliveryId,
          body: input.body,
        },
      });
      return { duplicate: false, status: 'queued', event };
    });

    if (accepted.event) {
      // Deliberately detached from the request promise: the controller can return HTTP 202
      // once persistence succeeds, before any work-item mutation begins.
      setImmediate(() => { void this.outbox.dispatch(accepted.event!); });
    }

    return {
      accepted: true,
      duplicate: accepted.duplicate,
      delivery_id: input.deliveryId,
      provider: input.provider,
      status: accepted.status,
      status_url: `/integrations/${input.kind}/deliveries/${encodeURIComponent(input.deliveryId)}`
        + `?provider=${encodeURIComponent(input.provider)}`,
    };
  }

  private processSerially(event: DomainEventEnvelope): Promise<void> {
    const run = this.processingTail.then(() => this.processEvent(event));
    this.processingTail = run.catch(() => undefined);
    return run;
  }

  private async processEvent(event: DomainEventEnvelope): Promise<void> {
    // Optional throttle for constrained pilot environments and deterministic backpressure
    // testing. It delays the worker, never the HTTP acknowledgement.
    if (this.processingDelayMs > 0) await wait(this.processingDelayMs);

    const recordId = String(event.payload?.delivery_record_id || '');
    if (!recordId) throw new Error('Inbound webhook event has no delivery_record_id');

    const claimed = await this.dbService.db.query<any>(
      `UPDATE integration_deliveries
       SET status = 'processing', attempts = attempts + 1,
           claimed_at = CURRENT_TIMESTAMP, error = NULL
       WHERE id = $1 AND status IN ('queued', 'processing', 'failed')
       RETURNING *`,
      [recordId],
    );
    if (claimed.rows.length === 0) return;

    const row = claimed.rows[0];
    const body = event.payload?.body || this.parseJson(row.payload);
    if (event.payload?.body) {
      // DLQ replay may carry an operator-corrected body; retain it on the delivery record.
      await this.dbService.db.query(
        `UPDATE integration_deliveries SET payload = $2 WHERE id = $1`,
        [recordId, JSON.stringify(body)],
      );
    }

    try {
      if (row.integration_kind === 'monitoring') {
        await this.monitoringService.processQueuedMonitoringWebhook(
          recordId, row.org_id, row.provider, row.delivery_id, body as MonitoringWebhookDto,
        );
      } else {
        await this.gitService.processQueuedGitWebhook(
          recordId, row.org_id, row.provider, row.delivery_id, body as GitWebhookDto,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = Number(row.attempts) >= MAX_PROCESSING_ATTEMPTS;
      await this.dbService.db.query(
        `UPDATE integration_deliveries
         SET status = $2, error = $3, claimed_at = NULL,
             processed_at = CASE WHEN $2 = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE id = $1`,
        [recordId, exhausted ? 'failed' : 'queued', message],
      );
      throw error;
    }
  }

  private parseJson(value: any): any {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  }
}
