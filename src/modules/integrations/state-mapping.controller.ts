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
  Query,
} from '@nestjs/common';
import { StateMappingService } from './state-mapping.service';
import {
  CreateStateMappingDto,
  InvalidStateMappingError,
  StateMappingConflictError,
  StateMappingIdentityNotFoundError,
  StateMappingNotFoundError,
  TranslateStateChangeDto,
} from './state-mapping.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

@Controller('integrations/state-mappings')
export class StateMappingController {
  constructor(@Inject(StateMappingService) private readonly service: StateMappingService) {}

  @Post()
  async createDraft(
    @Body() dto: CreateStateMappingDto,
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

  @Get('transactions')
  async transactions(
    @Headers('x-org-id') orgId?: string,
    @Query('limit') requestedLimit?: string,
  ) {
    try {
      const limit = requestedLimit === undefined ? 100 : Number(requestedLimit);
      return await this.service.listTransactions(requireOrg(orgId), limit);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Post('translate')
  async translate(
    @Body() dto: TranslateStateChangeDto,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    try {
      return await this.service.translate(requireOrg(orgId), dto, actorId || 'integration:state-mapper');
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
    if (error instanceof StateMappingNotFoundError || error instanceof StateMappingIdentityNotFoundError) {
      throw new HttpException(
        { statusCode: 404, error: 'state_mapping_not_found', message: error.message },
        HttpStatus.NOT_FOUND,
      );
    }
    if (error instanceof StateMappingConflictError) {
      throw new HttpException(
        { statusCode: 409, error: 'state_mapping_conflict', message: error.message },
        HttpStatus.CONFLICT,
      );
    }
    if (error instanceof InvalidStateMappingError) {
      throw new HttpException(
        { statusCode: 422, error: 'invalid_state_mapping', message: error.message },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    throw error;
  }
}

