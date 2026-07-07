import type { NormalizedOffer } from '../core/types.js';
import {
  makeCesysAdapter,
  parseAccommodationsSitemap,
  extractAccommodationSitemapUrls,
  parseHotelNameFromDetail,
  parseCesysDates as parseCesysDatesCore,
  type CesysCountriesResponse,
  type DatesListQuery,
  type HotelInfo,
} from './cesys.js';

/**
 * Dovolenkovani.cz — a white-label storefront on the shared CESYS platform (operated by TRAVEL
 * Group s.r.o.), instantiated via {@link makeCesysAdapter}. All CESYS behavior (sitemap index →
 * accommodation shards, mapping/countries, dates-list body, per-person price evidence, discount
 * guard, priorTitles resolution, detail-redirect name lookup) lives in cesys.ts; this file only
 * pins dovolenkovani's own ids and its two watch-profile queries. Live provenance and the full
 * behavior/probe notes are documented in cesys.ts's header comment. (The exotika query for
 * dovolenkovani is added by a later task; this adapter keeps its current 2 queries.)
 *
 * Compliance (§9 / spec row 10): dovolenkovani.cz's robots.txt blocks ClaudeBot BY NAME, so this
 * adapter must NEVER send any Claude-identifying UA — it relies entirely on the project's standard
 * Chrome UA (HttpClient's default).
 */

const SITE_BASE_URL = 'https://dovolenkovani.cz';
const CLIENT_ID = '12274';
const CUSTOMER_ID = '2119';
const FALLBACK_URL = 'https://dovolenkovani.cz/vyhledavani-zajezdu/';

// Two queries per scan, matching the two watch profiles (spec §1):
//   léto-moře: today..+60d, duration 7-22 days (empirically biases toward duration_night >= 6,
//     see cesys.ts probe A/B), plus an explicit client-side duration_night >= 6 floor because
//     the API's duration/duration_night relationship isn't a fixed offset.
//   last-minute: today..+14d, broad duration 1-21 days (short stays are the point, no floor).
// Both flight-only, sorted price asc, 30 rows/page.
const QUERIES: DatesListQuery[] = [
  { label: 'leto-more', fromDays: 0, toDays: 60, durationFrom: 7, durationTo: 22, minNights: 6 },
  { label: 'last-minute', fromDays: 0, toDays: 14, durationFrom: 1, durationTo: 21 },
];

// Re-export the CESYS pure helpers so existing imports/tests (tests/dovolenkovani.test.ts) keep
// compiling unchanged. parseCesysDates is re-bound to dovolenkovani's source tag + fallback URL
// so its 2-arg `(payload, {hotels, countries})` call site stays identical (the storefront-aware
// core lives in cesys.ts).
export { parseAccommodationsSitemap, extractAccommodationSitemapUrls, parseHotelNameFromDetail };
export type { HotelInfo };

export function parseCesysDates(
  payload: unknown,
  maps: { hotels: Map<number, HotelInfo>; countries: CesysCountriesResponse },
): NormalizedOffer[] {
  return parseCesysDatesCore(payload, { ...maps, source: 'dovolenkovani', fallbackUrl: FALLBACK_URL });
}

export const dovolenkovani = makeCesysAdapter({
  name: 'dovolenkovani',
  siteBaseUrl: SITE_BASE_URL,
  clientId: CLIENT_ID,
  customerId: CUSTOMER_ID,
  fallbackUrl: FALLBACK_URL,
  queries: QUERIES,
});
