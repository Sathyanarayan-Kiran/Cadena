import { Module } from '@nestjs/common';
import { CostOfDelayController } from './cost-of-delay.controller';
import { CostOfDelayService } from './cost-of-delay.service';
import { FlowClassificationService } from './flow-classification.service';
import { FlowRiskController } from './flow-risk.controller';
import { FlowRiskScheduler, FlowRiskService } from './flow-risk.service';
import { FlowController } from './flow.controller';
import { FlowService } from './flow.service';

@Module({
  controllers: [FlowController, FlowRiskController, CostOfDelayController],
  providers: [FlowService, FlowClassificationService, FlowRiskService, FlowRiskScheduler, CostOfDelayService],
  exports: [FlowService, FlowClassificationService, FlowRiskService, FlowRiskScheduler, CostOfDelayService],
})
export class FlowModule {}
