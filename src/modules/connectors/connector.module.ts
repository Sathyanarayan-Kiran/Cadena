import { Module } from '@nestjs/common';
import { ConnectorController } from './connector.controller';
import { ConnectorService } from './connector.service';
import { FieldMappingController } from './mapping/field-mapping.controller';
import { FieldMappingService } from './mapping/field-mapping.service';

@Module({
  controllers: [ConnectorController, FieldMappingController],
  providers: [ConnectorService, FieldMappingService],
  exports: [ConnectorService, FieldMappingService],
})
export class ConnectorModule {}
