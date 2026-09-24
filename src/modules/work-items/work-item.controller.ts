import { InvalidWaitReasonError, parseWaitReason, WaitReason } from '../flow/wait-reason';
import { workspaceConfig } from '../workspace/workspace-config';
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Headers,
} from '@nestjs/common';
import { WorkItemService, UnrecognizedTypeError, InvalidCustomFieldsError, InvalidWorkItemUpdateError, ListWorkItemsFilter } from './work-item.service';
import { CreateWorkItemDto, UpdateWorkItemDto } from './work-item.types';
import { CustomFieldSchemaService, RegisterCustomFieldSchemaDto } from './custom-field-schema.service';
import { WorkflowService, GuardFailedError, MissingRequiredFieldsError, InvalidTransitionError } from '../workflow/workflow.service';
import { RbacService } from '../rbac/rbac.service';
import { importBacklogFixture } from '../../scripts/import-backlog';
import { ConnectorService } from '../connectors/connector.service';
import { ExternallyOwnedWorkItemError } from './work-item-ownership';

/**
 * In connector-led mode, work enters Cadena through connector ingestion (US17.1/US20.2);
 * creating or importing local work items would build the duplicate backlog the product avoids.
 */
function requireLocalCreation(): void {
  if (!workspaceConfig().localCreation) {
    throw new HttpException(
      {
        statusCode: 403,
        error: 'Forbidden',
        message: 'Local work-item creation is disabled in connector-led mode. Records enter Cadena from connected sources.',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

@Controller('workitems')
export class WorkItemController {
  private service = new WorkItemService();
  private schemaService = new CustomFieldSchemaService();
  private workflowService = new WorkflowService();
  private rbacService = new RbacService();

  constructor(@Inject(ConnectorService) private readonly connectors: ConnectorService) {}

  @Post('import-backlog')
  async importBacklog(
    @Headers('x-org-id') headerOrgId?: string,
    @Body('org_id') bodyOrgId?: string,
    @Body('team_id') bodyTeamId?: string,
  ) {
    requireLocalCreation();
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
    requireLocalCreation();
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

  @Patch(':id')
  async updateWorkItem(
    @Param('id') id: string,
    @Body() dto: UpdateWorkItemDto,
    @Headers('x-actor-id') actorId?: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    try {
      const item = await this.service.updateWorkItem(
        id,
        headerOrgId || '00000000-0000-0000-0000-000000000099',
        dto,
        actorId || 'user-1',
      );
      if (!item) throw new HttpException('WorkItem not found', HttpStatus.NOT_FOUND);
      return item;
    } catch (err) {
      if (err instanceof ExternallyOwnedWorkItemError) {
        throw new HttpException(err.toResponse(), HttpStatus.CONFLICT);
      }
      if (err instanceof InvalidWorkItemUpdateError || err instanceof InvalidCustomFieldsError) {
        throw new HttpException(
          {
            statusCode: 422,
            error: 'invalid_work_item_update',
            message: err.message,
            ...(err instanceof InvalidCustomFieldsError ? { errors: err.errors } : {}),
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
    @Body() body: { to_state: string; fields?: Record<string, any>; wait_reason?: unknown },
    @Headers('x-actor-id') actorId?: string,
    @Headers('x-actor-role') headerRole?: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    try {
      let waitReason: WaitReason | null;
      try {
        waitReason = parseWaitReason(body?.wait_reason);
      } catch (err) {
        if (err instanceof InvalidWaitReasonError) {
          throw new HttpException({ statusCode: 422, error: 'invalid_wait_reason', message: err.message }, HttpStatus.UNPROCESSABLE_ENTITY);
        }
        throw err;
      }
      const resolvedActorId = actorId || '00000000-0000-0000-0000-000000000001';
      const actorRole = await this.rbacService.resolveActorRole(resolvedActorId, headerRole);

      const orgId = headerOrgId || '00000000-0000-0000-0000-000000000099';
      try {
        return await this.workflowService.transitionWorkItem({
          workItemId: id,
          orgId,
          toState: body.to_state,
          actorId: resolvedActorId,
          actorRole,
          fields: body.fields,
          waitReason,
        });
      } catch (err) {
        // A twin-backed item's state belongs to its source: route the request through the
        // governed connector write-back, which either executes it there or refuses and explains.
        if (err instanceof ExternallyOwnedWorkItemError && err.twinId) {
          const routed = await this.connectors.routeTwinEdit(orgId, err.twinId, { field: 'state', value: body?.to_state }, resolvedActorId);
          return { ...routed, governed_by: 'connector', work_item_id: id, twin_id: err.twinId };
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof ExternallyOwnedWorkItemError) {
        throw new HttpException(err.toResponse(), HttpStatus.CONFLICT);
      }
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
      const orgId = headerOrgId || '00000000-0000-0000-0000-000000000099';
      const item = await this.service.getWorkItemById(id, orgId);
      if (item?.origin === 'connector' && item.source) {
        // Offer only what the source permits Cadena to write back; otherwise explain ownership.
        const twin = await this.connectors.getTwinDetail(orgId, item.source.twin_id);
        const state = twin.fields.find((field) => field.field === 'state');
        // Projection can be disabled (or a twin held) independently of write-back: the item's
        // OTHER fields stop updating from the source, but a state change still routes to the
        // twin correctly, so this only changes what is said, not what is offered.
        const staleNote = item.source.frozen
          ? ` This item's projection is currently ${twin.projection.status}; its title, priority and other fields may be stale.`
          : '';
        return {
          current_state: item.status,
          governed_by: 'connector',
          authority: item.source.system,
          twin_id: item.source.twin_id,
          stale: item.source.frozen,
          editable: Boolean(state?.editable),
          message: `${state?.message || ''}${staleNote}`.trim(),
          transitions: state?.editable
            ? (state.allowedValues || [])
              .filter((value) => value.toLowerCase() !== item.status.toLowerCase())
              .map((value) => ({ to_state: value, requires_fields: [] }))
            : [],
        };
      }
      return await this.workflowService.getAvailableTransitions(id, orgId);
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
