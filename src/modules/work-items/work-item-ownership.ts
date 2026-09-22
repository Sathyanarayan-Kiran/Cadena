/**
 * Twin-backed WorkItems are projections of records owned by Jira, ServiceNow or another
 * connected source. Cadena governs them (SLA, traceability, notifications, metrics) but never
 * becomes authoritative for their source fields: those change only when the source changes, or
 * through a governed connector write-back (`POST /workspace/twins/:twinId/edits`).
 */

/** Fields a local caller may change on a twin-backed item: Cadena-owned annotations only. */
export const CADENA_OWNED_PROJECTED_FIELDS = new Set(['tags']);

const PROVIDER_NAMES: Record<string, string> = { jira: 'Jira', servicenow: 'ServiceNow' };

export function sourceName(system: string | null | undefined): string {
  return (system && PROVIDER_NAMES[system]) || system || 'its source system';
}

export class ExternallyOwnedWorkItemError extends Error {
  public readonly workItemId: string;
  public readonly twinId: string | null;
  public readonly authority: string;
  public readonly fields: string[];

  constructor(item: { id: string; item_key?: string; source_twin_id?: string | null; source_system?: string | null }, fields: string[]) {
    const owner = sourceName(item.source_system);
    super(
      `${item.item_key || item.id} is owned by ${owner}; ${fields.join(', ')} cannot be changed locally. `
        + `Change it in ${owner}, or request a governed write-back through the synchronized twin.`,
    );
    this.name = 'ExternallyOwnedWorkItemError';
    this.workItemId = item.id;
    this.twinId = item.source_twin_id || null;
    this.authority = item.source_system || 'external';
    this.fields = fields;
  }

  public toResponse() {
    return {
      statusCode: 409,
      error: 'externally_owned',
      message: this.message,
      authority: this.authority,
      fields: this.fields,
      twin_id: this.twinId,
      edit_path: this.twinId ? `/workspace/twins/${this.twinId}/edits` : null,
    };
  }
}
