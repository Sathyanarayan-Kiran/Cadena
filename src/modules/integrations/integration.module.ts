import { Module } from '@nestjs/common';
import { ExternalArtifactController, GitIntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { MonitoringEvidenceController, MonitoringIntegrationController } from './monitoring.controller';
import { MonitoringIntegrationService } from './monitoring.service';
import { InboundWebhookQueueService } from './inbound-webhook-queue.service';
import { CorrelationController } from './correlation.controller';
import { CorrelationService } from './correlation.service';
import { SyncGuardController } from './sync-guard.controller';
import { SyncGuardService } from './sync-guard.service';
import { StateMappingController } from './state-mapping.controller';
import { StateMappingService } from './state-mapping.service';

@Module({
  controllers: [
    GitIntegrationController,
    ExternalArtifactController,
    MonitoringIntegrationController,
    MonitoringEvidenceController,
    CorrelationController,
    SyncGuardController,
    StateMappingController,
  ],
  providers: [
    IntegrationService,
    MonitoringIntegrationService,
    InboundWebhookQueueService,
    CorrelationService,
    SyncGuardService,
    StateMappingService,
  ],
  exports: [
    IntegrationService,
    MonitoringIntegrationService,
    InboundWebhookQueueService,
    CorrelationService,
    SyncGuardService,
    StateMappingService,
  ],
})
export class IntegrationModule {}
