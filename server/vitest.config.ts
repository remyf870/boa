import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // DB integration tests run sequentially — they share one database
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
