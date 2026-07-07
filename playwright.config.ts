import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Playwright smoke config (Task 28). One project, chromium only, headless.
 *
 * webServer boots the real stack against a THROWAWAY SQLite file:
 *   1. `web:build` — compile the frontend so src/web/server.ts has web/dist to
 *      serve (the server returns a plain-text hint, not the SPA, if dist is
 *      missing — the smoke would then fail loudly rather than mysteriously).
 *   2. `seed.ts` — populate the tmp DB via the production ingest pipeline.
 *   3. `src/web/server.ts` — serve API + SPA on E2E_PORT against that DB.
 * The three run in one shell (`&&`) so a seed/build failure aborts before the
 * server starts. reuseExistingServer:false guarantees each run gets a freshly
 * seeded server, never a stale one left from a previous run.
 */
const PORT = Number(process.env.E2E_PORT ?? 4142);
// A throwaway DB path inside the OS tmp dir; gitignored and recreated per run.
const DB_PATH = fileURLToPath(new URL('./test-results/e2e-seed.db', import.meta.url));
const DB_URL = `file:${DB_PATH}`;

export default defineConfig({
  testDir: fileURLToPath(new URL('./tests/e2e', import.meta.url)),
  testMatch: /terminal\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `rm -f "${DB_PATH}" && npm run web:build && DATABASE_URL="${DB_URL}" npx tsx tests/e2e/seed.ts && DATABASE_URL="${DB_URL}" PORT=${PORT} npx tsx src/web/server.ts`,
    url: `http://localhost:${PORT}/api/stats`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
