import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Headers,
} from '@nestjs/common';
import { WorkItemService, UnrecognizedTypeError, InvalidCustomFieldsError, ListWorkItemsFilter } from './work-item.service';
import { CreateWorkItemDto } from './work-item.types';
import { CustomFieldSchemaService, RegisterCustomFieldSchemaDto } from './custom-field-schema.service';
import { WorkflowService, GuardFailedError, MissingRequiredFieldsError, InvalidTransitionError } from '../workflow/workflow.service';
import { RbacService } from '../rbac/rbac.service';
import { importBacklogFixture } from '../../scripts/import-backlog';

@Controller('workitems')
export class WorkItemController {
  private service = new WorkItemService();
  private schemaService = new CustomFieldSchemaService();
  private workflowService = new WorkflowService();
  private rbacService = new RbacService();

  @Post('import-backlog')
  async importBacklog(
    @Headers('x-org-id') headerOrgId?: string,
    @Body('org_id') bodyOrgId?: string,
    @Body('team_id') bodyTeamId?: string,
  ) {
    const orgId = headerOrgId || bodyOrgId || '00000000-0000-0000-0000-000000000099';
    const teamId = bodyTeamId || '00000000-0000-0000-0000-000000000001';

    return importBacklogFixture(orgId, teamId);
  }

  @Post()
  async createWorkItem(
    @Body() dto: CreateWorkItemDto,
    @Headers('x-actor-id') actorId?: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    try {
      if (headerOrgId && dto.org_id && headerOrgId !== dto.org_id) {
        throw new HttpException('Body org_id does not match the active tenant', HttpStatus.FORBIDDEN);
      }
      const item = await this.service.createWorkItem(
        { ...dto, org_id: headerOrgId || dto.org_id },
        actorId || 'user-1',
      );
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

  @Post(':id/transitions')
  async transitionWorkItem(
    @Param('id') id: string,
    @Body() body: { to_state: string; fields?: Record<string, any> },
    @Headers('x-actor-id') actorId?: string,
    @Headers('x-actor-role') headerRole?: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    try {
      const resolvedActorId = actorId || '00000000-0000-0000-0000-000000000001';
      const actorRole = await this.rbacService.resolveActorRole(resolvedActorId, headerRole);

      return await this.workflowService.transitionWorkItem({
        workItemId: id,
        orgId: headerOrgId || '00000000-0000-0000-0000-000000000099',
        toState: body.to_state,
        actorId: resolvedActorId,
        actorRole,
        fields: body.fields,
      });
    } catch (err) {
      if (err instanceof GuardFailedError) {
        throw new HttpException(
          {
            statusCode: 409,
            error: 'guard_failed',
            reason: err.message,
            missing_role: err.missing_role,
          },
          HttpStatus.CONFLICT,
        );
      }
      if (err instanceof MissingRequiredFieldsError) {
        throw new HttpException(
          {
            statusCode: 400,
            error: 'missing_required_fields',
            reason: err.message,
            missing_fields: err.missing_fields,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      if (err instanceof InvalidTransitionError) {
        throw new HttpException(
          {
            statusCode: 400,
            error: 'invalid_transition',
            reason: err.message,
          },
          HttpStatus.BAD_REQUEST,
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

  @Get(':id/available-transitions')
  async getAvailableTransitions(
    @Param('id') id: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    try {
      return await this.workflowService.getAvailableTransitions(
        id,
        headerOrgId || '00000000-0000-0000-0000-000000000099',
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new HttpException(err.message, HttpStatus.NOT_FOUND);
      }
      throw err;
    }
  }

  @Get(':id')
  async getWorkItem(
    @Param('id') id: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    const item = await this.service.getWorkItemById(
      id,
      headerOrgId || '00000000-0000-0000-0000-000000000099',
    );
    if (!item) {
      throw new HttpException('WorkItem not found', HttpStatus.NOT_FOUND);
    }
    return item;
  }
}
