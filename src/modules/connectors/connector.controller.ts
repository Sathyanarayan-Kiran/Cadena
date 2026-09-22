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
import { ConnectorService } from './connector.service';
import { ConnectorConfigDto } from './connector.types';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) {
    throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  }
  return orgId.trim();
}

function resolveActor(actorId?: string): string {
  return actorId?.trim() || 'integration-admin';
}

@Controller('integrations/connectors')
export class ConnectorController {
  constructor(@Inject(ConnectorService) private readonly service: ConnectorService) {}

  @Get('providers')
  public providers() {
    return this.service.listProviders();
  }

  @Post()
  public async createConnector(
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
    @Body() dto?: ConnectorConfigDto,
  ) {
    const orgId = requireOrg(orgHeader);
    if (!dto || typeof dto !== 'object') {
      throw new HttpException('Request body is required', HttpStatus.BAD_REQUEST);
    }
    return this.service.createConnector(orgId, dto, resolveActor(actorHeader));
  }

  @Get()
  public async listConnectors(@Headers('x-org-id') orgHeader?: string) {
    return this.service.listConnectors(requireOrg(orgHeader));
  }

  @Get('twins')
  public async listAllTwins(@Headers('x-org-id') orgHeader?: string) {
    return this.service.listTwins(requireOrg(orgHeader));
  }

  @Get(':id')
  public async getConnector(@Param('id') id: string, @Headers('x-org-id') orgHeader?: string) {
    return this.service.getConnector(requireOrg(orgHeader), id);
  }

  @Post(':id/test')
  public async testConnection(@Param('id') id: string, @Headers('x-org-id') orgHeader?: string) {
    return this.service.testConnection(requireOrg(orgHeader), id);
  }

  @Post(':id/discover')
  public async discoverSchema(
    @Param('id') id: string,
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
  ) {
    return this.service.discoverSchema(requireOrg(orgHeader), id, resolveActor(actorHeader));
  }

  @Post(':id/activate')
  public async activate(
    @Param('id') id: string,
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
  ) {
    return this.service.activate(requireOrg(orgHeader), id, resolveActor(actorHeader));
  }

  @Post(':id/pause')
  public async pause(
    @Param('id') id: string,
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
  ) {
    return this.service.pause(requireOrg(orgHeader), id, resolveActor(actorHeader));
  }

  @Post(':id/write-back')
  public async configureWriteBack(
    @Param('id') id: string,
    @Body() body: { state?: boolean },
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
  ) {
    return this.service.configureWriteBack(requireOrg(orgHeader), id, body || {}, resolveActor(actorHeader));
  }

  @Post(':id/projection')
  public async configureProjection(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
  ) {
    return this.service.configureProjection(requireOrg(orgHeader), id, body || {}, resolveActor(actorHeader));
  }

  @Post(':id/sync')
  public async syncConnector(
    @Param('id') id: string,
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
  ) {
    return this.service.syncConnector(requireOrg(orgHeader), id, resolveActor(actorHeader));
  }

  @Get(':id/health')
  public async health(@Param('id') id: string, @Headers('x-org-id') orgHeader?: string) {
    return this.service.getHealth(requireOrg(orgHeader), id);
  }

  @Get(':id/twins')
  public async listTwins(@Param('id') id: string, @Headers('x-org-id') orgHeader?: string) {
    return this.service.listTwins(requireOrg(orgHeader), id);
  }

  @Get(':id/work-orders')
  public async workOrders(@Param('id') id: string, @Headers('x-org-id') orgHeader?: string) {
    return this.service.listWorkOrders(requireOrg(orgHeader), id);
  }

  @Get(':id/twin-dlq')
  public async twinDeadLetters(@Param('id') id: string, @Headers('x-org-id') orgHeader?: string) {
    return this.service.listTwinDeadLetters(requireOrg(orgHeader), id);
  }

  @Get(':id/twin-dlq/:entryId')
  public async twinDeadLetter(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Headers('x-org-id') orgHeader?: string,
  ) {
    return this.service.getTwinDeadLetter(requireOrg(orgHeader), id, entryId);
  }

  @Post(':id/twin-dlq/:entryId/reinject')
  public async reinjectTwinDeadLetter(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Body() body: { payload?: Record<string, unknown> },
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
  ) {
    return this.service.reinjectTwinDeadLetter(
      requireOrg(orgHeader),
      id,
      entryId,
      body?.payload,
      resolveActor(actorHeader),
    );
  }
}
