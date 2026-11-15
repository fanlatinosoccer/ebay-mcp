import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Integration suite — hermetic (nock; no live network). Split from the unit
// config so `pnpm test` stays fast, while `pnpm run test:integration` (and CI's
// test.yml) run the slower, cross-boundary specs. Mirrors the unit config's
// resolve/env; only the include/exclude differ. See vitest.config.cts.
const vitestIntegrationConfig = defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Never let OAuth store reloads read a developer's real .env during tests.
    setupFiles: ['./tests/helpers/isolateCredentialStore.ts'],
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules', 'build', 'dist', 'tests/unit/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});

module.exports = vitestIntegrationConfig;
