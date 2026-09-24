import { Module } from '@nestjs/common';
import { FlowClassificationService } from './flow-classification.service';
import { FlowRiskController } from './flow-risk.controller';
import { FlowRiskScheduler, FlowRiskService } from './flow-risk.service';
import { FlowController } from './flow.controller';
import { FlowService } from './flow.service';

@Module({
  controllers: [FlowController, FlowRiskController],
  providers: [FlowService, FlowClassificationService, FlowRiskService, FlowRiskScheduler],
  exports: [FlowService, FlowClassificationService, FlowRiskService, FlowRiskScheduler],
})
export class FlowModule {}
