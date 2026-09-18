import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { WorkItemController } from './modules/work-items/work-item.controller';
import { WorkflowController } from './modules/workflow/workflow.controller';
import { LineageController } from './modules/lineage/lineage.controller';
import { SlaModule } from './modules/sla/sla.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/workitems*', '/sla-policies*', '/aging*'],
    }),
    SlaModule,
  ],
  controllers: [WorkItemController, WorkflowController, LineageController],
  providers: [],
})
export class AppModule {}
