import { DatabaseService } from '../database/database.service';
import { MonitoringIntegrationService } from '../modules/integrations/monitoring.service';
import { NotificationService } from '../modules/notifications/notification.service';
import { ServiceRegistryService } from '../modules/services/service-registry.service';

export const PILOT_ORG_ID = '00000000-0000-0000-0000-000000000099';
export const PILOT_TEAM_ID = '00000000-0000-0000-0000-000000000001';

export const PILOT_PEOPLE = [
  {
    id: '00000000-0000-0000-0000-00000000a001',
    name: 'Ada Owner',
    email: 'ada@cadena.test',
    role: 'developer',
    channel: 'slack',
    address: '@ada',
  },
  {
    id: '00000000-0000-0000-0000-00000000a002',
    name: 'Lena Lead',
    email: 'lena@cadena.test',
    role: 'team_lead',
    channel: 'email',
    address: null,
  },
  {
    id: '00000000-0000-0000-0000-00000000a003',
    name: 'Otto Oncall',
    email: 'otto@cadena.test',
    role: 'on_call',
    channel: 'teams',
    address: 'otto@teams',
  },
] as const;

/**
 * Adds supporting pilot records without changing anything an operator has configured.
 *
 * The original bootstrap called service upserts on every start. That was harmless while the
 * database was ephemeral, but persistence turned it into data loss: notification preferences,
 * monitoring thresholds, escalation ownership and curated service metadata reverted to demo
 * defaults after every restart. Each seed now fills a missing row only.
 */
export async function seedPilotConfiguration(
  orgId = PILOT_ORG_ID,
  teamId = PILOT_TEAM_ID,
): Promise<void> {
  const database = DatabaseService.getInstance();
  await database.initialize();
  const db = database.db;
  const monitoringService = new MonitoringIntegrationService();
  const notificationService = new NotificationService();
  const serviceRegistry = new ServiceRegistryService();

  const alreadySeeded = async (sql: string, params: unknown[]): Promise<boolean> => {
    const found = await db.query(sql, params as any[]);
    return found.rows.length > 0;
  };

  for (const person of PILOT_PEOPLE) {
    await db.query(
      `INSERT INTO people (id, org_id, team_id, name, email, role)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [person.id, orgId, teamId, person.name, person.email, person.role],
    );
    if (!await alreadySeeded(
      `SELECT person_id FROM notification_preferences WHERE person_id = $1 AND org_id = $2`,
      [person.id, orgId],
    )) {
      await notificationService.setPreference(orgId, {
        person_id: person.id,
        channel: person.channel,
        address: person.address,
      });
    }
  }

  if (!await alreadySeeded(
    `SELECT team_id FROM team_escalation_targets WHERE team_id = $1 AND org_id = $2`,
    [teamId, orgId],
  )) {
    await notificationService.setTeamEscalationTarget(orgId, teamId, PILOT_PEOPLE[2].id);
  }

  if (!await alreadySeeded(`SELECT org_id FROM monitoring_settings WHERE org_id = $1`, [orgId])) {
    await monitoringService.updateSettings(orgId, {
      min_severity: 'SEV3',
      dedupe_window_minutes: 60,
      default_team_id: teamId,
      automation_actor_role: 'on_call',
    });
  }

  const seedServices = [
    {
      name: 'Checkout API',
      service_key: 'checkout-api',
      normalized_key: 'SVC-CHECKOUT-API',
      environment: 'production',
      aliases: ['checkout', 'checkout-api'],
    },
    {
      name: 'Primary Postgres',
      service_key: 'primary-postgres',
      normalized_key: 'SVC-PRIMARY-POSTGRES',
      environment: 'production',
      aliases: ['postgres', 'db-eu-west-1'],
    },
  ];
  for (const service of seedServices) {
    if (await alreadySeeded(
      `SELECT id FROM services WHERE org_id = $1 AND service_key = $2`,
      [orgId, service.normalized_key],
    )) continue;
    await serviceRegistry.registerService(orgId, {
      name: service.name,
      service_key: service.service_key,
      environment: service.environment,
      aliases: service.aliases,
      owner_team_id: teamId,
      source: 'internal',
    });
  }
}
