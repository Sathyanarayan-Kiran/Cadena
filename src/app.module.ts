import { Module } from '@nestjs/common';
import { WorkItemController } from './modules/work-items/work-item.controller';
import { WorkflowController } from './modules/workflow/workflow.controller';

@Module({
  imports: [],
  controllers: [WorkItemController, WorkflowController],
  providers: [],
})
export class AppModule {}
