import { loadRuntimeConfig } from '../config/runtime-config';

try {
  const config = loadRuntimeConfig();
  console.log(JSON.stringify({
    valid: true,
    mode: config.mode,
    port: config.port,
    seed_demo_data: config.seedDemoData,
    trust_proxy: config.trustProxy,
    cors_origins: config.corsOrigins,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Runtime configuration is invalid');
  process.exitCode = 1;
}
