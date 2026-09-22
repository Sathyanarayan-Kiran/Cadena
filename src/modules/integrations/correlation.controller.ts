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
  Query,
} from '@nestjs/common';
import { CorrelationService, MAX_CORRELATION_DEPTH } from './correlation.service';
import {
  CorrelationNotFoundError,
  CreateCorrelationDto,
  InvalidCorrelationError,
  UpdateCorrelationMetadataDto,
} from './correlation.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

@Controller('integrations/correlations')
export class CorrelationController {
  constructor(@Inject(CorrelationService) private readonly service: CorrelationService) {}

  @Post()
  async createPair(
    @Body() dto: CreateCorrelationDto,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    try {
      return await this.service.createPair(requireOrg(orgId), dto, actorId || 'integration-operator');
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get('resolve')
  async resolve(
    @Headers('x-org-id') orgId?: string,
    @Query('system') system?: string,
    @Query('entity_type') entityType?: string,
    @Query('immutable_id') immutableId?: string,
    @Query('depth') requestedDepth?: string,
  ) {
    try {
      const depth = requestedDepth === undefined ? MAX_CORRELATION_DEPTH : Number(requestedDepth);
      return await this.service.resolve(
        requireOrg(orgId),
        system || '',
        entityType || '',
        immutableId || '',
        depth,
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Patch('nodes/:id')
  async updateMetadata(
    @Param('id') id: string,
    @Body() dto: UpdateCorrelationMetadataDto,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    try {
      return await this.service.updateMetadata(
        requireOrg(orgId),
        id,
        dto,
        actorId || 'integration-operator',
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof CorrelationNotFoundError) {
      throw new HttpException(
        { statusCode: 404, error: 'correlation_not_found', message: error.message },
        HttpStatus.NOT_FOUND,
      );
    }
    if (error instanceof InvalidCorrelationError) {
      throw new HttpException(
        { statusCode: 422, error: 'invalid_correlation', message: error.message },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    throw error;
  }
}
