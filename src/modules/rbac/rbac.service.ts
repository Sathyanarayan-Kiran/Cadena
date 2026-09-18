import { DatabaseService } from '../../database/database.service';
import { GuardFailedError } from '../workflow/workflow.service';

export interface Person {
  id: string;
  org_id: string;
  team_id: string;
  name: string;
  email: string;
  role: string;
}

export class RbacService {
  private dbService = DatabaseService.getInstance();

  public async getPersonById(id: string): Promise<Person | null> {
    await this.dbService.initialize();
    const res = await this.dbService.db.query<any>(
      `SELECT * FROM people WHERE id = $1`,
      [id],
    );
    if (!res.rows || res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      org_id: row.org_id,
      team_id: row.team_id,
      name: row.name,
      email: row.email,
      role: row.role,
    };
  }

  public async createPerson(person: {
    id: string;
    org_id: string;
    team_id: string;
    name: string;
    email: string;
    role: string;
  }): Promise<Person> {
    await this.dbService.initialize();
    await this.dbService.db.query(
      `INSERT INTO people (id, org_id, team_id, name, email, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
      [person.id, person.org_id, person.team_id, person.name, person.email, person.role],
    );
    return person;
  }

  public async resolveActorRole(actorId: string, headerRole?: string): Promise<string> {
    if (headerRole) return headerRole;
    const person = await this.getPersonById(actorId);
    if (person) return person.role;
    return 'developer'; // default fallback role
  }
}
