import { Module } from '@nestjs/common';
import { BackfillController } from './backfill/backfill.controller';
import { BackfillRunnerService } from './backfill/backfill-runner.service';
import { BackfillScheduler } from './backfill/backfill.scheduler';
import { BackfillService } from './backfill/backfill.service';
import { ConnectorController } from './connector.controller';
import { ConnectorService } from './connector.service';
import { FieldMappingController } from './mapping/field-mapping.controller';
import { FieldMappingService } from './mapping/field-mapping.service';
import { NativeQueryController } from './native-query/native-query.controller';
import { NativeQueryScheduler } from './native-query/native-query.scheduler';
import { NativeQueryService } from './native-query/native-query.service';

@Module({
  controllers: [ConnectorController, FieldMappingController, NativeQueryController, BackfillController],
  providers: [ConnectorService, FieldMappingService, NativeQueryService, NativeQueryScheduler, BackfillService, BackfillRunnerService, BackfillScheduler],
  exports: [ConnectorService, FieldMappingService, NativeQueryService, NativeQueryScheduler, BackfillService, BackfillRunnerService, BackfillScheduler],
})
export class ConnectorModule {}
