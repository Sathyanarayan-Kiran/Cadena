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
  return actorId?.trim() || 'system';
}

@Controller('integrations/connectors')
export class ConnectorController {
  constructor(@Inject(ConnectorService) private readonly service: ConnectorService) {}

  @Post()
  public async createConnector(
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
    @Body() dto?: ConnectorConfigDto,
  ) {
    const orgId = requireOrg(orgHeader);
    const actorId = resolveActor(actorHeader);
    if (!dto) {
      throw new HttpException('Request body is required', HttpStatus.BAD_REQUEST);
    }
    return this.service.createConnector(orgId, dto, actorId);
  }

  @Get()
  public async listConnectors(@Headers('x-org-id') orgHeader?: string) {
    const orgId = requireOrg(orgHeader);
    return this.service.listConnectors(orgId);
  }

  @Get('twins')
  public async listAllTwins(@Headers('x-org-id') orgHeader?: string) {
    const orgId = requireOrg(orgHeader);
    return this.service.listTwins(orgId);
  }

  @Get(':id')
  public async getConnector(
    @Headers('x-org-id') orgHeader?: string,
    @Param('id') id?: string,
  ) {
    const orgId = requireOrg(orgHeader);
    if (!id) throw new HttpException('Connector id is required', HttpStatus.BAD_REQUEST);
    return this.service.getConnector(orgId, id);
  }

  @Post(':id/test')
  public async testConnection(
    @Headers('x-org-id') orgHeader?: string,
    @Param('id') id?: string,
  ) {
    const orgId = requireOrg(orgHeader);
    if (!id) throw new HttpException('Connector id is required', HttpStatus.BAD_REQUEST);
    return this.service.testConnection(orgId, id);
  }

  @Post(':id/discover')
  public async discoverSchema(
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
    @Param('id') id?: string,
  ) {
    const orgId = requireOrg(orgHeader);
    const actorId = resolveActor(actorHeader);
    if (!id) throw new HttpException('Connector id is required', HttpStatus.BAD_REQUEST);
    return this.service.discoverSchema(orgId, id, actorId);
  }

  @Post(':id/sync')
  public async syncConnector(
    @Headers('x-org-id') orgHeader?: string,
    @Headers('x-actor-id') actorHeader?: string,
    @Param('id') id?: string,
  ) {
    const orgId = requireOrg(orgHeader);
    const actorId = resolveActor(actorHeader);
    if (!id) throw new HttpException('Connector id is required', HttpStatus.BAD_REQUEST);
    return this.service.syncConnector(orgId, id, actorId);
  }

  @Get(':id/twins')
  public async listTwins(
    @Headers('x-org-id') orgHeader?: string,
    @Param('id') id?: string,
  ) {
    const orgId = requireOrg(orgHeader);
    if (!id) throw new HttpException('Connector id is required', HttpStatus.BAD_REQUEST);
    return this.service.listTwins(orgId, id);
  }
}
