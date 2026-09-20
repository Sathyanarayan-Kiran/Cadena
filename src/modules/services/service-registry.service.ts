import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { InProcessEventBus } from '../events/event-bus';
import {
  InvalidServiceError,
  RegisterServiceDto,
  SERVICE_LINK_TYPE,
  ServiceLinkSummary,
  ServiceRecord,
  ServiceSource,
} from './service-registry.types';

const VALID_SOURCES: ServiceSource[] = ['internal', 'monitoring_discovery', 'cmdb'];

@Injectable()
export class ServiceRegistryService {
  private dbService = DatabaseService.getInstance();
  private eventBus = InProcessEventBus.getInstance();

  public async registerService(orgId: string, dto: RegisterServiceDto): Promise<ServiceRecord> {
    await this.dbService.initialize();

    const name = dto.name?.trim();
    if (!name) throw new InvalidServiceError('name is required');
    if (dto.source && !VALID_SOURCES.includes(dto.source)) {
      throw new InvalidServiceError(`source must be one of: ${VALID_SOURCES.join(', ')}`);
    }

    const serviceKey = this.normalizeKey(dto.service_key?.trim() || name);
    if (!serviceKey) {
      throw new InvalidServiceError('service_key could not be derived; supply an explicit service_key');
    }

    const aliases = this.normalizeAliases([...(dto.aliases || []), name, serviceKey]);
    const existing = await this.findByKey(orgId, serviceKey);

    if (existing) {
      // Re-registering merges aliases and fills gaps rather than discarding curated ownership data.
      const mergedAliases = this.normalizeAliases([...existing.aliases, ...aliases]);
      const result = await this.dbService.db.query<any>(
        `UPDATE services
         SET name = $1,
             description = $2,
             owner_team_id = COALESCE($3, owner_team_id),
             environment = COALESCE($4, environment),
             source = $5,
             external_ref = COALESCE($6, external_ref),
             aliases = $7,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $8
         RETURNING *`,
        [
          name,
          dto.description ?? existing.description,
          dto.owner_team_id ?? null,
          dto.environment ?? null,
          dto.source || existing.source,
          dto.external_ref ?? null,
          mergedAliases,
          existing.id,
        ],
      );
      return this.mapService(result.rows[0]);
    }

    const result = await this.dbService.db.query<any>(
      `INSERT INTO services
       (id, org_id, service_key, name, description, owner_team_id, environment, source, external_ref, aliases, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        randomUUID(),
        orgId,
        serviceKey,
        name,
        dto.description || '',
        dto.owner_team_id || null,
        dto.environment || null,
        dto.source || 'internal',
        dto.external_ref || null,
        aliases,
      ],
    );

    const service = this.mapService(result.rows[0]);
    await this.eventBus.publish(
      'ServiceRegistered',
      service.id,
      { type: 'system', id: 'service-registry' },
      { org_id: orgId, service },
    );
    return service;
  }

  public async listServices(orgId: string): Promise<ServiceRecord[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM services WHERE org_id = $1 ORDER BY name ASC`,
      [orgId],
    );
    return result.rows.map((row) => this.mapService(row));
  }

  public async getServiceById(orgId: string, serviceId: string): Promise<ServiceRecord | null> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM services WHERE org_id = $1 AND id = $2`,
      [orgId, serviceId],
    );
    return result.rows.length > 0 ? this.mapService(result.rows[0]) : null;
  }

  /**
   * Resolves an inbound monitoring identifier (service name, host, or CMDB reference) to a
   * registered Service. Matching is case-insensitive across the service key, display name,
   * external reference, and recorded aliases, because a provider may label the same service
   * differently on each monitor.
   */
  public async resolveService(
    orgId: string,
    candidates: Array<string | undefined | null>,
  ): Promise<ServiceRecord | null> {
    await this.dbService.initialize();
    for (const candidate of candidates) {
      const value = candidate?.trim();
      if (!value) continue;
      const result = await this.dbService.db.query<any>(
        `SELECT * FROM services
         WHERE org_id = $1
           AND (UPPER(service_key) = UPPER($2)
                OR UPPER(name) = UPPER($2)
                OR UPPER(COALESCE(external_ref, '')) = UPPER($2)
                OR EXISTS (
                  SELECT 1 FROM unnest(aliases) AS alias WHERE UPPER(alias) = UPPER($2)
                ))
         LIMIT 1`,
        [orgId, value],
      );
      if (result.rows.length > 0) return this.mapService(result.rows[0]);
    }
    return null;
  }

  public async linkWorkItemToService(
    orgId: string,
    workItemId: string,
    serviceId: string,
    actorId = 'system',
  ): Promise<ServiceLinkSummary> {
    await this.dbService.initialize();

    const item = await this.dbService.db.query<any>(
      `SELECT id, item_key FROM work_items WHERE id = $1 AND org_id = $2`,
      [workItemId, orgId],
    );
    if (item.rows.length === 0) {
      throw new InvalidServiceError(`Work item '${workItemId}' not found in this tenant`);
    }

    const service = await this.getServiceById(orgId, serviceId);
    if (!service) {
      throw new InvalidServiceError(`Service '${serviceId}' not found in this tenant`);
    }

    const result = await this.dbService.db.query<any>(
      `INSERT INTO work_item_service_links
       (id, org_id, work_item_id, service_id, link_type, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (work_item_id, service_id, link_type) DO NOTHING
       RETURNING created_at`,
      [randomUUID(), orgId, workItemId, serviceId, SERVICE_LINK_TYPE],
    );

    if (result.rows.length > 0) {
      await this.eventBus.publish(
        'ServiceLinkCreated',
        workItemId,
        { type: 'system', id: actorId },
        {
          org_id: orgId,
          work_item_key: item.rows[0].item_key,
          service_key: service.service_key,
          link_type: SERVICE_LINK_TYPE,
        },
      );
      return { service, link_type: SERVICE_LINK_TYPE, linked_at: this.toIso(result.rows[0].created_at) };
    }

    const existing = await this.dbService.db.query<any>(
      `SELECT created_at FROM work_item_service_links
       WHERE work_item_id = $1 AND service_id = $2 AND link_type = $3`,
      [workItemId, serviceId, SERVICE_LINK_TYPE],
    );
    return { service, link_type: SERVICE_LINK_TYPE, linked_at: this.toIso(existing.rows[0].created_at) };
  }

  public async listServicesForWorkItem(orgId: string, workItemId: string): Promise<ServiceLinkSummary[]> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT service.*, link.created_at AS linked_at
       FROM work_item_service_links link
       JOIN services service ON service.id = link.service_id
       WHERE link.work_item_id = $1 AND link.org_id = $2 AND service.org_id = $2
       ORDER BY link.created_at ASC`,
      [workItemId, orgId],
    );
    return result.rows.map((row) => ({
      service: this.mapService(row),
      link_type: SERVICE_LINK_TYPE,
      linked_at: this.toIso(row.linked_at),
    }));
  }

  public async listWorkItemsForService(orgId: string, serviceId: string): Promise<Array<{
    id: string;
    key: string;
    type: string;
    title: string;
    status: string;
    severity: string | null;
    link_type: typeof SERVICE_LINK_TYPE;
    linked_at: string;
  }>> {
    await this.dbService.initialize();
    const result = await this.dbService.db.query<any>(
      `SELECT item.id, item.item_key, item.type, item.title, item.status, item.severity,
              link.created_at AS linked_at
       FROM work_item_service_links link
       JOIN work_items item ON item.id = link.work_item_id
       WHERE link.service_id = $1 AND link.org_id = $2 AND item.org_id = $2
       ORDER BY link.created_at DESC`,
      [serviceId, orgId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      key: row.item_key,
      type: row.type,
      title: row.title,
      status: row.status,
      severity: row.severity,
      link_type: SERVICE_LINK_TYPE,
      linked_at: this.toIso(row.linked_at),
    }));
  }

  private async findByKey(orgId: string, serviceKey: string): Promise<ServiceRecord | null> {
    const result = await this.dbService.db.query<any>(
      `SELECT * FROM services WHERE org_id = $1 AND service_key = $2`,
      [orgId, serviceKey],
    );
    return result.rows.length > 0 ? this.mapService(result.rows[0]) : null;
  }

  private normalizeKey(value: string): string {
    const slug = value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) return '';
    return slug.startsWith('SVC-') ? slug : `SVC-${slug}`;
  }

  private normalizeAliases(values: string[]): string[] {
    const seen = new Map<string, string>();
    for (const value of values) {
      const trimmed = value?.trim();
      if (!trimmed) continue;
      const dedupeKey = trimmed.toUpperCase();
      if (!seen.has(dedupeKey)) seen.set(dedupeKey, trimmed);
    }
    return Array.from(seen.values());
  }

  private mapService(row: any): ServiceRecord {
    return {
      id: row.id,
      org_id: row.org_id,
      service_key: row.service_key,
      name: row.name,
      description: row.description || '',
      owner_team_id: row.owner_team_id,
      environment: row.environment,
      source: row.source as ServiceSource,
      external_ref: row.external_ref,
      aliases: row.aliases || [],
      created_at: this.toIso(row.created_at),
      updated_at: this.toIso(row.updated_at),
    };
  }

  private toIso(value: any): string {
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}
