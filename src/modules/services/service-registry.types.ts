/**
 * Service/Asset is a Spec §3.3 *supporting entity*, not a canonical WorkItem.
 *
 * The pilot therefore stores it in its own tenant-scoped `services` table and joins it
 * to WorkItems through `work_item_service_links` (Spec §3.2 `affects` edge). Modelling a
 * Service as a WorkItem would place infrastructure inventory on the delivery board and
 * give it a delivery workflow, neither of which the specification intends.
 *
 * `source` records where the record came from so Epic 11 CMDB federation can reconcile
 * pilot-discovered entries against an authoritative external CMDB without guessing.
 */
export type ServiceSource = 'internal' | 'monitoring_discovery' | 'cmdb';

export const SERVICE_LINK_TYPE = 'affects' as const;

export interface ServiceRecord {
  id: string;
  org_id: string;
  service_key: string;
  name: string;
  description: string;
  owner_team_id: string | null;
  environment: string | null;
  source: ServiceSource;
  external_ref: string | null;
  aliases: string[];
  created_at: string;
  updated_at: string;
}

export interface RegisterServiceDto {
  name: string;
  service_key?: string;
  description?: string;
  owner_team_id?: string | null;
  environment?: string | null;
  source?: ServiceSource;
  external_ref?: string | null;
  aliases?: string[];
}

export interface ServiceLinkSummary {
  service: ServiceRecord;
  link_type: typeof SERVICE_LINK_TYPE;
  linked_at: string;
}

export class InvalidServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServiceError';
  }
}
