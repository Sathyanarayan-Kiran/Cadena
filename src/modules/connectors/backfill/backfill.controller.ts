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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { BackfillRunnerService } from './backfill-runner.service';
import { BackfillService } from './backfill.service';
import {
  BackfillConflictError,
  BackfillNotFoundError,
  CreateBackfillJobDto,
  InvalidBackfillError,
} from './backfill.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

const actor = (header?: string) => header || 'integration-operator';

@Controller('integrations/backfill-jobs')
export class BackfillController {
  constructor(
    @Inject(BackfillService) private readonly service: BackfillService,
    @Inject(BackfillRunnerService) private readonly runner: BackfillRunnerService,
  ) {}

  /** Plans a job: validates it and materializes its chunks. Nothing is read from the provider yet. */
  @Post()
  async create(@Body() dto: CreateBackfillJobDto, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    return this.guard(() => this.service.create(requireOrg(orgId), dto, actor(actorId)));
  }

  @Get()
  async list(@Headers('x-org-id') orgId?: string) {
    return this.service.list(requireOrg(orgId));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    return this.guard(() => this.service.get(requireOrg(orgId), id));
  }

  @Get(':id/chunks')
  async chunks(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    return this.guard(() => this.service.chunks(requireOrg(orgId), id));
  }

  /** Works a running job now for up to `max_ms` (default 20s); the scheduler does the same on a timer. */
  @Post(':id/run')
  async run(@Param('id') id: string, @Body() body: { max_ms?: number }, @Headers('x-org-id') orgId?: string) {
    const maxMs = Number.isInteger(body?.max_ms) && body!.max_ms! > 0 ? Math.min(body!.max_ms!, 120_000) : undefined;
    return this.guard(() => this.runner.runJob(requireOrg(orgId), id, maxMs));
  }

  /** The CSV audit report: one row per record read, plus one per failed chunk. */
  @Get(':id/report.csv')
  async report(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    const report = await this.guard(() => this.service.report(requireOrg(orgId), id, actor(actorId)));
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    response.setHeader('X-Report-Rows', String(report.rows));
    return report.csv;
  }

  @Post(':id/start')
  async start(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    return this.guard(() => this.service.start(requireOrg(orgId), id, actor(actorId)));
  }

  @Post(':id/pause')
  async pause(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    return this.guard(() => this.service.pause(requireOrg(orgId), id, actor(actorId)));
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    return this.guard(() => this.service.resume(requireOrg(orgId), id, actor(actorId)));
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    return this.guard(() => this.service.cancel(requireOrg(orgId), id, actor(actorId)));
  }

  @Post(':id/retry-failed')
  async retryFailed(@Param('id') id: string, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    return this.guard(() => this.service.retryFailed(requireOrg(orgId), id, actor(actorId)));
  }

  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof BackfillNotFoundError) {
        throw new HttpException({ statusCode: 404, error: 'backfill_not_found', message: error.message }, HttpStatus.NOT_FOUND);
      }
      if (error instanceof BackfillConflictError) {
        throw new HttpException({ statusCode: 409, error: 'backfill_conflict', message: error.message }, HttpStatus.CONFLICT);
      }
      if (error instanceof InvalidBackfillError) {
        throw new HttpException(
          { statusCode: 422, error: 'invalid_backfill', message: error.message, validation: error.validation },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw error;
    }
  }
}
