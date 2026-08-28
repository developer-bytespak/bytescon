import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Runs before any test module evaluates, so DATABASE_URL is populated
    // from .env.test before testClient.ts imports config/database and
    // constructs the Prisma singleton. Loaded without override, so an
    // already exported DATABASE_URL (CI) wins. See loadTestEnv.ts.
    setupFiles: ['./src/test-utils/loadTestEnv.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      exclude: [
        'node_modules',
        'dist',
        'prisma',
        '**/*.test.ts',
        '**/*.config.ts',
        'src/server.ts', // entry point, not unit-testable
      ],
    },
  },
})
