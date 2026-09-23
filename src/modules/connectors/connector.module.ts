import { Module } from '@nestjs/common';
import { ConnectorController } from './connector.controller';
import { ConnectorService } from './connector.service';
import { FieldMappingController } from './mapping/field-mapping.controller';
import { FieldMappingService } from './mapping/field-mapping.service';
import { NativeQueryController } from './native-query/native-query.controller';
import { NativeQueryService } from './native-query/native-query.service';

@Module({
  controllers: [ConnectorController, FieldMappingController, NativeQueryController],
  providers: [ConnectorService, FieldMappingService, NativeQueryService],
  exports: [ConnectorService, FieldMappingService, NativeQueryService],
})
export class ConnectorModule {}
