import { Module } from '@nestjs/common';
import { SlaCalculatorService } from './sla-calculator.service';
import { AgingEngineService } from './aging-engine.service';
import { SlaController } from './sla.controller';

@Module({
  controllers: [SlaController],
  providers: [SlaCalculatorService, AgingEngineService],
  exports: [SlaCalculatorService, AgingEngineService],
})
export class SlaModule {}
