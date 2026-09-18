import { Controller, Get, Post, Body, Headers, Query } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AgingEngineService } from './aging-engine.service';
import { SlaCalendar } from './sla-calculator.service';
import { randomUUID } from 'crypto';

@Controller()
export class SlaController {
  private dbService: DatabaseService;

  constructor(private readonly agingEngine: AgingEngineService) {
    this.dbService = DatabaseService.getInstance();
  }

  @Get('sla-policies')
  async getPolicies(
    @Headers('x-org-id') headerOrgId?: string,
    @Query('org_id') queryOrgId?: string,
  ) {
    const orgId = headerOrgId || queryOrgId || '00000000-0000-0000-0000-000000000099';
    const res = await this.dbService.db.query(
      `SELECT * FROM sla_policies WHERE org_id = $1 ORDER BY item_type, state;`,
      [orgId],
    );
    return res.rows;
  }

  @Post('sla-policies')
  async createOrUpdatePolicy(
    @Headers('x-org-id') headerOrgId: string,
    @Body()
    body: {
      org_id?: string;
      item_type: string;
      state: string;
      threshold_minutes: number;
      calendar: SlaCalendar;
    },
  ) {
    const orgId = body.org_id || headerOrgId || '00000000-0000-0000-0000-000000000099';
    const id = randomUUID();

    await this.dbService.db.query(
      `INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, item_type, state)
       DO UPDATE SET threshold_minutes = EXCLUDED.threshold_minutes, calendar = EXCLUDED.calendar;`,
      [id, orgId, body.item_type, body.state, body.threshold_minutes, body.calendar],
    );

    const res = await this.dbService.db.query(
      `SELECT * FROM sla_policies WHERE org_id = $1 AND item_type = $2 AND state = $3;`,
      [orgId, body.item_type, body.state],
    );

    return res.rows[0];
  }

  @Post('aging/recompute')
  async triggerRecompute(
    @Headers('x-org-id') headerOrgId?: string,
    @Query('org_id') queryOrgId?: string,
  ) {
    const orgId = headerOrgId || queryOrgId || '00000000-0000-0000-0000-000000000099';
    const summary = await this.agingEngine.recomputeAgingForOrg(orgId);
    return {
      success: true,
      timestamp: new Date().toISOString(),
      summary,
    };
  }
}
