import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { workspaceConfig } from './workspace-config';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

/**
 * Connector-led management workspace (US20.2): source health, synchronized twins, and governed
 * edits of externally owned fields.
 */
@Controller('workspace')
export class WorkspaceController {
  constructor(@Inject(ConnectorService) private readonly connectors: ConnectorService) {}

  @Get('config')
  config() {
    return workspaceConfig();
  }

  @Get('overview')
  async overview(@Headers('x-org-id') orgId?: string) {
    return { ...workspaceConfig(), ...(await this.connectors.getWorkspaceOverview(requireOrg(orgId))) };
  }

  @Get('twins')
  async twins(@Headers('x-org-id') orgId?: string) {
    return this.connectors.listTwinWorkspace(requireOrg(orgId));
  }

  @Get('twins/:id')
  async twin(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    return this.connectors.getTwinDetail(requireOrg(orgId), id);
  }

  @Post('twins/:id/edits')
  async edit(
    @Param('id') id: string,
    @Body() body: { field?: unknown; value?: unknown },
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    return this.connectors.routeTwinEdit(requireOrg(orgId), id, body || {}, actorId?.trim() || 'workspace-operator');
  }
}
