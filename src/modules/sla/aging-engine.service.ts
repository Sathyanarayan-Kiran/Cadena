import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { SlaCalculatorService, SlaCalendar } from './sla-calculator.service';
import { InProcessEventBus } from '../events/event-bus';

export interface SlaPolicyRow {
  id: string;
  org_id: string;
  item_type: string;
  state: string;
  threshold_minutes: number;
  calendar: SlaCalendar;
}

export interface RecomputeSummary {
  processedCount: number;
  updatedCount: number;
  warningCount: number;
  breachCount: number;
  escalationCount: number;
}

@Injectable()
export class AgingEngineService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private dbService: DatabaseService;
  private eventBus: InProcessEventBus;

  // Cache to track emitted events per work_item state entry to avoid duplicate event spamming
  private emittedWarnings: Set<string> = new Set();
  private emittedBreaches: Set<string> = new Set();
  private emittedEscalations: Set<string> = new Set();

  constructor(private readonly slaCalculator: SlaCalculatorService) {
    this.dbService = DatabaseService.getInstance();
    this.eventBus = InProcessEventBus.getInstance();
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      this.recomputeAllActiveItems().catch((err) => {
        console.error('AgingEngine background tick failed:', err);
      });
    }, 60000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Recomputes aging score & aging bucket for all work items in an org (or all orgs).
   */
  public async recomputeAgingForOrg(orgId?: string, targetNow?: Date): Promise<RecomputeSummary> {
    const now = targetNow || new Date();

    let policiesQuery = `SELECT * FROM sla_policies;`;
    const policiesParams: any[] = [];
    if (orgId) {
      policiesQuery = `SELECT * FROM sla_policies WHERE org_id = $1;`;
      policiesParams.push(orgId);
    }
    const policiesRes = await this.dbService.db.query(policiesQuery, policiesParams);
    const policies: SlaPolicyRow[] = policiesRes.rows as any[];

    const policyMap = new Map<string, SlaPolicyRow>();
    for (const p of policies) {
      policyMap.set(`${p.org_id}:${p.item_type}:${p.state}`, p);
    }

    let itemsQuery = `SELECT * FROM work_items;`;
    const itemsParams: any[] = [];
    if (orgId) {
      itemsQuery = `SELECT * FROM work_items WHERE org_id = $1;`;
      itemsParams.push(orgId);
    }
    const itemsRes = await this.dbService.db.query(itemsQuery, itemsParams);
    const items = itemsRes.rows as any[];

    let processedCount = 0;
    let updatedCount = 0;
    let warningCount = 0;
    let breachCount = 0;
    let escalationCount = 0;

    // US8.2: escalation fires past a configurable multiple of the threshold, default 150%.
    const escalationThresholds = new Map<string, number>();
    const settingsRes = await this.dbService.db.query<any>(
      orgId
        ? `SELECT org_id, escalation_threshold_percent FROM notification_settings WHERE org_id = $1;`
        : `SELECT org_id, escalation_threshold_percent FROM notification_settings;`,
      orgId ? [orgId] : [],
    );
    for (const row of settingsRes.rows || []) {
      escalationThresholds.set(row.org_id, Number(row.escalation_threshold_percent));
    }

    for (const item of items) {
      processedCount++;
      const enteredAt = new Date(item.entered_state_at || item.created_at);
      const policyKey = `${item.org_id}:${item.type}:${item.status}`;
      const policy = policyMap.get(policyKey);

      let newScore = 0;
      let newBucket: 'green' | 'amber' | 'red' = 'green';

      if (policy) {
        const res = this.slaCalculator.computeAging(
          enteredAt,
          now,
          policy.threshold_minutes,
          policy.calendar,
        );
        newScore = res.agingScore;
        newBucket = res.agingBucket;
      } else {
        newScore = 0;
        newBucket = 'green';
      }

      const stateEntryKey = `${item.id}:${item.status}:${enteredAt.toISOString()}`;

      if (newScore >= 75 && !this.emittedWarnings.has(stateEntryKey)) {
        this.emittedWarnings.add(stateEntryKey);
        warningCount++;
        await this.eventBus.publish(
          'SLAWarning',
          item.id,
          { type: 'system', id: 'aging-engine' },
          {
            work_item_id: item.id,
            type: item.type,
            status: item.status,
            aging_score: newScore,
            threshold_minutes: policy?.threshold_minutes || 0,
            owner_id: item.owner_id,
            team_id: item.team_id,
            org_id: item.org_id,
            recipients: [item.owner_id].filter(Boolean),
          },
        );
      }

      if (newScore > 100 && !this.emittedBreaches.has(stateEntryKey)) {
        this.emittedBreaches.add(stateEntryKey);
        breachCount++;

        let teamLeadId: string | null = null;
        if (item.team_id) {
          const leadRes = await this.dbService.db.query<{ id: string }>(
            `SELECT id FROM people WHERE team_id = $1 AND role = 'team_lead' LIMIT 1;`,
            [item.team_id],
          );
          if (leadRes.rows.length > 0) {
            teamLeadId = leadRes.rows[0].id;
          }
        }

        const recipients = Array.from(new Set([item.owner_id, teamLeadId].filter(Boolean)));

        await this.eventBus.publish(
          'SLABreached',
          item.id,
          { type: 'system', id: 'aging-engine' },
          {
            work_item_id: item.id,
            type: item.type,
            status: item.status,
            aging_score: newScore,
            threshold_minutes: policy?.threshold_minutes || 0,
            owner_id: item.owner_id,
            team_lead_id: teamLeadId,
            team_id: item.team_id,
            org_id: item.org_id,
            recipients,
          },
        );
      }

      const escalationPercent = escalationThresholds.get(item.org_id) ?? 150;
      if (policy && newScore >= escalationPercent && !this.emittedEscalations.has(stateEntryKey)) {
        this.emittedEscalations.add(stateEntryKey);
        escalationCount++;

        const escalationTargetRes = await this.dbService.db.query<{ escalation_person_id: string | null }>(
          `SELECT escalation_person_id FROM team_escalation_targets WHERE team_id = $1 AND org_id = $2;`,
          [item.team_id, item.org_id],
        );

        await this.eventBus.publish(
          'SLAEscalated',
          item.id,
          { type: 'system', id: 'aging-engine' },
          {
            work_item_id: item.id,
            type: item.type,
            status: item.status,
            aging_score: newScore,
            escalation_threshold_percent: escalationPercent,
            threshold_minutes: policy.threshold_minutes,
            owner_id: item.owner_id,
            team_id: item.team_id,
            org_id: item.org_id,
            escalation_person_id: escalationTargetRes.rows?.[0]?.escalation_person_id || null,
          },
        );
      }

      if (item.aging_bucket !== newBucket || Number(item.aging_score) !== newScore) {
        await this.dbService.db.query(
          `UPDATE work_items SET aging_bucket = $1, aging_score = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3;`,
          [newBucket, newScore, item.id],
        );
        updatedCount++;
      }
    }

    return {
      processedCount,
      updatedCount,
      warningCount,
      breachCount,
      escalationCount,
    };
  }

  public async recomputeAllActiveItems(targetNow?: Date): Promise<RecomputeSummary> {
    return this.recomputeAgingForOrg(undefined, targetNow);
  }
}
