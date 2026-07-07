import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { loadDotEnv } from '../cli/env.js';
import { loadConfig } from '../core/config.js';
import { openDb, ensureSchema } from '../core/db/index.js';
import { createApi } from './api.js';

const DEFAULT_PORT = 4141;

async function main(): Promise<void> {
  // Load .env (real env wins), then config + DB — same bootstrap as the CLI.
  loadDotEnv(fileURLToPath(new URL('../../.env', import.meta.url)), process.env);
  const cfg = loadConfig();
  const db = openDb(cfg.databaseUrl);
  await ensureSchema(db);

  const app = new Hono();

  // API routes are already namespaced under /api by createApi.
  app.route('/', createApi({ db, profiles: cfg.profiles }));

  // Static frontend: serve web/dist when it has been built, otherwise return a
  // plain-text hint so `npm run web` before `npm run web:build` fails loudly
  // rather than 404-ing mysteriously.
  const distDir = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(distDir)) {
    app.use('/*', serveStatic({ root: './web/dist' }));
    // SPA fallback: unmatched non-API routes get index.html.
    app.get('*', serveStatic({ path: './web/dist/index.html' }));
  } else {
    app.get('/', (c) =>
      c.text('web/dist not built yet — run `npm run web:build` (vite build in web/), then reload.', 200),
    );
  }

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const hostname = process.env.HOST ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    // eslint-disable-next-line no-console
    console.log(`dovolenky terminál běží na http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
