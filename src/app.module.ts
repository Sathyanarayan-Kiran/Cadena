import { Module } from '@nestjs/common';
import { WorkItemController } from './modules/work-items/work-item.controller';

@Module({
  imports: [],
  controllers: [WorkItemController],
  providers: [],
})
export class AppModule {}
