import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/** Minimal structured access telemetry without logging credentials, bodies or query values. */
export function requestLoggingMiddleware(request: Request, response: Response, next: NextFunction): void {
  const requestId = request.header('x-request-id')?.trim() || randomUUID();
  const started = process.hrtime.bigint();
  response.setHeader('x-request-id', requestId);

  response.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    console.log(JSON.stringify({
      level: 'info',
      event: 'http_request',
      request_id: requestId,
      method: request.method,
      path: request.path,
      status_code: response.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
    }));
  });
  next();
}
