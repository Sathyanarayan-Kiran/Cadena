import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { FlowRiskService, InvalidRiskSettingsError } from './flow-risk.service';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

@Controller()
export class FlowRiskController {
  constructor(@Inject(FlowRiskService) private readonly risk: FlowRiskService) {}

  @Get('metrics/flow-risk/settings')
  async settings(@Headers('x-org-id') orgId?: string) {
    return this.risk.getSettings(requireOrg(orgId));
  }

  /** Body: any of `{ min_sample, percentile_threshold, lookback_days }`. Each change is audited. */
  @Put('metrics/flow-risk/settings')
  async updateSettings(@Body() body: Record<string, unknown>, @Headers('x-org-id') orgId?: string, @Headers('x-actor-id') actorId?: string) {
    try {
      return await this.risk.updateSettings(requireOrg(orgId), actorId || 'flow-admin', body || {});
    } catch (error) {
      if (error instanceof InvalidRiskSettingsError) {
        throw new HttpException({ statusCode: 422, error: 'invalid_request', message: error.message }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      throw error;
    }
  }

  /** Evaluates now: persists each waiting item's risk and notifies once per threshold crossing. */
  @Post('metrics/flow-risk/evaluate')
  async evaluate(@Headers('x-org-id') orgId?: string) {
    return this.risk.evaluateOrg(requireOrg(orgId));
  }

  /** The latest evaluation of items currently waiting; `at_risk=true` keeps only those past the threshold. */
  @Get('metrics/flow-risk')
  async list(@Headers('x-org-id') orgId?: string, @Query('at_risk') atRisk?: string, @Query('team_id') teamId?: string) {
    return this.risk.listCurrent(requireOrg(orgId), { atRisk: atRisk === 'true', teamId: teamId || undefined });
  }

  @Get('workitems/:id/flow-risk')
  async item(@Param('id') id: string, @Headers('x-org-id') orgId?: string) {
    const result = await this.risk.assessItem(requireOrg(orgId), id);
    if (!result) throw new HttpException(`Work item '${id}' not found`, HttpStatus.NOT_FOUND);
    return result;
  }
}
