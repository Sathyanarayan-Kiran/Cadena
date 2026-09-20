import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { NotificationService } from './notification.service';
import {
  InvalidNotificationConfigError,
  UpdateNotificationPreferenceDto,
  UpdateNotificationSettingsDto,
} from './notification.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) {
    throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  }
  return orgId.trim();
}

function toHttpError(error: unknown): never {
  if (error instanceof InvalidNotificationConfigError) {
    throw new HttpException(
      { statusCode: 422, error: 'invalid_notification_config', message: error.message },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  throw error;
}

@Controller('notifications')
export class NotificationController {
  // Instantiated directly, as every other controller here does: the vitest esbuild
  // transform does not emit decorator metadata, so constructor injection by type is
  // unavailable under test. The service holds no per-instance state.
  private readonly service = new NotificationService();

  @Get()
  async listNotifications(
    @Headers('x-org-id') orgId?: string,
    @Query('recipient_id') recipientId?: string,
    @Query('work_item_id') workItemId?: string,
    @Query('event_type') eventType?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listNotifications(requireOrg(orgId), {
      recipient_id: recipientId,
      work_item_id: workItemId,
      event_type: eventType,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('settings')
  async getSettings(@Headers('x-org-id') orgId?: string) {
    return this.service.getSettings(requireOrg(orgId));
  }

  @Post('settings')
  async updateSettings(
    @Body() body: UpdateNotificationSettingsDto,
    @Headers('x-org-id') orgId?: string,
  ) {
    const tenant = requireOrg(orgId);
    try {
      return await this.service.updateSettings(tenant, body || {});
    } catch (error) {
      toHttpError(error);
    }
  }

  @Post('preferences')
  async setPreference(
    @Body() body: UpdateNotificationPreferenceDto,
    @Headers('x-org-id') orgId?: string,
  ) {
    const tenant = requireOrg(orgId);
    try {
      return await this.service.setPreference(tenant, body || {});
    } catch (error) {
      toHttpError(error);
    }
  }

  @Get('preferences/:personId')
  async getPreference(@Param('personId') personId: string, @Headers('x-org-id') orgId?: string) {
    return this.service.getPreference(requireOrg(orgId), personId);
  }

  @Post('escalation-targets/:teamId')
  async setEscalationTarget(
    @Param('teamId') teamId: string,
    @Body() body: { person_id?: string | null },
    @Headers('x-org-id') orgId?: string,
  ) {
    const tenant = requireOrg(orgId);
    try {
      return await this.service.setTeamEscalationTarget(tenant, teamId, body?.person_id ?? null);
    } catch (error) {
      toHttpError(error);
    }
  }
}
