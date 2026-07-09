import type { Db } from './index.js';
import { excludedCountries } from './schema.js';
import { isKnownCountry, normalizeCountry } from '../normalize.js';

/** Excluded countries, canonical names, sorted cs. */
export async function getExcludedCountries(db: Db): Promise<string[]> {
  const rows = await db.select({ country: excludedCountries.country }).from(excludedCountries);
  return rows.map((r) => r.country).sort((a, b) => a.localeCompare(b, 'cs'));
}

/**
 * Replace the whole exclusion set with `countries` (validated and canonicalized
 * via isKnownCountry/normalizeCountry, deduped). Aliases and case/diacritic
 * variants are folded to the canonical DB country name so enforcement sites that
 * match EXACTLY against offer.country actually hit. Unknown/empty entries are
 * silently dropped. Returns the stored set, sorted cs.
 */
export async function setExcludedCountries(db: Db, countries: string[]): Promise<string[]> {
  // isKnownCountry gates the map, so normalizeCountry always returns a canonical
  // string here — its raw-passthrough fallback never triggers.
  const valid = [...new Set(
    countries.map((c) => (isKnownCountry(c) ? normalizeCountry(c) : null))
             .filter((c): c is string => c !== null),
  )];
  const createdAt = Date.now();
  await db.delete(excludedCountries);
  if (valid.length > 0) {
    await db.insert(excludedCountries).values(valid.map((country) => ({ country, createdAt })));
  }
  return valid.sort((a, b) => a.localeCompare(b, 'cs'));
}
