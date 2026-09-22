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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  InvalidEdgeTypeError,
  LineageExportNotFoundError,
  LineageService,
  LineageWorkItemNotFoundError,
} from './lineage.service';
import { CreateLinkDto } from './lineage.types';

const MAX_LINEAGE_GRAPH_DEPTH = 10;

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

  @Get(':id/lineage-graph')
  async getLineageGraph(
    @Param('id') id: string,
    @Query('depth') requestedDepth?: string,
    @Headers('x-org-id') headerOrgId?: string,
  ) {
    const depth = requestedDepth === undefined ? 3 : Number(requestedDepth);
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_LINEAGE_GRAPH_DEPTH) {
      throw new HttpException(
        {
          statusCode: 422,
          error: 'invalid_lineage_depth',
          message: `depth must be an integer from 1 to ${MAX_LINEAGE_GRAPH_DEPTH}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      return await this.service.getLineageGraph(
        id,
        headerOrgId || '00000000-0000-0000-0000-000000000099',
        depth,
      );
    } catch (err: any) {
      if (err instanceof LineageWorkItemNotFoundError) {
        throw new HttpException(err.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(err.message || 'Failed to load lineage graph', HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':id/lineage-exports')
  async createLineageExport(
    @Param('id') id: string,
    @Headers('x-org-id') headerOrgId?: string,
    @Headers('x-actor-id') actorId?: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const orgId = headerOrgId || '00000000-0000-0000-0000-000000000099';
    try {
      const report = await this.service.createLineageExport(id, orgId, actorId || 'user-1');
      response?.setHeader('Location', report.download_url);
      return report;
    } catch (err: any) {
      if (err instanceof LineageWorkItemNotFoundError) {
        throw new HttpException(err.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(err.message || 'Failed to export lineage', HttpStatus.BAD_REQUEST);
    }
  }

  @Get(':id/lineage-exports/:exportId')
  async downloadLineageExport(
    @Param('id') id: string,
    @Param('exportId') exportId: string,
    @Headers('x-org-id') headerOrgId?: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const orgId = headerOrgId || '00000000-0000-0000-0000-000000000099';
    try {
      const report = await this.service.getLineageExport(id, exportId, orgId);
      const safeKey = report.root_key.replace(/[^A-Za-z0-9_-]/g, '-');
      response?.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeKey}-lineage-${report.export_id}.json"`,
      );
      response?.setHeader('Cache-Control', 'private, immutable');
      return report;
    } catch (err: any) {
      if (err instanceof LineageExportNotFoundError) {
        throw new HttpException(err.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(err.message || 'Failed to download lineage export', HttpStatus.BAD_REQUEST);
    }
  }
}
