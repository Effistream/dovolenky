import { defineConfig } from 'vitest/config';
// Root unit tests only. The include glob already excludes tests/e2e (Playwright
// specs are *.spec.ts, seed.ts has no .test suffix), but the explicit exclude
// makes it impossible for a future tests/e2e/*.test.ts to be swept into vitest —
// those belong to `npm run test:e2e` (Playwright), which vitest can't run.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
