import { Module } from '@nestjs/common';
import { ExternalArtifactController, GitIntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';

@Module({
  controllers: [GitIntegrationController, ExternalArtifactController],
  providers: [IntegrationService],
  exports: [IntegrationService],
})
export class IntegrationModule {}
