import { defineConfig } from 'vitest/config';

// Tests exercise the platform-agnostic core (src/lib/api-core.ts) against the real server.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000, environment: 'node' },
});
