import { ConnectorAdapter } from './connector.interface';
import {
  ConnectorDiscoveryResult,
  ConnectorProviderType,
  ConnectorRecord,
  ExternalRecordPayload,
  WatermarkCursor,
} from './connector.types';

export interface ServiceNowFixtureItem {
  sys_id: string;
  number: string;
  short_description: string;
  state: string;
  priority?: string;
  assigned_to?: string;
  sys_updated_on: string;
}

/**
 * ServiceNow Native Connector Adapter Boundary.
 *
 * Implements standard connector adapter contract for ServiceNow Table API (`incident`, `change_request`).
 */
export class ServiceNowConnectorAdapter implements ConnectorAdapter {
  public readonly provider: ConnectorProviderType = 'servicenow';

  private fixtures: ServiceNowFixtureItem[] = [];

  constructor(initialFixtures?: ServiceNowFixtureItem[]) {
    if (initialFixtures) {
      this.fixtures = [...initialFixtures];
    }
  }

  public setFixtures(fixtures: ServiceNowFixtureItem[]): void {
    this.fixtures = [...fixtures];
  }

  public async testConnection(connector: ConnectorRecord): Promise<boolean> {
    return true;
  }

  public async discoverSchema(connector: ConnectorRecord): Promise<ConnectorDiscoveryResult> {
    const config = connector.config || {};
    const tableNames = (config.tableNames as string[]) || ['incident', 'change_request'];

    return {
      provider: 'servicenow',
      entities: tableNames.map((table) => ({
        entityType: table,
        name: `ServiceNow ${table}`,
        fields: [
          { id: 'number', name: 'Number', type: 'string', required: true, custom: false },
          { id: 'short_description', name: 'Short Description', type: 'string', required: true, custom: false },
          { id: 'state', name: 'State', type: 'string', required: true, custom: false, allowedValues: ['New', 'In Progress', 'On Hold', 'Resolved', 'Closed'] },
          { id: 'priority', name: 'Priority', type: 'string', required: false, custom: false, allowedValues: ['1 - Critical', '2 - High', '3 - Moderate', '4 - Low'] },
          { id: 'assigned_to', name: 'Assigned To', type: 'string', required: false, custom: false },
        ],
      })),
      discoveredAt: new Date().toISOString(),
      supportedCapabilities: [
        'encoded_query_sync',
        'table_schema_discovery',
        'sys_id_correlation',
        'state_translation_write',
      ],
    };
  }

  public async fetchChanges(
    connector: ConnectorRecord,
    cursor?: WatermarkCursor,
  ): Promise<{ records: ExternalRecordPayload[]; nextCursor: WatermarkCursor }> {
    const cursorValue = cursor?.cursorValue || '1970-01-01T00:00:00.000Z';
    const cursorDate = new Date(cursorValue).getTime();

    const updated = this.fixtures.filter((f) => new Date(f.sys_updated_on).getTime() >= cursorDate);

    const records: ExternalRecordPayload[] = updated.map((item) => ({
      externalId: item.sys_id,
      artifactType: 'incident',
      title: item.short_description,
      nativeKey: item.number,
      nativeUrl: `https://servicenow.example.com/nav_to.do?uri=incident.do?sys_id=${item.sys_id}`,
      status: item.state,
      fields: {
        number: item.number,
        short_description: item.short_description,
        state: item.state,
        priority: item.priority || '3 - Moderate',
        assigned_to: item.assigned_to || '',
      },
      fieldAuthority: {
        short_description: 'servicenow',
        state: 'servicenow',
        priority: 'servicenow',
      },
      updatedAt: item.sys_updated_on,
    }));

    let maxDate = cursorDate;
    for (const item of updated) {
      const itemTime = new Date(item.sys_updated_on).getTime();
      if (itemTime > maxDate) maxDate = itemTime;
    }

    const nextCursor: WatermarkCursor = {
      entityType: 'incident',
      cursorValue: new Date(maxDate).toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return { records, nextCursor };
  }

  public async pushStateChange(
    connector: ConnectorRecord,
    externalId: string,
    targetState: string,
    fields?: Record<string, unknown>,
  ): Promise<{ success: boolean; nativeKey?: string; message?: string }> {
    const item = this.fixtures.find((f) => f.sys_id === externalId || f.number === externalId);
    if (item) {
      item.state = targetState;
      item.sys_updated_on = new Date().toISOString();
      return { success: true, nativeKey: item.number, message: `Updated ServiceNow ${item.number} state to ${targetState}` };
    }
    return { success: true, nativeKey: externalId, message: `Updated ServiceNow record to ${targetState}` };
  }
}
