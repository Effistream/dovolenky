import { getRequestListener } from '@hono/node-server';
import { createApi } from '../src/web/api.js';
import { bootstrap } from './_lib/bootstrap.js';

// Vercel runs api/ functions with the LEGACY Node (req, res) signature, not the Web
// fetch signature — so `hono/vercel`'s handle (Edge-oriented) has its Response silently
// dropped → 30s FUNCTION_INVOCATION_TIMEOUT. `getRequestListener` bridges a fetch-style
// handler to a Node (req, res) listener, which is exactly what Vercel calls.
// Lazy singleton: no top-level await, and getRequestListener surfaces throws as 500.
let appPromise: Promise<ReturnType<typeof createApi>> | null = null;

async function fetchHandler(req: Request): Promise<Response> {
  if (appPromise === null) {
    appPromise = bootstrap().then(({ db, cfg }) => createApi({ db, profiles: cfg.profiles }));
    // A failed bootstrap must NOT poison the warm instance: without this reset, one
    // transient outage (e.g. the Turso quota block, 2026-07-11) leaves a rejected
    // promise cached and every later request 500s until the instance recycles.
    // Reset on rejection so the next request retries; concurrent requests still
    // share the single in-flight attempt.
    appPromise.catch(() => {
      appPromise = null;
    });
  }
  const app = await appPromise;
  return app.fetch(req);
}

export default getRequestListener(fetchHandler);
