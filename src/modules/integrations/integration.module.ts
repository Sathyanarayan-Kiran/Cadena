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

@Module({
  controllers: [
    GitIntegrationController,
    ExternalArtifactController,
    MonitoringIntegrationController,
    MonitoringEvidenceController,
    CorrelationController,
    SyncGuardController,
  ],
  providers: [
    IntegrationService,
    MonitoringIntegrationService,
    InboundWebhookQueueService,
    CorrelationService,
    SyncGuardService,
  ],
  exports: [
    IntegrationService,
    MonitoringIntegrationService,
    InboundWebhookQueueService,
    CorrelationService,
    SyncGuardService,
  ],
})
export class IntegrationModule {}
