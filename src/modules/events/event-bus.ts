import { randomUUID } from 'crypto';

export interface DomainEventEnvelope {
  event_id: string;
  event_type: string;
  schema_version: number;
  timestamp: string;
  actor: {
    type: 'user' | 'system' | 'integration';
    id: string;
  };
  work_item_id: string;
  payload: Record<string, any>;
}

export type EventHandler = (event: DomainEventEnvelope) => Promise<void> | void;

export class InProcessEventBus {
  private static instance: InProcessEventBus;
  private handlers: Map<string, EventHandler[]> = new Map();
  public emittedEvents: DomainEventEnvelope[] = [];

  public static getInstance(): InProcessEventBus {
    if (!InProcessEventBus.instance) {
      InProcessEventBus.instance = new InProcessEventBus();
    }
    return InProcessEventBus.instance;
  }

  public subscribe(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) || [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  public async publish(
    eventType: string,
    workItemId: string,
    actor: { type: 'user' | 'system' | 'integration'; id: string },
    payload: Record<string, any>,
  ): Promise<DomainEventEnvelope> {
    const event: DomainEventEnvelope = {
      event_id: randomUUID(),
      event_type: eventType,
      schema_version: 1,
      timestamp: new Date().toISOString(),
      actor,
      work_item_id: workItemId,
      payload,
    };

    this.emittedEvents.push(event);

    const handlers = this.handlers.get(eventType) || [];
    for (const handler of handlers) {
      await handler(event);
    }

    return event;
  }

  public clearEmittedEvents(): void {
    this.emittedEvents = [];
  }
}
