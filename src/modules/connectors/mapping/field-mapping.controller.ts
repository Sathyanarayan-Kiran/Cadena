import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { FieldMappingService } from './field-mapping.service';
import {
  CreateFieldMappingDto,
  FieldMappingConflictError,
  FieldMappingEndpoint,
  FieldMappingNotFoundError,
  InvalidFieldMappingError,
  PreviewFieldMappingDto,
} from './field-mapping.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

@Controller('integrations/field-mappings')
export class FieldMappingController {
  constructor(@Inject(FieldMappingService) private readonly service: FieldMappingService) {}

  @Post()
  async createDraft(
    @Body() dto: CreateFieldMappingDto,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    try {
      return await this.service.createDraft(requireOrg(orgId), dto, actorId || 'integration-operator');
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get()
  async list(@Headers('x-org-id') orgId?: string) {
    return this.service.list(requireOrg(orgId));
  }

  @Post('preview')
  async preview(
    @Body() dto: PreviewFieldMappingDto & { source?: FieldMappingEndpoint; target?: FieldMappingEndpoint },
    @Headers('x-org-id') orgId?: string,
  ) {
    try {
      if (!dto?.source || !dto?.target) throw new InvalidFieldMappingError('source and target are required');
      if (dto.direction !== 'source_to_target' && dto.direction !== 'target_to_source') {
        throw new InvalidFieldMappingError('direction must be source_to_target or target_to_source');
      }
      return await this.service.preview(requireOrg(orgId), dto as PreviewFieldMappingDto & { source: FieldMappingEndpoint; target: FieldMappingEndpoint });
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get(':id')
  async get(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    try {
      return await this.service.get(requireOrg(orgId), id);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Post(':id/publish')
  async publish(
    @Param('id') id: string,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    try {
      return await this.service.publish(requireOrg(orgId), id, actorId || 'integration-operator');
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof FieldMappingNotFoundError) {
      throw new HttpException({ statusCode: 404, error: 'field_mapping_not_found', message: error.message }, HttpStatus.NOT_FOUND);
    }
    if (error instanceof FieldMappingConflictError) {
      throw new HttpException({ statusCode: 409, error: 'field_mapping_conflict', message: error.message }, HttpStatus.CONFLICT);
    }
    if (error instanceof InvalidFieldMappingError) {
      throw new HttpException({ statusCode: 422, error: 'invalid_field_mapping', message: error.message }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    throw error;
  }
}
