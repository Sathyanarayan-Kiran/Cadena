import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { DomainEventEnvelope, InProcessEventBus } from '../events/event-bus';
import { EventConsumerRegistry } from '../events/consumer-registry.service';
import { buildChannelAdapters, NotificationChannelAdapter } from './notification-channels';
import {
  DEFAULT_ESCALATION_THRESHOLD_PERCENT,
  DeliveryAttempt,
  FALLBACK_CHANNEL,
  InvalidNotificationConfigError,
  NOTIFICATION_CHANNELS,
  NotificationChannel,
  NotificationDispatchSummary,
  NotificationEventType,
  NotificationPreference,
  NotificationRecord,
  NotificationSettings,
  NotificationStatus,
  RecipientRole,
  UpdateNotificationPreferenceDto,
  UpdateNotificationSettingsDto,
} from './notification.types';

interface ResolvedRecipient {
  person_id: string;
  role: RecipientRole;
  name: string;
  email: string;
}

const SUBSCRIBED_EVENTS: NotificationEventType[] = ['SLAWarning', 'SLABreached', 'SLAEscalated', 'FlowWaitRiskCrossed'];

/**
 * Epic 8 — notification and escalation routing.
 *
 * Subscribes to the SLA events the aging engine already publishes and turns them into
 * per-recipient deliveries on each person's preferred channel, falling back to email when
 * the preferred channel cannot be reached (US8.3). Every dispatch is written to the
 * `notifications` table, which is both the audit trail and the idempotency key: the
 * unique constraint on (event_id, recipient_id) means a replayed event notifies nobody twice.
 */
@Injectable()
export class NotificationService implements OnModuleInit {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();
  public static readonly CONSUMER_NAME = 'notifications';
  private static subscribedBuses = new WeakSet<InProcessEventBus>();

  onModuleInit(): void {
    this.subscribeToEvents();
  }

  /**
   * Registers this service as an event consumer.
   *
   * Dispatch goes through `EventConsumerRegistry`, which supplies idempotency, retry and
   * dead-lettering, so this class no longer swallows its own failures: a persistent fault
   * now surfaces in the dead-letter queue instead of a log line nobody reads.
   */
  public subscribeToEvents(): void {
    if (NotificationService.subscribedBuses.has(this.eventBus)) return;
    NotificationService.subscribedBuses.add(this.eventBus);
    new EventConsumerRegistry().register({
      name: NotificationService.CONSUMER_NAME,
      eventTypes: [...SUBSCRIBED_EVENTS],
      handle: (event) => this.handleSlaEvent(event).then(() => undefined),
    });
  }

  // ---------------------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------------------

  public async getSettings(orgId: string): Promise<NotificationSettings> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM notification_settings WHERE org_id = $1`,
      [orgId],
    );
    if (result.rows.length === 0) {
      return {
        org_id: orgId,
        escalation_threshold_percent: DEFAULT_ESCALATION_THRESHOLD_PERCENT,
        unavailable_channels: [],
      };
    }
    const row = result.rows[0];
    return {
      org_id: row.org_id,
      escalation_threshold_percent: Number(row.escalation_threshold_percent),
      unavailable_channels: (row.unavailable_channels || []) as NotificationChannel[],
    };
  }

  public async updateSettings(
    orgId: string,
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettings> {
    await this.dbService.initialize();
    const current = await this.getSettings(orgId);

    let threshold = current.escalation_threshold_percent;
    if (dto.escalation_threshold_percent !== undefined) {
      if (!Number.isInteger(dto.escalation_threshold_percent) || dto.escalation_threshold_percent <= 100) {
        throw new InvalidNotificationConfigError(
          'escalation_threshold_percent must be a whole number greater than 100, because escalation happens after a breach',
        );
      }
      threshold = dto.escalation_threshold_percent;
    }

    let unavailable = current.unavailable_channels;
    if (dto.unavailable_channels !== undefined) {
      if (!Array.isArray(dto.unavailable_channels)) {
        throw new InvalidNotificationConfigError('unavailable_channels must be an array of channel names');
      }
      unavailable = dto.unavailable_channels.map((value) => this.parseChannel(value));
    }

    await this.dbService.db.query(
      `INSERT INTO notification_settings
       (org_id, escalation_threshold_percent, unavailable_channels, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id) DO UPDATE SET
         escalation_threshold_percent = EXCLUDED.escalation_threshold_percent,
         unavailable_channels = EXCLUDED.unavailable_channels,
         updated_at = CURRENT_TIMESTAMP`,
      [orgId, threshold, unavailable],
    );
    return this.getSettings(orgId);
  }

  public async getPreference(orgId: string, personId: string): Promise<NotificationPreference> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM notification_preferences WHERE person_id = $1 AND org_id = $2`,
      [personId, orgId],
    );
    if (result.rows.length === 0) {
      return { person_id: personId, org_id: orgId, channel: FALLBACK_CHANNEL, address: null };
    }
    const row = result.rows[0];
    return {
      person_id: row.person_id,
      org_id: row.org_id,
      channel: row.channel as NotificationChannel,
      address: row.address,
    };
  }

  public async setPreference(
    orgId: string,
    dto: UpdateNotificationPreferenceDto,
  ): Promise<NotificationPreference> {
    await this.dbService.initialize();
    const personId = dto.person_id?.trim();
    if (!personId) throw new InvalidNotificationConfigError('person_id is required');

    const person = await this.dbService.db.query<any>(
      `SELECT id FROM people WHERE id = $1 AND org_id = $2`,
      [personId, orgId],
    );
    if (person.rows.length === 0) {
      throw new InvalidNotificationConfigError(`Person '${personId}' not found in this tenant`);
    }

    const channel = this.parseChannel(dto.channel ?? FALLBACK_CHANNEL);
    await this.dbService.db.query(
      `INSERT INTO notification_preferences (person_id, org_id, channel, address, created_at, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (person_id) DO UPDATE SET
         channel = EXCLUDED.channel, address = EXCLUDED.address, updated_at = CURRENT_TIMESTAMP`,
      [personId, orgId, channel, dto.address ?? null],
    );
    return this.getPreference(orgId, personId);
  }

  public async setTeamEscalationTarget(
    orgId: string,
    teamId: string,
    personId: string | null,
  ): Promise<{ team_id: string; org_id: string; escalation_person_id: string | null }> {
    await this.dbService.initialize();
    if (personId) {
      const person = await this.dbService.db.query<any>(
        `SELECT id FROM people WHERE id = $1 AND org_id = $2`,
        [personId, orgId],
      );
      if (person.rows.length === 0) {
        throw new InvalidNotificationConfigError(`Person '${personId}' not found in this tenant`);
      }
    }
    await this.dbService.db.query(
      `INSERT INTO team_escalation_targets (team_id, org_id, escalation_person_id, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (team_id) DO UPDATE SET
         escalation_person_id = EXCLUDED.escalation_person_id, updated_at = CURRENT_TIMESTAMP`,
      [teamId, orgId, personId],
    );
    return { team_id: teamId, org_id: orgId, escalation_person_id: personId };
  }

  // ---------------------------------------------------------------------------------------
  // Delivery log
  // ---------------------------------------------------------------------------------------

  public async listNotifications(
    orgId: string,
    filter: { recipient_id?: string; work_item_id?: string; event_type?: string; limit?: number } = {},
  ): Promise<NotificationRecord[]> {
    await this.dbService.initialize();
    const params: any[] = [orgId];
    let query = `SELECT * FROM notifications WHERE org_id = $1`;

    if (filter.recipient_id) {
      params.push(filter.recipient_id);
      query += ` AND recipient_id = $${params.length}`;
    }
    if (filter.work_item_id) {
      params.push(filter.work_item_id);
      query += ` AND work_item_id = $${params.length}`;
    }
    if (filter.event_type) {
      params.push(filter.event_type);
      query += ` AND event_type = $${params.length}`;
    }

    params.push(Math.min(Math.max(filter.limit || 100, 1), 500));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const result = await this.dbService.db.query<any>(query, params);
    return result.rows.map((row) => this.mapNotification(row));
  }

  // ---------------------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------------------

  public async handleSlaEvent(event: DomainEventEnvelope): Promise<NotificationDispatchSummary> {
    await this.dbService.initialize();
    const payload = event.payload || {};
    const orgId = payload.org_id as string;
    const eventType = event.event_type as NotificationEventType;

    const summary: NotificationDispatchSummary = {
      event_id: event.event_id,
      event_type: eventType,
      work_item_id: event.work_item_id,
      notifications: [],
      skipped: [],
    };
    if (!orgId) return summary;

    const settings = await this.getSettings(orgId);
    const adapters = buildChannelAdapters((channel) => settings.unavailable_channels.includes(channel));
    const item = await this.loadWorkItem(orgId, event.work_item_id);
    const recipients = await this.resolveRecipients(orgId, eventType, payload);

    for (const recipient of recipients) {
      const existing = await this.dbService.db.query<any>(
        `SELECT id FROM notifications WHERE event_id = $1 AND recipient_id = $2`,
        [event.event_id, recipient.person_id],
      );
      if (existing.rows.length > 0) {
        summary.skipped.push({ recipient_id: recipient.person_id, reason: 'already notified for this event' });
        continue;
      }

      const record = await this.dispatch(orgId, event, eventType, recipient, payload, item, adapters);
      summary.notifications.push(record);
    }

    if (eventType === 'SLAEscalated') {
      await this.dbService.db.query(
        `UPDATE work_items SET escalated_at = COALESCE(escalated_at, CURRENT_TIMESTAMP) WHERE id = $1 AND org_id = $2`,
        [event.work_item_id, orgId],
      );
    }

    return summary;
  }

  private async dispatch(
    orgId: string,
    event: DomainEventEnvelope,
    eventType: NotificationEventType,
    recipient: ResolvedRecipient,
    payload: Record<string, any>,
    item: { key: string | null; title: string; status: string } | null,
    adapters: Map<NotificationChannel, NotificationChannelAdapter>,
  ): Promise<NotificationRecord> {
    const preference = await this.getPreference(orgId, recipient.person_id);
    const { subject, body } = this.composeMessage(eventType, recipient, payload, item);
    const attempts: DeliveryAttempt[] = [];

    const order: NotificationChannel[] = preference.channel === FALLBACK_CHANNEL
      ? [FALLBACK_CHANNEL]
      : [preference.channel, FALLBACK_CHANNEL];

    let deliveredOn: NotificationChannel | null = null;
    let lastError: string | null = null;

    for (const channel of order) {
      const adapter = adapters.get(channel);
      if (!adapter) continue;
      const address = channel === FALLBACK_CHANNEL
        ? (preference.channel === FALLBACK_CHANNEL ? preference.address || recipient.email : recipient.email)
        : preference.address;

      const outcome = await adapter.deliver({
        channel,
        address,
        subject,
        body,
        recipient_id: recipient.person_id,
        work_item_key: item?.key ?? null,
      });
      attempts.push({
        channel,
        delivered: outcome.delivered,
        at: new Date().toISOString(),
        ...(outcome.error ? { error: outcome.error } : {}),
      });

      if (outcome.delivered) {
        deliveredOn = channel;
        break;
      }
      lastError = outcome.error || `${channel} delivery failed`;
    }

    const status: NotificationStatus = deliveredOn === null
      ? 'failed'
      : deliveredOn === preference.channel ? 'sent' : 'fallback_sent';

    const id = randomUUID();
    await this.dbService.db.query(
      `INSERT INTO notifications
       (id, org_id, event_id, event_type, work_item_id, work_item_key, recipient_id, recipient_role,
        requested_channel, channel, status, subject, body, attempts, error, created_at, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CURRENT_TIMESTAMP,$16)
       ON CONFLICT (event_id, recipient_id) DO NOTHING`,
      [
        id, orgId, event.event_id, eventType, event.work_item_id, item?.key ?? null,
        recipient.person_id, recipient.role, preference.channel, deliveredOn || preference.channel,
        status, subject, body, JSON.stringify(attempts),
        status === 'failed' ? lastError : null,
        deliveredOn ? new Date().toISOString() : null,
      ],
    );

    const stored = await this.dbService.db.query<any>(
      `SELECT * FROM notifications WHERE event_id = $1 AND recipient_id = $2`,
      [event.event_id, recipient.person_id],
    );
    return this.mapNotification(stored.rows[0]);
  }

  /**
   * Resolves who hears about an event. Owner for a warning; owner plus team lead for a
   * breach (US8.2); the configured escalation target for an escalation, falling back to a
   * team member holding an `on_call` or `team_lead` role when none is configured.
   */
  private async resolveRecipients(
    orgId: string,
    eventType: NotificationEventType,
    payload: Record<string, any>,
  ): Promise<ResolvedRecipient[]> {
    const resolved: ResolvedRecipient[] = [];
    const seen = new Set<string>();

    const add = async (personId: string | null | undefined, role: RecipientRole) => {
      if (!personId || seen.has(personId)) return;
      const person = await this.dbService.db.query<any>(
        `SELECT id, name, email FROM people WHERE id = $1 AND org_id = $2`,
        [personId, orgId],
      );
      if (person.rows.length === 0) return;
      seen.add(personId);
      resolved.push({
        person_id: personId,
        role,
        name: person.rows[0].name,
        email: person.rows[0].email,
      });
    };

    if (eventType === 'SLAWarning') {
      await add(payload.owner_id, 'owner');
      return resolved;
    }

    if (eventType === 'SLABreached') {
      await add(payload.owner_id, 'owner');
      await add(payload.team_lead_id ?? (await this.findTeamMemberByRole(payload.team_id, 'team_lead')), 'team_lead');
      return resolved;
    }

    const target = await this.resolveEscalationTarget(orgId, payload.team_id);
    await add(target, 'escalation_target');
    // An escalation that reaches nobody would be silent, so the owner stays on the thread.
    await add(payload.owner_id, 'owner');
    return resolved;
  }

  private async resolveEscalationTarget(orgId: string, teamId?: string): Promise<string | null> {
    if (!teamId) return null;
    const configured = await this.dbService.db.query<any>(
      `SELECT escalation_person_id FROM team_escalation_targets WHERE team_id = $1 AND org_id = $2`,
      [teamId, orgId],
    );
    if (configured.rows.length > 0 && configured.rows[0].escalation_person_id) {
      return configured.rows[0].escalation_person_id;
    }
    return (await this.findTeamMemberByRole(teamId, 'on_call'))
      || (await this.findTeamMemberByRole(teamId, 'team_lead'));
  }

  private async findTeamMemberByRole(teamId: string | undefined, role: string): Promise<string | null> {
    if (!teamId) return null;
    const result = await this.dbService.db.query<any>(
      `SELECT id FROM people WHERE team_id = $1 AND role = $2 LIMIT 1`,
      [teamId, role],
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }

  private composeMessage(
    eventType: NotificationEventType,
    recipient: ResolvedRecipient,
    payload: Record<string, any>,
    item: { key: string | null; title: string; status: string } | null,
  ): { subject: string; body: string } {
    const key = item?.key || payload.work_item_id;
    const score = Math.round(Number(payload.aging_score || 0));
    const state = item?.status || payload.status || 'its current state';
    const title = item?.title || 'Work item';

    if (eventType === 'SLAWarning') {
      return {
        subject: `[SLA warning] ${key} has consumed ${score}% of its SLA`,
        body: `${recipient.name}, ${key} "${title}" has consumed ${score}% of its ${state} SLA `
          + `(${payload.threshold_minutes} minute threshold). Act before it breaches.`,
      };
    }
    if (eventType === 'SLABreached') {
      return {
        subject: `[SLA breached] ${key} is past its ${state} SLA`,
        body: `${recipient.name}, ${key} "${title}" has breached its ${state} SLA at ${score}% `
          + `of a ${payload.threshold_minutes} minute threshold.`,
      };
    }
    if (eventType === 'FlowWaitRiskCrossed') {
      const percentile = Math.round(Number(payload.percentile || 0) * 100);
      const wait = Math.round(Number(payload.current_wait_minutes || 0));
      const overrun = payload.probability_exceed_target === null || payload.probability_exceed_target === undefined
        ? ''
        : ` Estimated chance of exceeding its ${payload.target_minutes} minute target: ${Math.round(Number(payload.probability_exceed_target) * 100)}%.`;
      return {
        subject: `[Waiting risk] ${key} has waited longer than ${percentile}% of comparable items in ${state}`,
        body: `${recipient.name}, ${key} "${title}" has been in ${state} for ${wait} business minutes, longer than ${percentile}% of `
          + `${payload.sample_size} comparable completed visits.${overrun} This is an estimate from history, not a breach.`,
      };
    }
    return {
      subject: `[Escalation] ${key} is at ${score}% of its SLA`,
      body: `${recipient.name}, ${key} "${title}" has reached ${score}% of its ${state} SLA and has `
        + `been escalated. It is flagged as escalated work until someone moves it.`,
    };
  }

  private async loadWorkItem(
    orgId: string,
    workItemId: string,
  ): Promise<{ key: string | null; title: string; status: string } | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT item_key, title, status FROM work_items WHERE id = $1 AND org_id = $2`,
      [workItemId, orgId],
    );
    if (result.rows.length === 0) return null;
    return {
      key: result.rows[0].item_key,
      title: result.rows[0].title,
      status: result.rows[0].status,
    };
  }

  private parseChannel(value: string): NotificationChannel {
    const candidate = String(value || '').toLowerCase() as NotificationChannel;
    if (!NOTIFICATION_CHANNELS.includes(candidate)) {
      throw new InvalidNotificationConfigError(
        `channel must be one of: ${NOTIFICATION_CHANNELS.join(', ')}`,
      );
    }
    return candidate;
  }

  private mapNotification(row: any): NotificationRecord {
    return {
      id: row.id,
      org_id: row.org_id,
      event_id: row.event_id,
      event_type: row.event_type as NotificationEventType,
      work_item_id: row.work_item_id,
      work_item_key: row.work_item_key,
      recipient_id: row.recipient_id,
      recipient_role: row.recipient_role as RecipientRole,
      requested_channel: row.requested_channel as NotificationChannel,
      channel: row.channel as NotificationChannel,
      status: row.status as NotificationStatus,
      subject: row.subject,
      body: row.body,
      attempts: typeof row.attempts === 'string' ? JSON.parse(row.attempts) : (row.attempts || []),
      error: row.error,
      created_at: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
      delivered_at: row.delivered_at
        ? (typeof row.delivered_at === 'string' ? row.delivered_at : new Date(row.delivered_at).toISOString())
        : null,
    };
  }
}
