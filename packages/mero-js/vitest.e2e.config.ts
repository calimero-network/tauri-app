import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120000, // 2 minutes for e2e tests
    hookTimeout: 120000, // 2 minutes for beforeAll/afterAll
    environment: 'node',
    env: {
      AUTH_API_BASE_URL: 'http://localhost',
    },
  },
});
