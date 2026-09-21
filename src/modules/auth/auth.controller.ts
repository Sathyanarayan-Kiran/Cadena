import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { AuthService, InvalidCredentialError, IssueCredentialDto, PLATFORM_ADMIN_ROLE, Principal } from './auth.service';

function principalOf(request: any): Principal {
  const principal = request?.principal as Principal | undefined;
  if (!principal) {
    throw new HttpException('Authentication context is missing', HttpStatus.UNAUTHORIZED);
  }
  return principal;
}

/**
 * Managing credentials requires either the bootstrap token or an existing credential
 * holding `platform_admin`. A development header identity deliberately cannot mint
 * credentials: that would let the very mechanism being replaced issue its replacement.
 */
function requireCredentialAdmin(request: any): Principal {
  const principal = principalOf(request);
  const allowed = principal.source === 'bootstrap'
    || (principal.source === 'credential' && principal.roles.includes(PLATFORM_ADMIN_ROLE));
  if (!allowed) {
    throw new HttpException(
      {
        statusCode: 403,
        error: 'admin_required',
        message: `Managing credentials requires the bootstrap token or a credential holding '${PLATFORM_ADMIN_ROLE}'`,
      },
      HttpStatus.FORBIDDEN,
    );
  }
  return principal;
}

@Controller('auth')
export class AuthController {
  private readonly service = new AuthService();

  @Get('me')
  async me(@Req() request: any) {
    const principal = principalOf(request);
    return {
      org_id: principal.org_id,
      actor_id: principal.actor_id,
      roles: principal.roles,
      source: principal.source,
      credential_id: principal.credential_id ?? null,
    };
  }

  @Post('credentials')
  async issue(@Body() body: IssueCredentialDto, @Req() request: any) {
    const principal = requireCredentialAdmin(request);
    try {
      return await this.service.issueCredential(principal.org_id, body || {});
    } catch (error) {
      if (error instanceof InvalidCredentialError) {
        throw new HttpException(
          { statusCode: 422, error: 'invalid_credential', message: error.message },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw error;
    }
  }

  @Get('credentials')
  async list(@Req() request: any) {
    const principal = requireCredentialAdmin(request);
    return this.service.listCredentials(principal.org_id);
  }

  @Post('credentials/:id/revoke')
  async revoke(@Param('id') id: string, @Req() request: any) {
    const principal = requireCredentialAdmin(request);
    try {
      return await this.service.revokeCredential(principal.org_id, id);
    } catch (error) {
      if (error instanceof InvalidCredentialError) {
        throw new HttpException(
          { statusCode: 404, error: 'not_found', message: error.message },
          HttpStatus.NOT_FOUND,
        );
      }
      throw error;
    }
  }
}
