import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const offers = sqliteTable('offers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  sourceOfferKey: text('source_offer_key').notNull(),
  title: text('title').notNull(),
  country: text('country'),
  locality: text('locality'),
  stars: real('stars'),
  board: text('board'),
  transport: text('transport'),
  departureAirport: text('departure_airport'),
  departureDate: text('departure_date'),
  nights: integer('nights'),
  tourOperator: text('tour_operator'),
  url: text('url').notNull(),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  misses: integer('misses').notNull().default(0),
  matchKey: text('match_key'),
}, (table) => [
  uniqueIndex('offers_source_source_offer_key_idx').on(table.source, table.sourceOfferKey),
]);

export const priceSnapshots = sqliteTable('price_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  offerId: integer('offer_id').notNull().references(() => offers.id),
  capturedAt: text('captured_at').notNull(),
  pricePerPerson: integer('price_per_person').notNull(),
  priceTotal: integer('price_total'),
  claimedOriginalPrice: integer('claimed_original_price'),
  claimedDiscountPct: real('claimed_discount_pct'),
  omnibusLowestPrice: integer('omnibus_lowest_price'),
});

export const notificationsLog = sqliteTable('notifications_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  offerId: integer('offer_id'),
  type: text('type').notNull(),
  sentAt: text('sent_at').notNull(),
  priceAtSend: integer('price_at_send'),
  matchKey: text('match_key'),
});

export const sourceRuns = sqliteTable('source_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  offersFound: integer('offers_found'),
  snapshotsWritten: integer('snapshots_written'),
  errorCount: integer('error_count'),
  status: text('status'),
  errorSample: text('error_sample'),
});
