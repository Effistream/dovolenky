import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

export type Db = LibSQLDatabase<typeof schema>;

export function openDb(url: string): Db {
  const resolvedUrl = url === ':memory:' ? 'file::memory:' : url;
  const client = createClient({ url: resolvedUrl });
  return drizzle(client, { schema });
}

export async function ensureSchema(db: Db): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_offer_key TEXT NOT NULL,
      title TEXT NOT NULL,
      country TEXT,
      locality TEXT,
      stars REAL,
      board TEXT,
      transport TEXT,
      departure_airport TEXT,
      departure_date TEXT,
      nights INTEGER,
      tour_operator TEXT,
      url TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      misses INTEGER NOT NULL DEFAULT 0
    )
  `);

  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS offers_source_source_offer_key_idx
    ON offers (source, source_offer_key)
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER NOT NULL REFERENCES offers(id),
      captured_at TEXT NOT NULL,
      price_per_person INTEGER NOT NULL,
      price_total INTEGER,
      claimed_original_price INTEGER,
      claimed_discount_pct REAL,
      omnibus_lowest_price INTEGER
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS notifications_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      type TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      price_at_send INTEGER
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      offers_found INTEGER,
      snapshots_written INTEGER,
      error_count INTEGER,
      status TEXT,
      error_sample TEXT
    )
  `);
}
