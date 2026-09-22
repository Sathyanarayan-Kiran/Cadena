import { Module } from '@nestjs/common';
import { ConnectorModule } from '../connectors/connector.module';
import { WorkspaceController } from './workspace.controller';

@Module({
  imports: [ConnectorModule],
  controllers: [WorkspaceController],
})
export class WorkspaceModule {}
