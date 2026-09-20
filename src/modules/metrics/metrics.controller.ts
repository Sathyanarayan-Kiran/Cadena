import { Controller, Get, Headers, HttpException, HttpStatus, Query } from '@nestjs/common';
import { EventStoreService } from '../events/event-store.service';
import { MetricsService } from './metrics.service';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) {
    throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  }
  return orgId.trim();
}

function parseDate(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpException(
      { statusCode: 422, error: 'invalid_range', message: `${field} must be an ISO 8601 date` },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return parsed.toISOString();
}

@Controller('metrics')
export class MetricsController {
  private readonly metrics = new MetricsService();

  @Get('flow')
  async getFlowMetrics(
    @Headers('x-org-id') orgId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const tenant = requireOrg(orgId);
    const fromISO = parseDate(from, 'from');
    const toISO = parseDate(to, 'to');
    if (fromISO && toISO && fromISO > toISO) {
      throw new HttpException(
        { statusCode: 422, error: 'invalid_range', message: 'from must be earlier than to' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return this.metrics.getFlowMetrics(tenant, fromISO, toISO);
  }
}

@Controller('events')
export class EventStoreController {
  private readonly store = new EventStoreService();

  @Get()
  async listEvents(
    @Headers('x-org-id') orgId?: string,
    @Query('event_type') eventType?: string,
    @Query('work_item_id') workItemId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.store.query({
      org_id: requireOrg(orgId),
      event_type: eventType,
      work_item_id: workItemId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
      limit: limit ? Number(limit) : undefined,
    });
  }
}
