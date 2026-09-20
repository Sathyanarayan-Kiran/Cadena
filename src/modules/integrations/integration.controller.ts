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
import { GitWebhookDto } from './integration.types';
import { IntegrationService, InvalidIntegrationPayloadError } from './integration.service';

@Controller('integrations/git')
export class GitIntegrationController {
  private readonly service = new IntegrationService();

  @Post('webhooks')
  async receiveWebhook(
    @Body() body: GitWebhookDto,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-delivery-id') deliveryHeader?: string,
    @Headers('x-github-delivery') githubDelivery?: string,
  ) {
    if (!orgId) {
      throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
    }
    const deliveryId = deliveryHeader || githubDelivery || body.delivery_id || '';
    try {
      return await this.service.processGitWebhook(orgId, body, deliveryId);
    } catch (error) {
      if (error instanceof InvalidIntegrationPayloadError) {
        throw new HttpException(
          { statusCode: 422, error: 'invalid_integration_payload', message: error.message },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw error;
    }
  }

  @Get('deliveries/:deliveryId')
  async getDelivery(
    @Param('deliveryId') deliveryId: string,
    @Headers('x-org-id') orgId?: string,
    @Query('provider') provider = 'github',
  ) {
    if (!orgId) {
      throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
    }
    const delivery = await this.service.getDelivery(orgId, provider, deliveryId);
    if (!delivery) {
      throw new HttpException('Integration delivery not found', HttpStatus.NOT_FOUND);
    }
    return delivery;
  }
}

@Controller('workitems')
export class ExternalArtifactController {
  private readonly service = new IntegrationService();

  @Get(':id/external-links')
  async listExternalLinks(
    @Param('id') id: string,
    @Headers('x-org-id') orgId?: string,
  ) {
    if (!orgId) {
      throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.service.listExternalLinks(id, orgId);
    } catch (error) {
      if (error instanceof InvalidIntegrationPayloadError) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw error;
    }
  }
}
