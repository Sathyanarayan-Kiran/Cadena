import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Headers,
} from '@nestjs/common';
import { WorkItemService, UnrecognizedTypeError } from './work-item.service';
import { CreateWorkItemDto } from './work-item.types';

@Controller('workitems')
export class WorkItemController {
  private service = new WorkItemService();

  @Post()
  async createWorkItem(
    @Body() dto: CreateWorkItemDto,
    @Headers('x-actor-id') actorId?: string,
  ) {
    try {
      const item = await this.service.createWorkItem(dto, actorId || 'user-1');
      return item;
    } catch (err) {
      if (err instanceof UnrecognizedTypeError) {
        throw new HttpException(
          {
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: err.message,
            valid_types: err.valid_types,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw err;
    }
  }
}
