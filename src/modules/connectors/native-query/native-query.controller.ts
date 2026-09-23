import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { NativeQueryService } from './native-query.service';
import {
  CreateNativeQueryDto,
  InvalidNativeQueryError,
  NativeQueryConflictError,
  NativeQueryNotFoundError,
  UpdateNativeQueryDto,
} from './native-query.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

@Controller('integrations/native-queries')
export class NativeQueryController {
  constructor(@Inject(NativeQueryService) private readonly service: NativeQueryService) {}

  @Post()
  async createDraft(
    @Body() dto: CreateNativeQueryDto,
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

  /** Stateless: checks any JQL, WIQL or encoded query without saving it. */
  @Post('validate')
  async validate(@Body() dto: { language?: string; query?: string }, @Headers('x-org-id') orgId?: string) {
    try {
      requireOrg(orgId);
      return this.service.validateAdHoc(dto?.language, dto?.query);
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

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateNativeQueryDto, @Headers('x-org-id') orgId?: string) {
    try {
      return await this.service.update(requireOrg(orgId), id, dto);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Post(':id/publish')
  async publish(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    try {
      return await this.service.publish(requireOrg(orgId), id, actorId || 'integration-operator');
    } catch (error) {
      this.rethrow(error);
    }
  }

  /** Runs a published query immediately, outside its schedule. */
  @Post(':id/run')
  async run(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    try {
      return await this.service.runNow(requireOrg(orgId), id, actorId || 'integration-operator');
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Post(':id/disable')
  async disable(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    try {
      return await this.service.disable(requireOrg(orgId), id, actorId || 'integration-operator');
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof NativeQueryNotFoundError) {
      throw new HttpException({ statusCode: 404, error: 'native_query_not_found', message: error.message }, HttpStatus.NOT_FOUND);
    }
    if (error instanceof NativeQueryConflictError) {
      throw new HttpException({ statusCode: 409, error: 'native_query_conflict', message: error.message }, HttpStatus.CONFLICT);
    }
    if (error instanceof InvalidNativeQueryError) {
      throw new HttpException(
        { statusCode: 422, error: 'invalid_native_query', message: error.message, validation: error.validation },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    throw error;
  }
}
