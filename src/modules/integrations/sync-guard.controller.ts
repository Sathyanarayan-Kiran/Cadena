import {
  Body,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import { SyncGuardService } from './sync-guard.service';
import {
  EvaluateSyncWebhookDto,
  InvalidSyncGuardError,
  RecordIntegrationWriteDto,
  SyncIdentityNotFoundError,
} from './sync-guard.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

@Controller('integrations/sync-guard')
export class SyncGuardController {
  constructor(@Inject(SyncGuardService) private readonly service: SyncGuardService) {}

  @Post('writes')
  async recordWrite(
    @Body() dto: RecordIntegrationWriteDto,
    @Headers('x-org-id') orgId?: string,
  ) {
    try {
      return await this.service.recordIntegrationWrite(requireOrg(orgId), dto);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Post('evaluate')
  async evaluate(
    @Body() dto: EvaluateSyncWebhookDto,
    @Headers('x-org-id') orgId?: string,
  ) {
    try {
      return await this.service.evaluateWebhook(requireOrg(orgId), dto);
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof SyncIdentityNotFoundError) {
      throw new HttpException(
        { statusCode: 404, error: 'sync_identity_not_found', message: error.message },
        HttpStatus.NOT_FOUND,
      );
    }
    if (error instanceof InvalidSyncGuardError) {
      throw new HttpException(
        { statusCode: 422, error: 'invalid_sync_guard_payload', message: error.message },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    throw error;
  }
}

