/**
 * Secret Reference Resolver for Connector Credentials.
 *
 * Ensures that plaintext passwords/tokens are not permanently stored in cleartext
 * in the database configuration. Credential maps contain pointers like:
 *   - "env:JIRA_API_TOKEN"
 *   - "secret-ref://jira-token-prod"
 *
 * If a raw string is passed, it is sanitized or stored as a reference.
 */
export class SecretManagerResolver {
  public static resolveSecret(secretRef?: string): string {
    if (!secretRef) return '';
    if (secretRef.startsWith('env:')) {
      const envVar = secretRef.slice(4).trim();
      return process.env[envVar] || '';
    }
    if (secretRef.startsWith('secret-ref://')) {
      const key = secretRef.slice(13).trim();
      return process.env[`SECRET_${key.toUpperCase().replace(/[^A_Z0_9]/g, '_')}`] || secretRef;
    }
    // Return direct value if provided (e.g. for development/test fixtures)
    return secretRef;
  }

  public static sanitizeConfigForStorage(
    config: Record<string, any>,
  ): Record<string, any> {
    const sanitized = { ...config };
    if (sanitized.credentials) {
      const sanitizedCreds: Record<string, string> = {};
      for (const [key, value] of Object.entries(sanitized.credentials)) {
        if (typeof value === 'string') {
          if (value.startsWith('env:') || value.startsWith('secret-ref://')) {
            sanitizedCreds[key] = value;
          } else {
            // Mask plaintext secret if passed directly, saving as reference label
            sanitizedCreds[key] = `secret-ref://${key.toLowerCase()}`;
          }
        }
      }
      sanitized.credentials = sanitizedCreds;
    }
    return sanitized;
  }
}
