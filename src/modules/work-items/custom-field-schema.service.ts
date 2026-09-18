import { randomUUID } from 'crypto';
import Ajv from 'ajv';
import { DatabaseService } from '../../database/database.service';

const ajv = new Ajv({ allErrors: true });

export interface RegisterCustomFieldSchemaDto {
  type: string;
  schema: Record<string, any>;
  defaults?: Record<string, any>;
}

export class CustomFieldSchemaService {
  private dbService = DatabaseService.getInstance();

  public async registerSchema(dto: RegisterCustomFieldSchemaDto): Promise<{ id: string; type: string; version: number }> {
    await this.dbService.initialize();

    // Check existing max version
    const res = await this.dbService.db.query<any>(
      `SELECT MAX(version) as max_version FROM custom_field_schemas WHERE type = $1`,
      [dto.type],
    );
    const nextVersion = (res.rows?.[0]?.max_version || 0) + 1;
    const id = randomUUID();

    await this.dbService.db.query(
      `INSERT INTO custom_field_schemas (id, type, version, schema, defaults, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [id, dto.type, nextVersion, JSON.stringify(dto.schema), JSON.stringify(dto.defaults || {})],
    );

    return { id, type: dto.type, version: nextVersion };
  }

  public async getLatestSchema(type: string): Promise<{ schema: Record<string, any>; defaults: Record<string, any> } | null> {
    await this.dbService.initialize();
    const res = await this.dbService.db.query<any>(
      `SELECT schema, defaults FROM custom_field_schemas WHERE type = $1 ORDER BY version DESC LIMIT 1`,
      [type],
    );

    if (!res.rows || res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      schema: typeof row.schema === 'string' ? JSON.parse(row.schema) : row.schema,
      defaults: typeof row.defaults === 'string' ? JSON.parse(row.defaults) : row.defaults || {},
    };
  }

  public validateCustomFields(schema: Record<string, any>, customFields: Record<string, any>): { valid: boolean; errors?: string[] } {
    try {
      const validate = ajv.compile(schema);
      const valid = validate(customFields);
      if (!valid) {
        const errors = validate.errors?.map((err) => `${err.instancePath || '/'} ${err.message}`) || ['Invalid custom fields'];
        return { valid: false, errors };
      }
      return { valid: true };
    } catch (err: any) {
      return { valid: false, errors: [err.message] };
    }
  }
}
