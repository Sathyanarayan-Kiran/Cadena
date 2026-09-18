import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseService } from './database/database.service';
import { WorkItemService } from './modules/work-items/work-item.service';
import { WorkflowService } from './modules/workflow/workflow.service';
import { LineageService } from './modules/lineage/lineage.service';

async function bootstrap() {
  await DatabaseService.getInstance().initialize();

  // Seed demo data if database is empty
  const itemService = new WorkItemService();
  const workflowService = new WorkflowService();
  const lineageService = new LineageService();

  const orgId = '00000000-0000-0000-0000-000000000099';
  const teamId = '00000000-0000-0000-0000-000000000001';

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
      type: 'story',
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
    await lineageService.createLink(story.id, epic.id, 'child_of');

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
    await lineageService.createLink(bugFix.id, story.id, 'child_of');

    // 4. Create Incident
    const incident = await itemService.createWorkItem({
      type: 'incident',
      title: 'Incident: DB Connection Timeout in EU-West-1',
      description: 'High latency alert triggered on primary postgres replica',
      priority: 'P0',
      severity: 'SEV1',
      team_id: teamId,
      org_id: orgId,
      custom_fields: { aging_bucket: 'red', alert_source: 'Datadog' },
    });
    await lineageService.createLink(incident.id, bugFix.id, 'fixed_by');

    console.log('✅ Demo seed data created successfully!');
  }

  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 Cadena Platform API & UI active at http://localhost:${port}`);
}

bootstrap();
