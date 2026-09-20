import { Module } from '@nestjs/common';
import { ServiceRegistryController } from './service-registry.controller';
import { ServiceRegistryService } from './service-registry.service';
import { ImpactService } from '../lineage/impact.service';

@Module({
  controllers: [ServiceRegistryController],
  providers: [ServiceRegistryService, ImpactService],
  exports: [ServiceRegistryService, ImpactService],
})
export class ServiceRegistryModule {}
