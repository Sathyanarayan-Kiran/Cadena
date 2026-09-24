import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Put, Query } from '@nestjs/common';
import { FlowClassificationService, InvalidClassificationError } from './flow-classification.service';
import { FlowNotFoundError, FlowService, InvalidFlowRangeError } from './flow.service';

function requireOrg(orgId?: string): string {
  if (!orgId?.trim()) throw new HttpException('x-org-id header is required', HttpStatus.BAD_REQUEST);
  return orgId.trim();
}

/** Maps domain errors to the same 404/422 shape the other metrics endpoints use. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FlowNotFoundError) throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    if (error instanceof InvalidClassificationError || error instanceof InvalidFlowRangeError) {
      throw new HttpException({ statusCode: 422, error: 'invalid_request', message: error.message }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    throw error;
  }
}

@Controller()
export class FlowController {
  constructor(
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(FlowClassificationService) private readonly classifications: FlowClassificationService,
  ) {}

  /** Current classification for the org default (no `team_id`), or for one team's overrides. */
  @Get('metrics/flow-classifications')
  async list(@Headers('x-org-id') orgId?: string, @Query('team_id') teamId?: string) {
    return guard(() => this.classifications.list(requireOrg(orgId), teamId || null));
  }

  @Get('metrics/flow-classifications/history')
  async history(@Headers('x-org-id') orgId?: string, @Query('team_id') teamId?: string, @Query('state') state?: string) {
    return guard(() => this.classifications.history(requireOrg(orgId), { teamId: teamId || undefined, state: state || undefined }));
  }

  /** Body: `{ team_id?: string | null, states: [{ state, classification }] }`. Omitting `team_id` sets the org default. */
  @Put('metrics/flow-classifications')
  async set(
    @Body() body: { team_id?: string | null; states?: Array<{ state?: unknown; classification?: unknown }> },
    @Headers('x-org-id') orgId?: string,
    @Headers('x-actor-id') actorId?: string,
  ) {
    return guard(() => this.classifications.set(requireOrg(orgId), actorId || 'flow-admin', body?.team_id ?? null, body?.states as any));
  }

  @Get('metrics/flow-efficiency')
  async report(
    @Headers('x-org-id') orgId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('team_id') teamId?: string,
    @Query('item_type') itemType?: string,
  ) {
    return guard(() => this.flow.report(requireOrg(orgId), { from, to }, { teamId: teamId || undefined, itemType: itemType || undefined }));
  }

  @Get('workitems/:id/flow-profile')
  async profile(
    @Param('id') id: string,
    @Headers('x-org-id') orgId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return guard(() => this.flow.profile(requireOrg(orgId), id, { from, to }));
  }
}
