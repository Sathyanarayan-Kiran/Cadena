import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseService } from './database/database.service';
import { WorkItemService } from './modules/work-items/work-item.service';
import { WorkflowService } from './modules/workflow/workflow.service';
import { LineageService } from './modules/lineage/lineage.service';
import { PILOT_ORG_ID, PILOT_TEAM_ID, seedPilotConfiguration } from './bootstrap/pilot-configuration';
import { AuthService } from './modules/auth/auth.service';
import { randomUUID } from 'crypto';
import { loadRuntimeConfig } from './config/runtime-config';
import { requestLoggingMiddleware } from './observability/request-logging';

async function bootstrap() {
  const runtime = loadRuntimeConfig();
  const database = DatabaseService.getInstance();
  await database.initialize();
  if (database.isManagedPostgres()) {
    console.log('💾 Datastore connected to managed PostgreSQL.');
  } else if (database.isPersistent()) {
    console.log(`💾 Datastore persisting to ${database.dataDir}`);
  } else {
    console.warn('⚠️  Datastore is in-memory; all data is discarded on exit. Set CADENA_DATA_DIR to persist.');
  }
  if (AuthService.devHeadersAllowed()) {
    console.warn(
      '⚠️  Header-based identity is ENABLED: any caller can claim any tenant via x-org-id. '
      + 'Development only. Unset CADENA_ALLOW_HEADER_AUTH to require bearer tokens.',
    );
  } else {
    console.log('🔒 Bearer token required; header-based identity is disabled.');
    if (!AuthService.bootstrapToken()) {
      console.warn(
        '⚠️  No CADENA_BOOTSTRAP_TOKEN is set, so the first credential cannot be issued. '
        + 'Set one to bootstrap tenant access.',
      );
    }
  }

  if (runtime.seedDemoData) {
    // Seed demo data only when explicitly enabled (the default in local mode).
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
      `INSERT INTO teams (id, org_id, name, business_unit)
       VALUES ($1, $2, 'Platform Team', 'Engineering') ON CONFLICT DO NOTHING`,
      [teamId, orgId],
    );

    const defaultPolicies = [
      { type: 'story', state: 'In Progress', minutes: 960, calendar: '5x8', suspend: false },
      { type: 'story', state: 'In Review', minutes: 960, calendar: '5x8', suspend: false },
      { type: 'story', state: 'Blocked', minutes: 960, calendar: '5x8', suspend: true },
      { type: 'incident', state: 'Triaged', minutes: 120, calendar: '24x7', suspend: false },
      { type: 'incident', state: 'Investigating', minutes: 60, calendar: '24x7', suspend: false },
    ];
    for (const policy of defaultPolicies) {
      await db.query(
        `INSERT INTO sla_policies (id, org_id, item_type, state, threshold_minutes, calendar, suspend_sla)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, item_type, state) DO NOTHING`,
        [randomUUID(), orgId, policy.type, policy.state, policy.minutes, policy.calendar, policy.suspend],
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
  } else {
    console.log('Demo data seeding is disabled for this runtime.');
  }

  const app = await NestFactory.create(AppModule);
  app.use(requestLoggingMiddleware);
  if (runtime.trustProxy !== false) {
    app.getHttpAdapter().getInstance().set('trust proxy', runtime.trustProxy);
  }
  if (runtime.mode === 'local') app.enableCors();
  else if (runtime.corsOrigins.length > 0) app.enableCors({ origin: runtime.corsOrigins });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
    try {
      await app.close();
      await database.close();
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error', event: 'shutdown_failed', signal,
        message: error instanceof Error ? error.message : 'unknown shutdown error',
      }));
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(runtime.port, '0.0.0.0');
  console.log(JSON.stringify({
    level: 'info', event: 'server_started', service: runtime.serviceName,
    mode: runtime.mode, port: runtime.port, build_sha: runtime.buildSha,
    database_backend: database.backend,
  }));
}

bootstrap().catch((error) => {
  console.error(JSON.stringify({
    level: 'error', event: 'startup_failed',
    message: error instanceof Error ? error.message : 'unknown startup error',
  }));
  process.exitCode = 1;
});
