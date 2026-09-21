import { Module } from '@nestjs/common';
import { EventStoreService } from '../events/event-store.service';
import { DeadLetterController } from '../events/dead-letter.controller';
import { DeadLetterService } from '../events/dead-letter.service';
import { EventConsumerRegistry } from '../events/consumer-registry.service';
import { EventOutboxService } from '../events/event-outbox.service';
import { EventStoreController, MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  controllers: [MetricsController, EventStoreController, DeadLetterController],
  providers: [MetricsService, EventStoreService, DeadLetterService, EventConsumerRegistry, EventOutboxService],
  exports: [MetricsService, EventStoreService, DeadLetterService, EventConsumerRegistry, EventOutboxService],
})
export class MetricsModule {}
