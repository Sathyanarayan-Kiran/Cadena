import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { loadRuntimeConfig } from '../src/config/runtime-config';

describe('Cloud staging foundation', () => {
  const validStagingEnv: NodeJS.ProcessEnv = {
    CADENA_RUNTIME_MODE: 'staging',
    DATABASE_URL: 'postgresql://cadena:secret@postgres.internal:5432/cadena',
    CADENA_DATABASE_SSL: 'verify-full',
    CADENA_BOOTSTRAP_TOKEN: 'a-secure-bootstrap-token-over-32-characters',
    CADENA_ALLOW_HEADER_AUTH: 'false',
  };

  it('accepts a secure managed-PostgreSQL staging configuration', () => {
    expect(loadRuntimeConfig(validStagingEnv)).toMatchObject({
      mode: 'staging',
      port: 3000,
      seedDemoData: false,
      trustProxy: false,
    });
  });

  it('fails closed when staging lacks database, authentication, or verified TLS controls', () => {
    expect(() => loadRuntimeConfig({ ...validStagingEnv, DATABASE_URL: undefined }))
      .toThrow('staging mode requires DATABASE_URL');
    expect(() => loadRuntimeConfig({ ...validStagingEnv, CADENA_ALLOW_HEADER_AUTH: 'true' }))
      .toThrow('forbids CADENA_ALLOW_HEADER_AUTH=true');
    expect(() => loadRuntimeConfig({ ...validStagingEnv, CADENA_DATABASE_SSL: 'require' }))
      .toThrow('requires CADENA_DATABASE_SSL=verify-full');
    expect(() => loadRuntimeConfig({ ...validStagingEnv, CADENA_BOOTSTRAP_TOKEN: 'short' }))
      .toThrow('at least 32 characters');
  });

  it('rejects connection-string SSL overrides that could replace the verified TLS config', () => {
    expect(() => loadRuntimeConfig({
      ...validStagingEnv,
      DATABASE_URL: `${validStagingEnv.DATABASE_URL}?sslmode=require`,
    })).toThrow('must not include sslmode');
  });

  it('ships a single-writer deployment with public probes, TLS ingress, and external secrets', () => {
    const root = join(__dirname, '..', 'deploy', 'staging');
    const deployment = readFileSync(join(root, 'deployment.yaml'), 'utf8');
    const ingress = readFileSync(join(root, 'ingress.yaml'), 'utf8');
    const kustomization = readFileSync(join(root, 'kustomization.yaml'), 'utf8');

    expect(deployment).toContain('replicas: 1');
    expect(deployment).toContain('type: Recreate');
    expect(deployment).toContain('path: /health/live');
    expect(deployment).toContain('path: /health/ready');
    expect(deployment).toContain('name: cadena-staging-secrets');
    expect(deployment).toContain('readOnlyRootFilesystem: true');
    expect(ingress).toContain('force-ssl-redirect: "true"');
    expect(ingress).toContain('secretName: cadena-staging-tls');
    expect(kustomization).not.toContain('secret.example.yaml');
  });
});

describe('Health probes', () => {
  let app: INestApplication;
  let headerAuthWas: string | undefined;

  beforeAll(async () => {
    headerAuthWas = process.env.CADENA_ALLOW_HEADER_AUTH;
    process.env.CADENA_ALLOW_HEADER_AUTH = 'false';
    await DatabaseService.getInstance().initialize();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (headerAuthWas === undefined) delete process.env.CADENA_ALLOW_HEADER_AUTH;
    else process.env.CADENA_ALLOW_HEADER_AUTH = headerAuthWas;
  });

  it('exposes unauthenticated liveness without touching tenant data', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(response.body).toMatchObject({ status: 'live', service: 'cadena-api', mode: 'local' });
    expect(response.body.uptime_seconds).toBeTypeOf('number');
  });

  it('reports readiness only after the configured datastore answers', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      database: { status: 'ready', backend: DatabaseService.getInstance().backend },
    });
  });
});
