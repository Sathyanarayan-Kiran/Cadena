import { Module } from '@nestjs/common';
import { WorkItemController } from './modules/work-items/work-item.controller';
import { WorkflowController } from './modules/workflow/workflow.controller';
import { LineageController } from './modules/lineage/lineage.controller';

@Module({
  imports: [],
  controllers: [WorkItemController, WorkflowController, LineageController],
  providers: [],
})
export class AppModule {}
