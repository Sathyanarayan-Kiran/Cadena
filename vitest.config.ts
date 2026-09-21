import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    hookTimeout: 30000,
    testTimeout: 30000,
    fileParallelism: false,
    // Header-based identity is off by default so nothing inherits it unintentionally.
    // The suite predates authentication and asserts tenancy through x-org-id, so it opts
    // in here, in one place, rather than in twenty-three spec files.
    env: { CADENA_ALLOW_HEADER_AUTH: 'true' },
  },
});
