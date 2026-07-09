import path from 'node:path';
import { loadConfig, type AppConfig } from '../../src/core/config.js';
import { openDb, ensureSchema, type Db } from '../../src/core/db/index.js';

let cached: Promise<{ db: Db; cfg: AppConfig }> | null = null;
export function bootstrap(): Promise<{ db: Db; cfg: AppConfig }> {
  if (!cached) {
    cached = (async () => {
      const cfg = loadConfig({ configPath: path.join(process.cwd(), 'config', 'watch.yaml') });
      const db = openDb(cfg.databaseUrl, cfg.databaseAuthToken ?? undefined);
      await ensureSchema(db);
      return { db, cfg };
    })();
  }
  return cached;
}
