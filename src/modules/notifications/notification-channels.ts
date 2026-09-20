import { NotificationChannel } from './notification.types';

export interface OutboundMessage {
  channel: NotificationChannel;
  address: string | null;
  subject: string;
  body: string;
  recipient_id: string;
  work_item_key: string | null;
}

export interface DeliveryOutcome {
  delivered: boolean;
  error?: string;
}

export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  deliver(message: OutboundMessage): Promise<DeliveryOutcome>;
}

/**
 * Pilot channel adapter.
 *
 * Spec §18.3 keeps external transports out of the pilot, so nothing is actually sent —
 * every dispatch is recorded in the `notifications` table, which is the queryable
 * delivery log. The adapter still models the one failure mode that matters for US8.3:
 * a person who selected a channel they have no address for cannot be reached on it, so
 * delivery fails and the service falls back to email.
 *
 * Swapping in a real transport (SES/SendGrid, Slack Web API, Microsoft Graph) means
 * replacing `transmit` and keeping this contract; the routing, fallback, and audit
 * behaviour in `NotificationService` are transport-independent.
 */
export class PilotChannelAdapter implements NotificationChannelAdapter {
  constructor(
    public readonly channel: NotificationChannel,
    private readonly unavailable: () => boolean,
  ) {}

  public async deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
    if (this.unavailable()) {
      return {
        delivered: false,
        error: `${this.channel} is currently unavailable for this tenant`,
      };
    }
    if (!message.address?.trim()) {
      return {
        delivered: false,
        error: `no ${this.channel} address is configured for this recipient`,
      };
    }
    return this.transmit(message);
  }

  /** Replace this method with a real transport call; everything else stays as is. */
  private async transmit(_message: OutboundMessage): Promise<DeliveryOutcome> {
    return { delivered: true };
  }
}

export function buildChannelAdapters(
  isUnavailable: (channel: NotificationChannel) => boolean,
): Map<NotificationChannel, NotificationChannelAdapter> {
  const adapters = new Map<NotificationChannel, NotificationChannelAdapter>();
  for (const channel of ['email', 'slack', 'teams'] as NotificationChannel[]) {
    adapters.set(channel, new PilotChannelAdapter(channel, () => isUnavailable(channel)));
  }
  return adapters;
}
