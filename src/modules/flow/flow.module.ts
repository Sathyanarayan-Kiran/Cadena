import { Module } from '@nestjs/common';
import { FlowClassificationService } from './flow-classification.service';
import { FlowController } from './flow.controller';
import { FlowService } from './flow.service';

@Module({
  controllers: [FlowController],
  providers: [FlowService, FlowClassificationService],
  exports: [FlowService, FlowClassificationService],
})
export class FlowModule {}
