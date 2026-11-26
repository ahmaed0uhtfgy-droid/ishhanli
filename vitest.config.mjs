import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/unit/**/*.spec.mjs', 'test/integration/**/*.spec.mjs'],
    environment: 'node',
    testTimeout: 20000,
    coverage: { provider: 'v8', include: ['functions/_lib/**', 'public/js/**'], reporter: ['text-summary', 'json-summary'] },
  },
});
