import path from 'node:path';
import { defineConfig } from 'vitest/config';

const vitestConfig = defineConfig({
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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'build/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**',
        'tests/**',
        // Exclude schema definition files (no logic to test)
        'src/utils/**',
        'src/schemas/**',
        // Exclude server entry points (tested via integration)
        'src/index.ts',
        'src/serverHttp.ts',
        // Exclude simple template generators
        'src/tools/token-template.ts',
        'src/tools/tool-definitions.ts',
        // Exclude script files
        'src/scripts/**',
      ],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 75,
        functions: 90,
        branches: 65,
        statements: 75,
      },
    },
    // Unit suite only. The hermetic integration suite runs via its own config —
    // `pnpm run test:integration` (vitest.integration.config.cts) and CI's test.yml.
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['node_modules', 'build', 'dist', 'tests/integration/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});

module.exports = vitestConfig;
