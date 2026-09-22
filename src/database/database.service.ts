import { PGlite } from '@electric-sql/pglite';
import { appendAuditIntegrityEntry, AuditEventSource } from '../modules/audit/audit-integrity';
import {
  DatabaseAdapter,
  ManagedPostgresDatabaseAdapter,
  PGliteDatabaseAdapter,
} from './database-adapter';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { vector } = require('@electric-sql/pglite/vector');

/**
 * Directory PGlite persists to, from `CADENA_DATA_DIR`.
 *
 * Absent or empty means in-memory, and that is deliberately the default: a test run or a
 * throwaway script must never inherit a durable database by accident. `npm run dev` and
 * `npm start` opt in explicitly, so persistence is something you choose rather than
 * something that happens to you.
 */
function resolveDataDir(): string | undefined {
  const configured = process.env.CADENA_DATA_DIR?.trim();
  return configured ? configured : undefined;
}

function resolveDatabaseUrl(): string | undefined {
  const configured = process.env.DATABASE_URL?.trim();
  return configured ? configured : undefined;
}

export type DatabaseBackend = 'pglite-memory' | 'pglite-directory' | 'managed-postgres';

export class DatabaseService {
  private static instance: DatabaseService;
  public db: DatabaseAdapter;
  /** The directory this instance persists to, or null when it is in-memory. */
  public readonly dataDir: string | null;
  public readonly backend: DatabaseBackend;
  private initialized = false;

  private constructor(dataDir?: string, databaseUrl?: string) {
    this.dataDir = dataDir ?? null;
    if (databaseUrl) {
      this.backend = 'managed-postgres';
      this.db = new ManagedPostgresDatabaseAdapter(databaseUrl);
    } else {
      this.backend = dataDir ? 'pglite-directory' : 'pglite-memory';
      const client = dataDir
        ? new PGlite(dataDir, { extensions: { vector } })
        : new PGlite({ extensions: { vector } });
      this.db = new PGliteDatabaseAdapter(client);
    }
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService(resolveDataDir(), resolveDatabaseUrl());
    }
    return DatabaseService.instance;
  }

  /**
   * A standalone instance that bypasses the process singleton. Used by the persistence
   * tests to open, close and reopen a directory without disturbing anything else.
   */
  public static createIsolated(dataDir?: string): DatabaseService {
    return new DatabaseService(dataDir);
  }

  public isPersistent(): boolean {
    return this.backend !== 'pglite-memory';
  }

  public isManagedPostgres(): boolean {
    return this.backend === 'managed-postgres';
  }

  public async checkReady(): Promise<void> {
    await this.initialize();
    await this.db.query('SELECT 1 AS ready');
  }

  /** Releases the underlying connection. Reopening the same directory recovers the data. */
  public async close(): Promise<void> {
    await this.db.close();
    this.initialized = false;
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
        business_unit TEXT NOT NULL DEFAULT 'Unassigned',
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
        sla_elapsed_minutes NUMERIC NOT NULL DEFAULT 0,
        sla_clock_started_at TIMESTAMP WITH TIME ZONE,
        sla_suspended BOOLEAN NOT NULL DEFAULT FALSE,
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

      CREATE TABLE IF NOT EXISTS lineage_exports (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        root_work_item_id UUID NOT NULL REFERENCES work_items(id),
        created_by TEXT NOT NULL,
        report JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id UUID PRIMARY KEY,
        event_type TEXT NOT NULL,
        work_item_id UUID NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'user',
        actor_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_integrity_entries (
        sequence BIGSERIAL PRIMARY KEY,
        org_id UUID NOT NULL,
        source TEXT NOT NULL,
        event_id UUID NOT NULL,
        work_item_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        canonical_event JSONB NOT NULL,
        proof_version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source, event_id)
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

      CREATE TABLE IF NOT EXISTS integration_correlation_nodes (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        system TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        immutable_id TEXT NOT NULL,
        display_key TEXT,
        url TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, system, entity_type, immutable_id),
        UNIQUE(org_id, id)
      );

      CREATE TABLE IF NOT EXISTS integration_correlation_links (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        source_node_id UUID NOT NULL,
        target_node_id UUID NOT NULL,
        relationship TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, source_node_id, target_node_id, relationship),
        FOREIGN KEY (org_id, source_node_id)
          REFERENCES integration_correlation_nodes(org_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (org_id, target_node_id)
          REFERENCES integration_correlation_nodes(org_id, id) ON DELETE RESTRICT,
        CHECK (source_node_id <> target_node_id)
      );

      CREATE TABLE IF NOT EXISTS integration_sync_snapshots (
        org_id UUID NOT NULL,
        node_id UUID NOT NULL,
        payload_hash TEXT NOT NULL,
        canonical_payload JSONB NOT NULL,
        observed_actor_id TEXT NOT NULL,
        observation_source TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (org_id, node_id),
        FOREIGN KEY (org_id, node_id)
          REFERENCES integration_correlation_nodes(org_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS integration_state_mapping_definitions (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        name TEXT NOT NULL,
        source_system TEXT NOT NULL,
        source_entity_type TEXT NOT NULL,
        target_system TEXT NOT NULL,
        target_entity_type TEXT NOT NULL,
        version INT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
        definition JSONB NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_by TEXT,
        published_at TIMESTAMP WITH TIME ZONE,
        UNIQUE(org_id, source_system, source_entity_type, target_system, target_entity_type, version),
        UNIQUE(org_id, id),
        CHECK (source_system <> target_system OR source_entity_type <> target_entity_type)
      );

      CREATE TABLE IF NOT EXISTS integration_state_sync_transactions (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        mapping_definition_id UUID,
        mapping_version INT,
        source_node_id UUID NOT NULL,
        target_node_id UUID NOT NULL,
        direction TEXT CHECK (direction IN ('source_to_target', 'target_to_source')),
        source_state TEXT NOT NULL,
        target_state_before TEXT,
        mapped_target_state TEXT,
        required_target_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
        provided_target_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL CHECK (status IN ('ready', 'held')),
        reason TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (org_id, mapping_definition_id)
          REFERENCES integration_state_mapping_definitions(org_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (org_id, source_node_id)
          REFERENCES integration_correlation_nodes(org_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (org_id, target_node_id)
          REFERENCES integration_correlation_nodes(org_id, id) ON DELETE RESTRICT,
        CHECK (source_node_id <> target_node_id)
      );

      CREATE TABLE IF NOT EXISTS integration_deliveries (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        provider TEXT NOT NULL,
        integration_kind TEXT NOT NULL DEFAULT 'git',
        delivery_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        payload JSONB NOT NULL,
        result JSONB,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        claimed_at TIMESTAMP WITH TIME ZONE,
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

      CREATE TABLE IF NOT EXISTS domain_events (
        event_id UUID PRIMARY KEY,
        org_id UUID,
        event_type TEXT NOT NULL,
        schema_version INT NOT NULL DEFAULT 1,
        work_item_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_outbox (
        event_id UUID PRIMARY KEY REFERENCES domain_events(event_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMP WITH TIME ZONE,
        dispatched_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS event_consumptions (
        consumer TEXT NOT NULL,
        event_id UUID NOT NULL,
        status TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 1,
        first_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (consumer, event_id)
      );

      CREATE TABLE IF NOT EXISTS dead_letter_events (
        id UUID PRIMARY KEY,
        consumer TEXT NOT NULL,
        event_id UUID NOT NULL,
        org_id UUID,
        event_type TEXT NOT NULL,
        envelope JSONB NOT NULL,
        attempts INT NOT NULL,
        last_error TEXT,
        status TEXT NOT NULL DEFAULT 'dead',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP WITH TIME ZONE,
        UNIQUE (consumer, event_id)
      );

      CREATE TABLE IF NOT EXISTS sla_emissions (
        work_item_id UUID NOT NULL,
        state TEXT NOT NULL,
        entered_state_at TIMESTAMP WITH TIME ZONE NOT NULL,
        kind TEXT NOT NULL,
        emitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (work_item_id, state, entered_state_at, kind)
      );

      CREATE TABLE IF NOT EXISTS api_credentials (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        actor_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        roles TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP WITH TIME ZONE,
        revoked_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS sla_policies (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL REFERENCES orgs(id),
        item_type TEXT NOT NULL,
        state TEXT NOT NULL,
        threshold_minutes INT NOT NULL,
        calendar TEXT NOT NULL,
        suspend_sla BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_id, item_type, state)
      );

      CREATE TABLE IF NOT EXISTS integration_connectors (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unconfigured',
        config TEXT NOT NULL DEFAULT '{}',
        discovery_metadata TEXT DEFAULT '{}',
        last_synced_at TIMESTAMP WITH TIME ZONE,
        last_success_at TIMESTAMP WITH TIME ZONE,
        sync_lag_seconds INT NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (org_id, provider, name)
      );

      CREATE TABLE IF NOT EXISTS integration_connector_cursors (
        id UUID PRIMARY KEY,
        connector_id UUID NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        cursor_value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (connector_id, entity_type)
      );

      CREATE TABLE IF NOT EXISTS integration_canonical_twins (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        connector_id UUID NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        native_key TEXT,
        native_url TEXT,
        sync_state TEXT NOT NULL DEFAULT 'synced',
        field_authority TEXT DEFAULT '{}',
        payload TEXT NOT NULL DEFAULT '{}',
        correlation_node_id UUID REFERENCES integration_correlation_nodes(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (org_id, provider, artifact_type, external_id)
      );

      CREATE SEQUENCE IF NOT EXISTS integration_twin_queue_position_seq;

      CREATE TABLE IF NOT EXISTS integration_connector_work_orders (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        transaction_id UUID NOT NULL UNIQUE,
        source_connector_id UUID REFERENCES integration_connectors(id) ON DELETE SET NULL,
        target_connector_id UUID NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
        target_twin_id UUID NOT NULL REFERENCES integration_canonical_twins(id) ON DELETE CASCADE,
        target_entity_type TEXT NOT NULL,
        target_external_id TEXT NOT NULL,
        target_state TEXT NOT NULL,
        fields TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TIMESTAMP WITH TIME ZONE,
        executed_at TIMESTAMP WITH TIME ZONE,
        source_event_id UUID,
        source_payload TEXT NOT NULL DEFAULT '{}',
        queue_position BIGINT NOT NULL DEFAULT nextval('integration_twin_queue_position_seq'),
        attempt_history TEXT NOT NULL DEFAULT '[]',
        claimed_by TEXT,
        claim_expires_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS integration_connector_ingestion_queue (
        id UUID PRIMARY KEY,
        org_id UUID NOT NULL,
        connector_id UUID NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
        twin_id UUID REFERENCES integration_canonical_twins(id) ON DELETE SET NULL,
        partition_key TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        queue_position BIGINT NOT NULL DEFAULT nextval('integration_twin_queue_position_seq'),
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        attempt_history TEXT NOT NULL DEFAULT '[]',
        claimed_by TEXT,
        claim_expires_at TIMESTAMP WITH TIME ZONE,
        last_error TEXT,
        next_attempt_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (connector_id, dedupe_key)
      );

      CREATE TABLE IF NOT EXISTS integration_connector_sync_leases (
        connector_id UUID PRIMARY KEY REFERENCES integration_connectors(id) ON DELETE CASCADE,
        org_id UUID NOT NULL,
        lease_owner TEXT NOT NULL,
        acquired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS integration_connector_propagations (
        source_event_id UUID PRIMARY KEY REFERENCES domain_events(event_id) ON DELETE CASCADE,
        org_id UUID NOT NULL,
        source_twin_id UUID NOT NULL,
        status TEXT NOT NULL,
        echoes_suppressed INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Safe migration for pilot databases created before stable work-item keys existed.
    await this.db.exec(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS item_key TEXT;`);
    await this.db.exec(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS business_unit TEXT NOT NULL DEFAULT 'Unassigned';`);
    await this.db.exec(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS sla_elapsed_minutes NUMERIC NOT NULL DEFAULT 0;`);
    await this.db.exec(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS sla_clock_started_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS sla_suspended BOOLEAN NOT NULL DEFAULT FALSE;`);
    await this.db.exec(`ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS suspend_sla BOOLEAN NOT NULL DEFAULT FALSE;`);
    await this.db.exec(`ALTER TABLE integration_deliveries ADD COLUMN IF NOT EXISTS integration_kind TEXT NOT NULL DEFAULT 'git';`);
    await this.db.exec(`ALTER TABLE integration_deliveries ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;`);
    await this.db.exec(`ALTER TABLE integration_deliveries ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'user';`);
    await this.db.exec(`ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;`);
    await this.db.exec(`ALTER TABLE integration_canonical_twins ADD COLUMN IF NOT EXISTS title TEXT;`);
    await this.db.exec(`ALTER TABLE integration_canonical_twins ADD COLUMN IF NOT EXISTS native_status TEXT;`);
    await this.db.exec(`ALTER TABLE integration_canonical_twins ADD COLUMN IF NOT EXISTS content_hash TEXT;`);
    await this.db.exec(`ALTER TABLE integration_canonical_twins ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ALTER COLUMN transaction_id DROP NOT NULL;`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'state_translation';`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS requested_by TEXT;`);
    await this.db.exec(`CREATE SEQUENCE IF NOT EXISTS integration_twin_queue_position_seq;`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS source_event_id UUID;`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS source_payload TEXT NOT NULL DEFAULT '{}';`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS queue_position BIGINT DEFAULT nextval('integration_twin_queue_position_seq');`);
    await this.db.exec(`UPDATE integration_connector_work_orders SET queue_position = nextval('integration_twin_queue_position_seq') WHERE queue_position IS NULL;`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ALTER COLUMN queue_position SET NOT NULL;`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS attempt_history TEXT NOT NULL DEFAULT '[]';`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS claimed_by TEXT;`);
    await this.db.exec(`ALTER TABLE integration_connector_work_orders ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`ALTER TABLE integration_connector_ingestion_queue ADD COLUMN IF NOT EXISTS claimed_by TEXT;`);
    await this.db.exec(`ALTER TABLE integration_connector_ingestion_queue ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMP WITH TIME ZONE;`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS integration_connector_work_orders_twin ON integration_connector_work_orders (org_id, target_twin_id, status);`);
    await this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS integration_connector_work_orders_event_twin ON integration_connector_work_orders (source_event_id, target_twin_id) WHERE source_event_id IS NOT NULL;`);
    await this.db.exec(`
      UPDATE audit_events SET actor_type = 'integration'
      WHERE actor_type = 'user'
        AND (actor_id LIKE 'integration:%' OR actor_id LIKE 'monitoring:%');
    `);
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS domain_events_org_time ON domain_events (org_id, occurred_at);
      CREATE INDEX IF NOT EXISTS domain_events_work_item_time ON domain_events (work_item_id, occurred_at);
      CREATE INDEX IF NOT EXISTS domain_events_type_time ON domain_events (event_type, occurred_at);
      CREATE INDEX IF NOT EXISTS event_outbox_pending ON event_outbox (status, created_at);
      CREATE INDEX IF NOT EXISTS integration_deliveries_queue ON integration_deliveries (status, created_at);
      CREATE INDEX IF NOT EXISTS dlq_consumer_status ON dead_letter_events (consumer, status);
      CREATE INDEX IF NOT EXISTS api_credentials_hash ON api_credentials (token_hash);
      CREATE INDEX IF NOT EXISTS lineage_exports_root_time
        ON lineage_exports (org_id, root_work_item_id, created_at);
      CREATE INDEX IF NOT EXISTS audit_integrity_org_sequence
        ON audit_integrity_entries (org_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS audit_integrity_hash_unique
        ON audit_integrity_entries (org_id, event_hash);
      CREATE INDEX IF NOT EXISTS integration_correlation_nodes_lookup
        ON integration_correlation_nodes (org_id, system, entity_type, immutable_id);
      CREATE INDEX IF NOT EXISTS integration_correlation_links_source
        ON integration_correlation_links (org_id, source_node_id);
      CREATE INDEX IF NOT EXISTS integration_correlation_links_target
        ON integration_correlation_links (org_id, target_node_id);
      CREATE INDEX IF NOT EXISTS integration_sync_snapshots_hash
        ON integration_sync_snapshots (org_id, node_id, payload_hash);
      CREATE INDEX IF NOT EXISTS integration_state_mappings_lookup
        ON integration_state_mapping_definitions
        (org_id, source_system, source_entity_type, target_system, target_entity_type, status, version);
      CREATE INDEX IF NOT EXISTS integration_state_sync_transactions_time
        ON integration_state_sync_transactions (org_id, created_at);
      CREATE INDEX IF NOT EXISTS integration_state_sync_transactions_nodes
        ON integration_state_sync_transactions (org_id, source_node_id, target_node_id, created_at);
      CREATE INDEX IF NOT EXISTS integration_canonical_twins_node
        ON integration_canonical_twins (org_id, correlation_node_id);
      CREATE INDEX IF NOT EXISTS integration_connector_work_orders_queue
        ON integration_connector_work_orders (org_id, target_connector_id, status, next_attempt_at, queue_position);
      CREATE INDEX IF NOT EXISTS integration_connector_work_orders_partition
        ON integration_connector_work_orders (org_id, target_twin_id, queue_position, status);
      CREATE INDEX IF NOT EXISTS integration_connector_ingestion_queue_due
        ON integration_connector_ingestion_queue
        (org_id, connector_id, status, next_attempt_at, queue_position);
      CREATE INDEX IF NOT EXISTS integration_connector_ingestion_partition
        ON integration_connector_ingestion_queue (org_id, partition_key, queue_position, status);
      CREATE INDEX IF NOT EXISTS integration_connector_sync_leases_expiry
        ON integration_connector_sync_leases (expires_at);
    `);
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

    // Existing pilot databases pre-date US10.7. Bring their immutable rows into the chain
    // once, in deterministic timestamp/id order; subsequent writes append transactionally.
    await this.backfillAuditIntegrity();

    this.initialized = true;
  }

  private async backfillAuditIntegrity(): Promise<void> {
    const result = await this.db.query<any>(
      `SELECT 'domain_events' AS source, event.event_id, event.org_id,
              event.work_item_id, event.event_type, event.actor_type, event.actor_id,
              event.payload, event.occurred_at
       FROM domain_events event
       WHERE event.org_id IS NOT NULL
       UNION ALL
       SELECT 'audit_events' AS source, audit.id AS event_id, item.org_id,
              audit.work_item_id::text, audit.event_type,
              audit.actor_type,
              audit.actor_id, audit.payload, audit.timestamp AS occurred_at
       FROM audit_events audit
       JOIN work_items item ON item.id = audit.work_item_id
       ORDER BY occurred_at ASC, event_id ASC`,
    );
    for (const row of result.rows || []) {
      await appendAuditIntegrityEntry(this.db, {
        source: row.source as AuditEventSource,
        event_id: row.event_id,
        org_id: row.org_id,
        work_item_id: row.work_item_id || null,
        event_type: row.event_type,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}),
        occurred_at: typeof row.occurred_at === 'string'
          ? new Date(row.occurred_at).toISOString()
          : new Date(row.occurred_at).toISOString(),
      });
    }
  }
}
