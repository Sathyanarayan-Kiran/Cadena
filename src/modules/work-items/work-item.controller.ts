import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Headers,
} from '@nestjs/common';
import { WorkItemService, UnrecognizedTypeError, InvalidCustomFieldsError, ListWorkItemsFilter } from './work-item.service';
import { CreateWorkItemDto } from './work-item.types';
import { CustomFieldSchemaService, RegisterCustomFieldSchemaDto } from './custom-field-schema.service';

@Controller('workitems')
export class WorkItemController {
  private service = new WorkItemService();
  private schemaService = new CustomFieldSchemaService();

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
      if (err instanceof InvalidCustomFieldsError) {
        throw new HttpException(
          {
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: err.message,
            errors: err.errors,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw err;
    }
  }

  @Post('custom-fields/schemas')
  async registerSchema(@Body() dto: RegisterCustomFieldSchemaDto) {
    return this.schemaService.registerSchema(dto);
  }

  @Get()
  async listWorkItems(
    @Query('type') type?: string,
    @Query('state') state?: string,
    @Query('status') status?: string,
    @Query('owner_id') ownerId?: string,
    @Query('team_id') teamId?: string,
    @Query('aging_bucket') agingBucket?: 'green' | 'amber' | 'red',
    @Headers('x-org-id') headerOrgId?: string,
    @Query('org_id') queryOrgId?: string,
  ) {
    const orgId = headerOrgId || queryOrgId || '00000000-0000-0000-0000-000000000099';
    const filter: ListWorkItemsFilter = {
      type,
      state: state || status,
      owner_id: ownerId,
      team_id: teamId,
      aging_bucket: agingBucket,
    };

    return this.service.listWorkItems(filter, orgId);
  }
}
