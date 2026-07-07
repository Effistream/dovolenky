import { defineConfig } from 'vitest/config';

// Web unit tests cover only the pure helpers in src/lib (formatting, tones,
// sort/filter, sparkline path). No component rendering here (that's Task 28's
// Playwright pass), so a plain node environment is enough — no happy-dom needed.
// The include glob is scoped to src so the root `vitest run` (include:
// tests/**/*.test.ts) never picks these up, and vice versa.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
