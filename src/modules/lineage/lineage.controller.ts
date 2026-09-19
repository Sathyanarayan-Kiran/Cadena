import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Headers,
} from '@nestjs/common';
import { InvalidEdgeTypeError, LineageService } from './lineage.service';
import { CreateLinkDto } from './lineage.types';

@Controller('workitems')
export class LineageController {
  private service = new LineageService();

  @Post(':id/links')
  async createLink(
    @Param('id') sourceId: string,
    @Body() dto: CreateLinkDto,
    @Headers('x-actor-id') actorId?: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    try {
      return await this.service.createLink(
        sourceId,
        dto.target_id,
        dto.link_type,
        actorId || 'user-1',
        headerOrgId || '00000000-0000-0000-0000-000000000099',
      );
    } catch (err: any) {
      if (err instanceof InvalidEdgeTypeError) {
        throw new HttpException(
          {
            statusCode: 422,
            error: 'invalid_edge_type',
            message: err.message,
            allowed_edge_types: err.allowedEdgeTypes,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw new HttpException(err.message || 'Failed to create link', HttpStatus.BAD_REQUEST);
    }
  }

  @Get(':id/links')
  async getLinks(
    @Param('id') id: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    return this.service.getItemRelationships(
      id,
      headerOrgId || '00000000-0000-0000-0000-000000000099',
    );
  }

  @Get(':id/relationships')
  async getRelationships(
    @Param('id') id: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    return this.service.getItemRelationships(
      id,
      headerOrgId || '00000000-0000-0000-0000-000000000099',
    );
  }

  @Get(':id/lineage')
  async getLineage(
    @Param('id') id: string,
    @Query('direction') direction?: 'up' | 'down',
    @Query('depth') depth?: string,
    @Query('edge_types') edgeTypes?: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    const d = depth ? parseInt(depth, 10) : undefined;
    const edges = edgeTypes ? edgeTypes.split(',').map((e) => e.trim()) : undefined;

    return this.service.getLineage({
      workItemId: id,
      orgId: headerOrgId || '00000000-0000-0000-0000-000000000099',
      direction: direction || 'up',
      depth: d,
      edgeTypes: edges,
    });
  }
}
