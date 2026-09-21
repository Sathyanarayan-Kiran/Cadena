import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { WorkItemController } from './modules/work-items/work-item.controller';
import { WorkflowController } from './modules/workflow/workflow.controller';
import { LineageController } from './modules/lineage/lineage.controller';
import { SlaModule } from './modules/sla/sla.module';
import { IntegrationModule } from './modules/integrations/integration.module';
import { ServiceRegistryModule } from './modules/services/service-registry.module';
import { NotificationModule } from './modules/notifications/notification.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/workitems*', '/sla-policies*', '/aging*', '/workflows*', '/integrations*', '/services*', '/notifications*', '/metrics*', '/events*', '/dlq*', '/auth*'],
    }),
    SlaModule,
    IntegrationModule,
    ServiceRegistryModule,
    NotificationModule,
    MetricsModule,
    AuthModule,
  ],
  controllers: [WorkItemController, WorkflowController, LineageController],
  providers: [],
})
export class AppModule {}
