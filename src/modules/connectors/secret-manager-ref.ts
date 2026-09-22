import { ConnectorCredentialError } from './connector-http';

/**
 * Connector credential references.
 *
 * Connector configuration stores pointers, never secrets:
 *   - `env:JIRA_API_TOKEN`            — read from the process environment
 *   - `secret-ref://jira/prod-token`  — resolved by the configured secret store
 *
 * The default store maps `secret-ref://jira/prod-token` to the environment variable
 * `SECRET_JIRA_PROD_TOKEN`, matching how the Kubernetes external-secret contract projects
 * secret-manager entries into the pod. A cloud secret-manager client can replace it by
 * implementing `SecretStore` without touching the adapters.
 */
export interface SecretStore {
  get(name: string): string | undefined;
}

const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]{0,127})$/;
const SECRET_REF = /^secret-ref:\/\/([a-z0-9][a-z0-9._/-]{0,127})$/;
const CREDENTIAL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export class EnvironmentSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  public get(name: string): string | undefined {
    return this.env[`SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  }
}

export class SecretManagerResolver {
  constructor(
    private readonly store: SecretStore = new EnvironmentSecretStore(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  public static isReference(value: unknown): value is string {
    return typeof value === 'string' && (ENV_REF.test(value) || SECRET_REF.test(value));
  }

  /**
   * Validates a credential map for storage. Every value must be a reference; a plaintext value is
   * refused outright (not masked) so the caller learns the secret was never accepted.
   */
  public static validateReferences(credentials: unknown): Record<string, string> {
    if (credentials === undefined || credentials === null) return {};
    if (typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new ConnectorCredentialError('credentials must be an object of secret references');
    }
    const validated: Record<string, string> = {};
    for (const [key, value] of Object.entries(credentials as Record<string, unknown>)) {
      if (!CREDENTIAL_KEY.test(key)) throw new ConnectorCredentialError(`credential name '${key}' is invalid`);
      if (!SecretManagerResolver.isReference(value)) {
        throw new ConnectorCredentialError(
          `credentials.${key} must be a secret reference (env:NAME or secret-ref://name); plaintext secrets are not accepted`,
        );
      }
      validated[key] = value;
    }
    return validated;
  }

  /** Resolves one reference. Fails closed: an unresolvable reference is an error, never a fallback value. */
  public resolve(key: string, reference: string): string {
    const envMatch = ENV_REF.exec(reference);
    const secretMatch = envMatch ? null : SECRET_REF.exec(reference);
    const value = envMatch ? this.env[envMatch[1]] : secretMatch ? this.store.get(secretMatch[1]) : undefined;
    if (!envMatch && !secretMatch) {
      throw new ConnectorCredentialError(`credentials.${key} is not a secret reference`);
    }
    if (!value) throw new ConnectorCredentialError(`credentials.${key} reference ${reference} could not be resolved`);
    return value;
  }

  public resolveAll(credentials: Record<string, string> | undefined): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, reference] of Object.entries(credentials || {})) {
      resolved[key] = this.resolve(key, reference);
    }
    return resolved;
  }
}
