import { createApi } from '../src/web/api.js';
import { bootstrap } from './_lib/bootstrap.js';

// Lazy singleton — NO top-level await. A hung init (e.g. DB connect) with top-level
// await would make the module never resolve → silent FUNCTION_INVOCATION_TIMEOUT.
// Here any init error surfaces as JSON instead of a 30s hang.
let appPromise: Promise<ReturnType<typeof createApi>> | null = null;

export default async function handler(req: Request): Promise<Response> {
  try {
    appPromise ??= bootstrap().then(({ db, cfg }) => createApi({ db, profiles: cfg.profiles }));
    const app = await appPromise;
    return app.fetch(req);
  } catch (e) {
    const err = e as Error;
    return Response.json({ error: 'init failed', detail: err?.message, stack: err?.stack }, { status: 500 });
  }
}
