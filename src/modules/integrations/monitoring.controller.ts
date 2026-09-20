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
import { InvalidIntegrationPayloadError } from './integration.service';
import { MonitoringIntegrationService } from './monitoring.service';
import { MonitoringWebhookDto, UpdateMonitoringSettingsDto } from './monitoring.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) {
    throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  }
  return orgId.trim();
}

function toHttpError(error: unknown): never {
  if (error instanceof InvalidIntegrationPayloadError) {
    throw new HttpException(
      { statusCode: 422, error: 'invalid_monitoring_payload', message: error.message },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  throw error;
}

/**
 * Tenant-scoped monitoring/APM ingestion (Epic 7).
 *
 * Production boundary: this endpoint trusts the `x-org-id` header and the normalized body.
 * Before it is exposed to a real provider it needs per-tenant shared-secret registration and
 * provider signature verification (Datadog `DD-Signature`, PagerDuty/Grafana HMAC over the
 * raw body) plus timestamp-based replay rejection. See README "Production boundaries".
 */
@Controller('integrations/monitoring')
export class MonitoringIntegrationController {
  private readonly service = new MonitoringIntegrationService();

  @Post('webhooks')
  async receiveWebhook(
    @Body() body: MonitoringWebhookDto,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-delivery-id') deliveryHeader?: string,
    @Headers('x-monitoring-delivery') monitoringDelivery?: string,
  ) {
    const tenant = requireOrg(orgId);
    const deliveryId = deliveryHeader || monitoringDelivery || body?.delivery_id || '';
    try {
      return await this.service.processMonitoringWebhook(tenant, body, deliveryId);
    } catch (error) {
      toHttpError(error);
    }
  }

  @Get('deliveries/:deliveryId')
  async getDelivery(
    @Param('deliveryId') deliveryId: string,
    @Headers('x-org-id') orgId?: string,
    @Query('provider') provider = 'monitoring',
  ) {
    const delivery = await this.service.getDelivery(requireOrg(orgId), provider, deliveryId);
    if (!delivery) {
      throw new HttpException('Monitoring delivery not found', HttpStatus.NOT_FOUND);
    }
    return delivery;
  }

  @Get('settings')
  async getSettings(@Headers('x-org-id') orgId?: string) {
    return this.service.getSettings(requireOrg(orgId));
  }

  @Post('settings')
  async updateSettings(
    @Body() body: UpdateMonitoringSettingsDto,
    @Headers('x-org-id') orgId?: string,
  ) {
    const tenant = requireOrg(orgId);
    try {
      return await this.service.updateSettings(tenant, body || {});
    } catch (error) {
      toHttpError(error);
    }
  }
}

@Controller('workitems')
export class MonitoringEvidenceController {
  private readonly service = new MonitoringIntegrationService();

  @Get(':id/monitoring-alerts')
  async listAlertEvidence(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    const tenant = requireOrg(orgId);
    try {
      return await this.service.listAlertEvidence(tenant, id);
    } catch (error) {
      if (error instanceof InvalidIntegrationPayloadError) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw error;
    }
  }
}
