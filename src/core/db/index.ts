import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { offers } from './schema.js';
import { computeMatchKey, computeHotelKey } from '../normalize.js';
import type { NormalizedOffer } from '../types.js';

export type Db = LibSQLDatabase<typeof schema>;

export function openDb(url: string, authToken?: string): Db {
  const resolvedUrl = url === ':memory:' ? 'file::memory:' : url;
  const client = createClient({ url: resolvedUrl, authToken });
  return drizzle(client, { schema });
}

// SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS`, so schema evolution on
// an existing DB file has to check PRAGMA table_info first and only issue the
// ALTER TABLE when the column is actually missing. Safe to call repeatedly
// (ensureSchema idempotence).
// `table` and `columnDdl` are interpolated directly into SQL with no escaping — every
// call site MUST pass string literals only, never external/user input.
async function ensureColumn(db: Db, table: string, column: string, columnDdl: string): Promise<void> {
  const rows = (await db.all(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
  const exists = rows.some(r => r.name === column);
  if (!exists) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
  }
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

  await db.run(`
    CREATE TABLE IF NOT EXISTS excluded_countries (
      country TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);

  // Cross-source match key (spec §13) — added after the tables above already
  // shipped, so existing DB files need an ALTER TABLE rather than relying on
  // CREATE TABLE IF NOT EXISTS's column list.
  await ensureColumn(db, 'offers', 'match_key', 'match_key TEXT');
  await ensureColumn(db, 'notifications_log', 'match_key', 'match_key TEXT');

  await db.run(`
    CREATE INDEX IF NOT EXISTS offers_match_key_idx ON offers (match_key)
  `);

  // Hotel identity key (spec §15) — one level up from match_key (no date/nights/board), used
  // by the discount-v2 "hotel" reference rung. Same ALTER TABLE + index + backfill pattern.
  await ensureColumn(db, 'offers', 'hotel_key', 'hotel_key TEXT');

  await db.run(`
    CREATE INDEX IF NOT EXISTS offers_hotel_key_idx ON offers (hotel_key)
  `);

  await backfillMatchKeys(db);
  await backfillHotelKeys(db);
}

// One-off backfill for offers rows written before match_key existed (or
// before the column had a chance to be populated). Cheap at current scale
// (single-digit-thousands of offer rows expected for this project) — a full
// table scan on every ensureSchema call is fine; if offers ever grows large
// enough for this to matter, switch to tracking a "backfill done" marker.
async function backfillMatchKeys(db: Db): Promise<void> {
  const rows = await db
    .select({
      id: offers.id,
      title: offers.title,
      country: offers.country,
      board: offers.board,
      departureAirport: offers.departureAirport,
      departureDate: offers.departureDate,
      nights: offers.nights,
    })
    .from(offers)
    .where(sql`${offers.matchKey} IS NULL`);

  for (const row of rows) {
    // Reconstruct just enough of a NormalizedOffer shape for computeMatchKey —
    // it only reads title/country/board/departureAirport/departureDate/nights.
    const pseudoOffer = {
      title: row.title,
      country: row.country,
      board: (row.board ?? 'unknown') as NormalizedOffer['board'],
      departureAirport: row.departureAirport,
      departureDate: row.departureDate,
      nights: row.nights,
    } as NormalizedOffer;

    const matchKey = computeMatchKey(pseudoOffer);
    if (matchKey !== null) {
      await db.update(offers).set({ matchKey }).where(sql`${offers.id} = ${row.id}`);
    }
  }
}

// One-off backfill for offers rows written before hotel_key existed (spec §15), mirroring
// backfillMatchKeys above.
async function backfillHotelKeys(db: Db): Promise<void> {
  const rows = await db
    .select({
      id: offers.id,
      title: offers.title,
      country: offers.country,
    })
    .from(offers)
    .where(sql`${offers.hotelKey} IS NULL`);

  for (const row of rows) {
    // Reconstruct just enough of a NormalizedOffer shape for computeHotelKey — it only reads
    // title/country.
    const pseudoOffer = {
      title: row.title,
      country: row.country,
    } as NormalizedOffer;

    const hotelKey = computeHotelKey(pseudoOffer);
    if (hotelKey !== null) {
      await db.update(offers).set({ hotelKey }).where(sql`${offers.id} = ${row.id}`);
    }
  }
}
