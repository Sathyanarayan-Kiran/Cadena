import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

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

    // Enable vector extension if available
    try {
      await this.db.exec(`CREATE EXTENSION IF NOT EXISTS vector;`);
    } catch {
      // Ignore if extension already exists or handled by pglite plugin
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
        actor_id UUID NOT NULL,
        payload JSONB NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.initialized = true;
  }
}
