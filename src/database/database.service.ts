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

    this.initialized = true;
  }
}
