import path from 'node:path';
import { loadConfig, type AppConfig } from '../../src/core/config.js';
import { openDbWeb, ensureSchema, type Db } from '../../src/core/db/index.js';

let cached: Promise<{ db: Db; cfg: AppConfig }> | null = null;
export function bootstrap(): Promise<{ db: Db; cfg: AppConfig }> {
  if (!cached) {
    cached = (async () => {
      const cfg = loadConfig({ configPath: path.join(process.cwd(), 'config', 'watch.yaml') });
      // openDbWeb (HTTP-only) — the native @libsql/client hangs on Vercel serverless
      // (FUNCTION_INVOCATION_TIMEOUT). DATABASE_URL is a remote libsql:// Turso URL in prod.
      const db = openDbWeb(cfg.databaseUrl, cfg.databaseAuthToken ?? undefined);
      await ensureSchema(db);
      return { db, cfg };
    })();
  }
  return cached;
}
