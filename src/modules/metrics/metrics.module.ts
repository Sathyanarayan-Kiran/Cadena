import { Module } from '@nestjs/common';
import { EventStoreService } from '../events/event-store.service';
import { EventStoreController, MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  controllers: [MetricsController, EventStoreController],
  providers: [MetricsService, EventStoreService],
  exports: [MetricsService, EventStoreService],
})
export class MetricsModule {}
