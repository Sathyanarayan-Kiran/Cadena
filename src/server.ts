import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseService } from './database/database.service';
import { WorkItemService } from './modules/work-items/work-item.service';
import { WorkflowService } from './modules/workflow/workflow.service';
import { LineageService } from './modules/lineage/lineage.service';
import { PILOT_ORG_ID, PILOT_TEAM_ID, seedPilotConfiguration } from './bootstrap/pilot-configuration';
import { randomUUID } from 'crypto';

async function bootstrap() {
  const database = DatabaseService.getInstance();
  await database.initialize();
  console.log(
    database.isPersistent()
      ? `💾 Datastore persisting to ${database.dataDir}`
      : '⚠️  Datastore is in-memory; all data is discarded on exit. Set CADENA_DATA_DIR to persist.',
  );

  // Seed demo data if database is empty
  const itemService = new WorkItemService();
  const workflowService = new WorkflowService();
  const lineageService = new LineageService();

  const orgId = PILOT_ORG_ID;
  const teamId = PILOT_TEAM_ID;

  const db = DatabaseService.getInstance().db;
  await db.query(
    `INSERT INTO orgs (id, name) VALUES ($1, 'Primary Pilot Org') ON CONFLICT DO NOTHING`,
    [orgId],
  );
  await db.query(
    `INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Platform Team') ON CONFLICT DO NOTHING`,
    [teamId, orgId],
  );

  const defaultPolicies = [
    { type: 'story', state: 'In Review', minutes: 960, calendar: '5x8' },
    { type: 'incident', state: 'Triaged', minutes: 120, calendar: '24x7' },
    { type: 'incident', state: 'Investigating', minutes: 60, calendar: '24x7' },
  ];
  for (const policy of defaultPolicies) {
    await db.query(
      `INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, item_type, state) DO NOTHING`,
      [randomUUID(), orgId, policy.type, policy.state, policy.minutes, policy.calendar],
    );
  }

  await seedPilotConfiguration(orgId, teamId);

  const existingItems = await itemService.listWorkItems({}, orgId);
  if (existingItems.length === 0) {
    console.log('🌱 Seeding initial pilot demo data...');

    // Publish custom Workflow for Incident
    await workflowService.publishWorkflow({
      type: 'incident',
      states: ['Triaged', 'Investigating', 'Mitigated', 'Resolved', 'Closed'],
      initial_state: 'Triaged',
      terminal_states: ['Closed'],
      transitions: [
        { from: 'Triaged', to: 'Investigating' },
        { from: 'Investigating', to: 'Mitigated', requires_fields: ['mitigation_summary'] },
        { from: 'Mitigated', to: 'Resolved', guard: 'incident_commander' },
        { from: 'Resolved', to: 'Closed' },
      ],
    });

    // 1. Create Epic
    const epic = await itemService.createWorkItem({
      type: 'epic',
      title: 'Epic: Unified Platform Core Kernel',
      description: 'Canonical WorkItem schema and workflow state engine',
      priority: 'P0',
      team_id: teamId,
      org_id: orgId,
    });

    // 2. Create Story
    const story = await itemService.createWorkItem({
      type: 'story',
      title: 'Story: State Machine Transition Engine',
      description: 'Guarded transition validation and required field checks',
      priority: 'P1',
      team_id: teamId,
      org_id: orgId,
      custom_fields: { story_points: 8, sprint: 'Sprint 1' },
    });
    await lineageService.createLink(story.id, epic.id, 'child_of', 'system', orgId);

    // 3. Create Bug Fix Story
    const bugFix = await itemService.createWorkItem({
      type: 'story',
      title: 'Bug Fix: UUID Schema Parser Sanitization',
      description: 'Fix actor_id UUID constraint in audit event log',
      priority: 'P1',
      team_id: teamId,
      org_id: orgId,
      custom_fields: { story_points: 2, sprint: 'Sprint 1' },
    });
    await lineageService.createLink(bugFix.id, story.id, 'child_of', 'system', orgId);

    // 4. Create Incident
    const incident = await itemService.createWorkItem({
      type: 'incident',
      title: 'Incident: DB Connection Timeout in EU-West-1',
      description: 'High latency alert triggered on primary postgres replica',
      priority: 'P0',
      severity: 'SEV1',
      team_id: teamId,
      org_id: orgId,
      custom_fields: { alert_source: 'Datadog' },
    });
    await lineageService.createLink(incident.id, bugFix.id, 'fixed_by', 'system', orgId);

    console.log('✅ Demo seed data created successfully!');
  }

  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 Cadena Platform API & UI active at http://localhost:${port}`);
}

bootstrap();
