import { ConnectorConfigurationError } from '../connector-http';
import { ConnectorFieldSchema, ConnectorProviderType, ConnectorRecord } from '../connector.types';

/**
 * Which fields of one connector entity a scheduled query may filter on (US16.2).
 *
 * A condition on an unindexed column makes the target's database scan the table while it holds a
 * query semaphore, so a query that names one is refused at configuration time. The catalog comes
 * from three sources, and each lookup says which one vouched for the field:
 *
 * - `discovered`: the provider reported the field as indexed. Jira's `/rest/api/3/field` marks
 *   every field its search index covers as `searchable`; a non-searchable field has no index.
 * - `platform`: columns the provider always indexes. ServiceNow indexes `sys_id`, `number`,
 *   `sys_class_name`, the audit timestamps and every reference column. The Table API does not
 *   expose an instance's other database indexes, so no other ServiceNow column is assumed indexed.
 * - `declared`: an operator has confirmed an instance-specific index (for example one a
 *   ServiceNow administrator added) through the connector's audited `queryIndexes` setting.
 */
export type QueryIndexSource = 'discovered' | 'platform' | 'declared';

export interface QueryIndexLookup {
  /** The provider field id the reference resolved to. */
  field: string;
  indexed: boolean;
  source?: QueryIndexSource;
  /** Why a known field does not qualify, when that is more specific than "not indexed". */
  reason?: string;
}

export interface QueryIndexCatalog {
  provider: ConnectorProviderType;
  entityType: string;
  /** Null when the catalog cannot vouch for any field, with the reason. */
  unavailable: string | null;
  /** Resolves a field reference as it appears in the query text; null when the field is unknown. */
  lookup(reference: string): QueryIndexLookup | null;
  /** Indexed field ids, for hints. */
  indexedFields(): string[];
}

/** Clauses that are not fields but are served from Jira's search index. */
const JQL_INDEXED_PSEUDO_CLAUSES = new Set(['text', 'filter', 'savedfilter', 'request', 'searchrequest']);
const SERVICENOW_PLATFORM_INDEXED = new Set(['sys_id', 'number', 'sys_class_name', 'sys_created_on', 'sys_updated_on']);
const MAX_DECLARED_PER_ENTITY = 50;
const DECLARED_FIELD = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/i;

/** Validates the operator-declared index list: `{ [entityType]: fieldIds[] }`. */
export function validateQueryIndexes(input: unknown): Record<string, string[]> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConnectorConfigurationError('queryIndexes must be an object mapping an entity type to indexed field ids');
  }
  const result: Record<string, string[]> = {};
  for (const [entityType, fields] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[a-z_][a-z0-9_]{0,79}$/i.test(entityType)) {
      throw new ConnectorConfigurationError(`queryIndexes has an invalid entity type '${entityType.slice(0, 80)}'`);
    }
    if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string' || !DECLARED_FIELD.test(field.trim()))) {
      throw new ConnectorConfigurationError(`queryIndexes.${entityType} must be a list of field ids such as "u_region" or "caller_id.department"`);
    }
    const unique = Array.from(new Set((fields as string[]).map((field) => field.trim())));
    if (unique.length > MAX_DECLARED_PER_ENTITY) {
      throw new ConnectorConfigurationError(`queryIndexes.${entityType} may declare at most ${MAX_DECLARED_PER_ENTITY} fields`);
    }
    if (unique.length) result[entityType] = unique.sort();
  }
  return result;
}

function declaredFor(connector: ConnectorRecord, entityType: string): Set<string> {
  let declared: Record<string, string[]> = {};
  try {
    declared = validateQueryIndexes(connector.config.queryIndexes);
  } catch {
    // An invalid stored declaration vouches for nothing; it cannot widen what a query may use.
  }
  return new Set((declared[entityType] || []).map((field) => field.toLowerCase()));
}

export function buildQueryIndexCatalog(connector: ConnectorRecord, entityType: string): QueryIndexCatalog {
  const entity = connector.discoveryMetadata?.entities?.find((candidate) => candidate.entityType === entityType);
  const fields = entity?.fields || [];
  const declared = declaredFor(connector, entityType);
  const base = { provider: connector.provider, entityType };

  if (!entity) {
    return {
      ...base,
      unavailable: `No discovered schema for ${entityType}; discover the connector before configuring a query on it.`,
      lookup: () => null,
      indexedFields: () => [],
    };
  }
  if (connector.provider === 'jira') return jiraCatalog(base, fields, declared);
  return serviceNowCatalog(base, fields, declared);
}

function jiraCatalog(
  base: Pick<QueryIndexCatalog, 'provider' | 'entityType'>,
  fields: ConnectorFieldSchema[],
  declared: Set<string>,
): QueryIndexCatalog {
  // Discovery before US16.2 did not record searchability; it cannot vouch for any field.
  const known = fields.some((field) => typeof field.indexed === 'boolean');
  const byReference = new Map<string, ConnectorFieldSchema>();
  for (const field of fields) {
    const references = [field.id, field.name, ...(field.clauseNames || [])];
    const custom = /^customfield_(\d+)$/.exec(field.id);
    if (custom) references.push(`cf[${custom[1]}]`);
    for (const reference of references) {
      const key = reference.toLowerCase();
      // System clause names win over a custom field that reuses the same display name.
      if (!byReference.has(key) || !field.custom) byReference.set(key, field);
    }
  }
  return {
    ...base,
    unavailable: known ? null : 'The discovered Jira schema predates index checks; run discovery again so field searchability is recorded.',
    lookup(reference) {
      const key = reference.toLowerCase();
      if (JQL_INDEXED_PSEUDO_CLAUSES.has(key)) return { field: key, indexed: true, source: 'platform' };
      const field = byReference.get(key);
      if (!field) return declared.has(key) ? { field: reference, indexed: true, source: 'declared' } : null;
      if (field.indexed) return { field: field.id, indexed: true, source: 'discovered' };
      if (declared.has(field.id.toLowerCase())) return { field: field.id, indexed: true, source: 'declared' };
      return { field: field.id, indexed: false, reason: 'Jira reports it as not searchable' };
    },
    indexedFields: () => fields.filter((field) => field.indexed).map((field) => field.id),
  };
}

function serviceNowCatalog(
  base: Pick<QueryIndexCatalog, 'provider' | 'entityType'>,
  fields: ConnectorFieldSchema[],
  declared: Set<string>,
): QueryIndexCatalog {
  const byId = new Map(fields.map((field) => [field.id.toLowerCase(), field]));
  const platformIndexed = (field: ConnectorFieldSchema | undefined, id: string) =>
    SERVICENOW_PLATFORM_INDEXED.has(id) || field?.reference === true;
  return {
    ...base,
    unavailable: null,
    lookup(reference) {
      const key = reference.toLowerCase();
      if (declared.has(key)) return { field: key, indexed: true, source: 'declared' };
      if (key.includes('.')) {
        // A dot-walk joins the referenced table and filters on its column, which the parent
        // table's reference index cannot serve.
        const head = byId.get(key.split('.')[0]);
        if (!head) return null;
        return { field: key, indexed: false, reason: 'a dot-walked condition filters the joined table on a column this table cannot index' };
      }
      const field = byId.get(key);
      if (platformIndexed(field, key)) return { field: key, indexed: true, source: 'platform' };
      if (!field) return null;
      return { field: field.id, indexed: false, reason: 'it is neither a reference column nor a platform-indexed column' };
    },
    indexedFields: () => Array.from(new Set([
      ...SERVICENOW_PLATFORM_INDEXED,
      ...fields.filter((field) => field.reference).map((field) => field.id),
      ...declared,
    ])).sort(),
  };
}
