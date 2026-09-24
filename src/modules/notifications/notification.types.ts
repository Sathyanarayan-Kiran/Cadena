export const NOTIFICATION_CHANNELS = ['email', 'slack', 'teams'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Channel every failed delivery falls back to (US8.3). Email is the only channel every
 * person is guaranteed to have an address for, because `people.email` is required.
 */
export const FALLBACK_CHANNEL: NotificationChannel = 'email';

export const DEFAULT_ESCALATION_THRESHOLD_PERCENT = 150;

export type NotificationEventType = 'SLAWarning' | 'SLABreached' | 'SLAEscalated' | 'FlowWaitRiskCrossed';

/** Why this person is on the notification: drives routing and the audit trail. */
export type RecipientRole = 'owner' | 'team_lead' | 'escalation_target';

export type NotificationStatus = 'sent' | 'fallback_sent' | 'failed' | 'skipped';

export interface NotificationPreference {
  person_id: string;
  org_id: string;
  channel: NotificationChannel;
  address: string | null;
}

export interface UpdateNotificationPreferenceDto {
  person_id?: string;
  channel?: string;
  address?: string | null;
}

export interface NotificationSettings {
  org_id: string;
  escalation_threshold_percent: number;
  /**
   * Pilot-only. Simulates a channel outage so the US8.3 fallback path can be exercised
   * without a real transport. A production adapter fails on genuine transport errors.
   */
  unavailable_channels: NotificationChannel[];
}

export interface UpdateNotificationSettingsDto {
  escalation_threshold_percent?: number;
  unavailable_channels?: string[];
}

export interface DeliveryAttempt {
  channel: NotificationChannel;
  delivered: boolean;
  at: string;
  error?: string;
}

export interface NotificationRecord {
  id: string;
  org_id: string;
  event_id: string;
  event_type: NotificationEventType;
  work_item_id: string;
  work_item_key: string | null;
  recipient_id: string;
  recipient_role: RecipientRole;
  requested_channel: NotificationChannel;
  channel: NotificationChannel;
  status: NotificationStatus;
  subject: string;
  body: string;
  attempts: DeliveryAttempt[];
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface NotificationDispatchSummary {
  event_id: string;
  event_type: NotificationEventType;
  work_item_id: string;
  notifications: NotificationRecord[];
  skipped: Array<{ recipient_id: string; reason: string }>;
}

export class InvalidNotificationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNotificationConfigError';
  }
}
