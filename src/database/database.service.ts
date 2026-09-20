import { PGlite } from '@electric-sql/pglite';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { vector } = require('@electric-sql/pglite/vector');

export class DatabaseService {
  private static instance: DatabaseService;
  public db: PGlite;
  private initialized = false;

  private constructor() {
    this.db = new PGlite({
      extensions: { vector },
    });
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
    } catch {
      // Extension loaded
    }

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL REFERENCES orgs(id),
        name TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS people (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL REFERENCES orgs(id),
        team_id UUID NOT NULL REFERENCES teams(id),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS workflow_definitions (
        id UUID PRIMARY KEY,
        type TEXT NOT NULL,
        version INT NOT NULL,
        definition JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS custom_field_schemas (
        id UUID PRIMARY KEY,
        type TEXT NOT NULL,
        version INT NOT NULL,
        schema JSONB NOT NULL,
        defaults JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id UUID PRIMARY KEY,
        item_key TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL,
        workflow_version INT DEFAULT 1,
        priority TEXT NOT NULL,
        severity TEXT,
        owner_id UUID,
        team_id UUID NOT NULL,
        org_id UUID NOT NULL,
        entered_state_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        aging_bucket TEXT DEFAULT 'green',
        aging_score NUMERIC DEFAULT 0,
        custom_fields JSONB DEFAULT '{}',
        tags TEXT[] DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS work_item_links (
        id UUID PRIMARY KEY,
        source_id UUID NOT NULL REFERENCES work_items(id),
        target_id UUID NOT NULL REFERENCES work_items(id),
        link_type TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id UUID PRIMARY KEY,
        event_type TEXT NOT NULL,
        work_item_id UUID NOT NULL,
        actor_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS external_artifacts (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        provider TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        status TEXT,
        payload JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, provider, artifact_type, external_id)
      );

      CREATE TABLE IF NOT EXISTS external_artifact_links (
        id UUID PRIMARY KEY,
        artifact_id UUID NOT NULL REFERENCES external_artifacts(id),
        work_item_id UUID NOT NULL REFERENCES work_items(id),
        link_type TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(artifact_id, work_item_id, link_type)
      );

      CREATE TABLE IF NOT EXISTS integration_deliveries (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        provider TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload JSONB NOT NULL,
        result JSONB,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(org_id, provider, delivery_id)
      );

      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        service_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_team_id UUID,
        environment TEXT,
        source TEXT NOT NULL DEFAULT 'internal',
        external_ref TEXT,
        aliases TEXT[] DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, service_key)
      );

      CREATE TABLE IF NOT EXISTS work_item_service_links (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        work_item_id UUID NOT NULL REFERENCES work_items(id),
        service_id UUID NOT NULL REFERENCES services(id),
        link_type TEXT NOT NULL DEFAULT 'affects',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(work_item_id, service_id, link_type)
      );

      CREATE TABLE IF NOT EXISTS monitoring_settings (
        org_id UUID PRIMARY KEY,
        min_severity TEXT NOT NULL DEFAULT 'SEV3',
        dedupe_window_minutes INT NOT NULL DEFAULT 60,
        default_team_id UUID,
        automation_actor_role TEXT NOT NULL DEFAULT 'on_call',
        auto_register_services BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notification_preferences (
        person_id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        channel TEXT NOT NULL DEFAULT 'email',
        address TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notification_settings (
        org_id UUID PRIMARY KEY,
        escalation_threshold_percent INT NOT NULL DEFAULT 150,
        unavailable_channels TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS team_escalation_targets (
        team_id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        escalation_person_id UUID,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        work_item_id UUID NOT NULL,
        work_item_key TEXT,
        recipient_id UUID NOT NULL,
        recipient_role TEXT NOT NULL,
        requested_channel TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        attempts JSONB NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(event_id, recipient_id)
      );

      CREATE TABLE IF NOT EXISTS sla_policies (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL REFERENCES orgs(id),
        item_type TEXT NOT NULL,
        state TEXT NOT NULL,
        threshold_minutes INT NOT NULL,
        calendar TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, item_type, state)
      );
    `);

    // Safe migration for pilot databases created before stable work-item keys existed.
    await this.db.exec(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS item_key TEXT;`);
    await this.db.exec(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`
      UPDATE work_items
      SET item_key = CASE
        WHEN type = 'epic' THEN 'EPIC-'
        WHEN type = 'incident' THEN 'INC-'
        WHEN type = 'release' THEN 'REL-'
        ELSE 'STORY-'
      END || UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 8))
      WHERE item_key IS NULL;
    `);
    await this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS work_items_org_key_unique
        ON work_items (org_id, item_key);
    `);

    this.initialized = true;
  }
}
