import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { EventConsumerRegistry } from './consumer-registry.service';
import { DeadLetterNotFoundError, DeadLetterService, InvalidReplayError } from './dead-letter.service';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) {
    throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  }
  return orgId.trim();
}

function toHttpError(error: unknown): never {
  if (error instanceof DeadLetterNotFoundError) {
    throw new HttpException(
      { statusCode: 404, error: 'not_found', message: error.message },
      HttpStatus.NOT_FOUND,
    );
  }
  if (error instanceof InvalidReplayError) {
    throw new HttpException(
      { statusCode: 422, error: 'invalid_replay', message: error.message },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  throw error;
}

@Controller('dlq')
export class DeadLetterController {
  private readonly service = new DeadLetterService();

  @Get()
  async list(
    @Headers('x-org-id') orgId?: string,
    @Query('consumer') consumer?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({
      org_id: requireOrg(orgId),
      consumer,
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('depth')
  async depth(@Headers('x-org-id') orgId?: string) {
    const tenant = requireOrg(orgId);
    return {
      ...(await this.service.depth(tenant)),
      registered_consumers: EventConsumerRegistry.registered(),
    };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    requireOrg(orgId);
    try {
      return await this.service.get(id);
    } catch (error) {
      toHttpError(error);
    }
  }

  @Post(':id/replay')
  async replay(
    @Param('id') id: string,
    @Body() body: { payload?: Record<string, unknown> },
    @Headers('x-org-id') orgId?: string,
  ) {
    requireOrg(orgId);
    try {
      return await this.service.replay(id, body?.payload);
    } catch (error) {
      toHttpError(error);
    }
  }

  @Post(':id/discard')
  async discard(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Headers('x-org-id') orgId?: string,
  ) {
    requireOrg(orgId);
    try {
      return await this.service.discard(id, body?.reason);
    } catch (error) {
      toHttpError(error);
    }
  }
}
