import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { loadRuntimeConfig } from '../../config/runtime-config';

@Controller('health')
export class HealthController {
  private readonly database = DatabaseService.getInstance();
  private readonly startedAt = new Date().toISOString();

  @Get('live')
  public live() {
    const runtime = loadRuntimeConfig();
    return {
      status: 'live',
      service: runtime.serviceName,
      mode: runtime.mode,
      build_sha: runtime.buildSha,
      started_at: this.startedAt,
      uptime_seconds: Math.floor(process.uptime()),
    };
  }

  @Get('ready')
  public async ready() {
    const runtime = loadRuntimeConfig();
    try {
      await this.withTimeout(this.database.checkReady(), 5_000);
      return {
        status: 'ready',
        service: runtime.serviceName,
        mode: runtime.mode,
        build_sha: runtime.buildSha,
        database: { status: 'ready', backend: this.database.backend },
      };
    } catch {
      throw new HttpException(
        {
          status: 'not_ready',
          service: runtime.serviceName,
          mode: runtime.mode,
          build_sha: runtime.buildSha,
          database: { status: 'not_ready', backend: this.database.backend },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Readiness check timed out')), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
