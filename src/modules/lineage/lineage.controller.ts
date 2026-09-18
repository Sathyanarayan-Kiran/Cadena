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
  ) {
    try {
      return await this.service.createLink(sourceId, dto.target_id, dto.link_type, actorId || 'user-1');
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
  async getLinks(@Param('id') id: string) {
    return this.service.getItemRelationships(id);
  }

  @Get(':id/relationships')
  async getRelationships(@Param('id') id: string) {
    return this.service.getItemRelationships(id);
  }

  @Get(':id/lineage')
  async getLineage(
    @Param('id') id: string,
    @Query('direction') direction?: 'up' | 'down',
    @Query('depth') depth?: string,
    @Query('edge_types') edgeTypes?: string,
  ) {
    const d = depth ? parseInt(depth, 10) : undefined;
    const edges = edgeTypes ? edgeTypes.split(',').map((e) => e.trim()) : undefined;

    return this.service.getLineage({
      workItemId: id,
      direction: direction || 'up',
      depth: d,
      edgeTypes: edges,
    });
  }
}
