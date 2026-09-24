import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Put, Query } from '@nestjs/common';
import { CostOfDelayService, CostVersionNotFoundError, InvalidCostAssumptionError } from './cost-of-delay.service';
import { FlowNotFoundError, InvalidFlowRangeError } from './flow.service';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

function parseVersion(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpException({ statusCode: 422, error: 'invalid_request', message: 'version must be a whole number of 1 or more' }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return version;
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FlowNotFoundError || error instanceof CostVersionNotFoundError) throw new HttpException((error as Error).message, HttpStatus.NOT_FOUND);
    if (error instanceof InvalidCostAssumptionError || error instanceof InvalidFlowRangeError) {
      throw new HttpException({ statusCode: 422, error: 'invalid_request', message: (error as Error).message }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    throw error;
  }
}

@Controller()
export class CostOfDelayController {
  constructor(@Inject(CostOfDelayService) private readonly cost: CostOfDelayService) {}

  /** The current assumption set (or `?version=N`); `version: null` and no rules when none has been saved. */
  @Get('metrics/cost-assumptions')
  async assumptions(@Headers('x-org-id') orgId?: string, @Query('version') version?: string) {
    return guard(async () => (await this.cost.getSet(requireOrg(orgId), parseVersion(version)))
      ?? { version: null, currency: null, note: null, rules: [], message: 'No cost assumptions are configured.' });
  }

  @Get('metrics/cost-assumptions/history')
  async history(@Headers('x-org-id') orgId?: string) {
    return this.cost.history(requireOrg(orgId));
  }

  /** Body: `{ currency?, note?, assumptions: [{ team_id?, item_type?, priority?, service_id?, rate_per_day, fixed_value_at_risk?, label? }] }`. */
  @Put('metrics/cost-assumptions')
  async setAssumptions(
    @Body() body: { currency?: unknown; note?: unknown; assumptions?: unknown },
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    return guard(() => this.cost.setAssumptions(requireOrg(orgId), actorId || 'flow-admin', body || {}));
  }

  @Get('metrics/cost-of-delay')
  async report(
    @Headers('x-org-id') orgId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('team_id') teamId?: string,
    @Query('item_type') itemType?: string,
    @Query('version') version?: string,
  ) {
    return guard(() => this.cost.report(requireOrg(orgId), { from, to }, { teamId: teamId || undefined, itemType: itemType || undefined }, parseVersion(version)));
  }

  @Get('metrics/cost-of-delay/open-items')
  async openItems(@Headers('x-org-id') orgId?: string, @Query('version') version?: string) {
    return guard(() => this.cost.openItems(requireOrg(orgId), parseVersion(version)));
  }

  @Get('workitems/:id/cost-of-delay')
  async item(
    @Param('id') id: string,
    @Headers('x-org-id') orgId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('version') version?: string,
  ) {
    return guard(() => this.cost.itemCost(requireOrg(orgId), id, { from, to }, parseVersion(version)));
  }
}
