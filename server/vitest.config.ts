import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file gets its own throw-away database; run files in parallel, tests within a file in order.
    fileParallelism: true,
  },
});
