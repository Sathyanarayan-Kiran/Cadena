import { Module } from '@nestjs/common';
import { ExternalArtifactController, GitIntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { MonitoringEvidenceController, MonitoringIntegrationController } from './monitoring.controller';
import { MonitoringIntegrationService } from './monitoring.service';
import { InboundWebhookQueueService } from './inbound-webhook-queue.service';

@Module({
  controllers: [
    GitIntegrationController,
    ExternalArtifactController,
    MonitoringIntegrationController,
    MonitoringEvidenceController,
  ],
  providers: [IntegrationService, MonitoringIntegrationService, InboundWebhookQueueService],
  exports: [IntegrationService, MonitoringIntegrationService, InboundWebhookQueueService],
})
export class IntegrationModule {}
