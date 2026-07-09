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
  appPromise ??= bootstrap().then(({ db, cfg }) => createApi({ db, profiles: cfg.profiles }));
  const app = await appPromise;
  return app.fetch(req);
}

export default getRequestListener(fetchHandler);
