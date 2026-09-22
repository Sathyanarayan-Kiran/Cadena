import { Controller, Get, Headers, HttpException, HttpStatus, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService, AuditWorkItemNotFoundError } from './audit.service';

@Controller('audit')
export class AuditController {
  private service = new AuditService();

  @Get('workitems/:id')
  async getWorkItemTrail(
    @Param('id') id: string,
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    return this.load(id, orgId, actorId);
  }

  @Get('export')
  async exportWorkItemTrail(
    @Query('work_item_id') workItemId: string | undefined,
    @Headers('x-org-id') orgId: string | undefined,
    @Headers('x-actor-id') actorId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!workItemId) {
      throw new HttpException('work_item_id is required', HttpStatus.BAD_REQUEST);
    }
    const document = await this.load(workItemId, orgId, actorId);
    const safeKey = document.work_item.key.replace(/[^A-Za-z0-9_-]/g, '-');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${safeKey}-audit-trail.json"`);
    response.setHeader('Cache-Control', 'private, no-store');
    return document;
  }

  private async load(workItemId: string, orgId?: string, actorId?: string) {
    try {
      return await this.service.getTrail(
        workItemId,
        orgId || '00000000-0000-0000-0000-000000000099',
        actorId || 'user-1',
      );
    } catch (error) {
      if (error instanceof AuditWorkItemNotFoundError) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw error;
    }
  }
}
