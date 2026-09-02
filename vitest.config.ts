import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup.ts'],
    // mongodb-memory-server needs time to download/start on a cold run
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Vitest 4 removed `poolOptions`; these are the top-level equivalent of the
    // old `forks.singleFork`. The suite must stay single-process: every file
    // boots its own MongoMemoryReplSet and shares mongoose's global connection,
    // so running files in parallel makes them fight over one another's state.
    fileParallelism: false,
    maxWorkers: 1,
    isolate: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/worker.ts', 'src/**/*.d.ts'],
    },
  },
});
