import { sql } from 'drizzle-orm';
import type { Db } from './index.js';
import { excludedCountries } from './schema.js';
import { isKnownCountry } from '../normalize.js';

/** Excluded countries, canonical names, sorted cs. */
export async function getExcludedCountries(db: Db): Promise<string[]> {
  const rows = await db.select({ country: excludedCountries.country }).from(excludedCountries);
  return rows.map((r) => r.country).sort((a, b) => a.localeCompare(b, 'cs'));
}

/**
 * Replace the whole exclusion set with `countries` (validated to canonical
 * countries via isKnownCountry, deduped). Unknown/empty entries are silently
 * dropped. Returns the stored set, sorted cs.
 */
export async function setExcludedCountries(db: Db, countries: string[]): Promise<string[]> {
  const valid = [...new Set(countries.filter((c) => isKnownCountry(c)))];
  const createdAt = Date.now();
  await db.delete(excludedCountries);
  if (valid.length > 0) {
    await db.insert(excludedCountries).values(valid.map((country) => ({ country, createdAt })));
  }
  return valid.sort((a, b) => a.localeCompare(b, 'cs'));
}
