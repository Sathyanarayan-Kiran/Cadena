import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PILOT_ORG_ID } from '../../bootstrap/pilot-configuration';
import { AuthService, Principal } from './auth.service';

/**
 * Establishes who is calling, before any controller reads a tenant.
 *
 * Forty-nine call sites read the tenant from `x-org-id`. Rewriting them all at once would
 * have been a large, risky change, so this guard resolves an authenticated principal and
 * then **overwrites** that header with the authenticated value. The existing controllers
 * keep working unchanged, but what they read is now something the caller proved rather
 * than something the caller asserted.
 *
 * A request that names a different tenant than its credential is rejected outright rather
 * than silently corrected: that mismatch is either a bug worth surfacing or an attempt
 * worth refusing, and neither deserves to succeed quietly.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private authService = new AuthService();

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const path = request.path || request.url?.split('?')[0];
    if (path === '/health/live' || path === '/health/ready') return true;
    // Relay agents authenticate against their own hashed, connector-scoped credential inside
    // ConnectorRelayService. Passing that bearer through the platform credential resolver would
    // reject it before the relay boundary can verify it. No other integration path is exempt.
    if (path?.startsWith('/integrations/relay/')) return true;
    const principal = await this.resolve(request);

    if (principal.source === 'dev_header') {
      // Deliberately rewrites nothing. The headers already *are* the identity in this mode,
      // and injecting a default where the caller sent none would change how downstream
      // controllers resolve their own fallbacks. Dev mode must be behaviourally invisible.
      request.principal = principal;
      return true;
    }

    const claimedOrg = request.headers['x-org-id']?.toString().trim();
    if (claimedOrg && claimedOrg !== principal.org_id) {
      throw new HttpException(
        {
          statusCode: 403,
          error: 'tenant_mismatch',
          message: 'The x-org-id header does not match the authenticated tenant',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    // From here on the header carries an authenticated value, not a client claim.
    request.headers['x-org-id'] = principal.org_id;
    request.headers['x-actor-id'] = principal.actor_id;
    if (principal.roles.length > 0) {
      // The workflow engine evaluates a single role; the full set stays on the principal.
      request.headers['x-actor-role'] = principal.roles[0];
    }
    request.principal = principal;
    return true;
  }

  private async resolve(request: any): Promise<Principal> {
    const header = request.headers.authorization?.toString() ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

    if (token) {
      const bootstrap = AuthService.bootstrapToken();
      if (bootstrap && token === bootstrap) {
        // The bootstrap token exists to create the first real credential for a tenant, so
        // it cannot infer its own tenant and must be told which one it is acting for.
        const orgId = request.headers['x-org-id']?.toString().trim();
        if (!orgId) {
          throw new HttpException(
            {
              statusCode: 400,
              error: 'tenant_required',
              message: 'The bootstrap token requires an x-org-id header naming the target tenant',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        return { org_id: orgId, actor_id: 'bootstrap', roles: ['platform_admin'], source: 'bootstrap' };
      }

      const principal = await this.authService.verifyToken(token);
      if (principal) return principal;

      throw new HttpException(
        { statusCode: 401, error: 'invalid_credential', message: 'The bearer token is unknown or revoked' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (AuthService.devHeadersAllowed()) {
      // Reproduces the pre-authentication behaviour exactly, including the pilot-org
      // default the controllers already applied, so enabling dev mode changes nothing
      // for existing callers. The security posture lives entirely in the path above.
      const orgId = request.headers['x-org-id']?.toString().trim() || PILOT_ORG_ID;
      return {
        org_id: orgId,
        actor_id: request.headers['x-actor-id']?.toString().trim() || 'dev-user',
        roles: [request.headers['x-actor-role']?.toString().trim() || 'developer'],
        source: 'dev_header',
      };
    }

    throw new HttpException(
      {
        statusCode: 401,
        error: 'authentication_required',
        message: 'Provide a bearer token. Header-based identity is disabled outside development.',
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}
