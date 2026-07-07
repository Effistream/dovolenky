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
 * pins dovolenkovani's own ids and its three queries (léto-moře, last-minute, exotika). Live
 * provenance and the full
 * behavior/probe notes are documented in cesys.ts's header comment.
 *
 * Compliance (§9 / spec row 10): dovolenkovani.cz's robots.txt blocks ClaudeBot BY NAME, so this
 * adapter must NEVER send any Claude-identifying UA — it relies entirely on the project's standard
 * Chrome UA (HttpClient's default).
 */

const SITE_BASE_URL = 'https://dovolenkovani.cz';
const CLIENT_ID = '12274';
const CUSTOMER_ID = '2119';
const FALLBACK_URL = 'https://dovolenkovani.cz/vyhledavani-zajezdu/';

// Exotic CESYS country ids (global across CESYS clients, spec §16.1 row 11 — identical to firo's
// list): Thajsko 220, Maledivy 131, Mauricius 138, SAE 198, Dominikánská 46, Mexiko 142,
// Seychely 192, Srí Lanka 215, Tanzanie 219, Kuba 112, Vietnam 239, Kapverdy 102.
const EXOTIKA_COUNTRY_IDS = ['220', '131', '138', '198', '46', '142', '192', '215', '219', '112', '239', '102'];

// Three queries per scan (spec §16.2):
//   léto-moře: today..+60d, duration 7-22 days (empirically biases toward duration_night >= 6,
//     see cesys.ts probe A/B), plus an explicit client-side duration_night >= 6 floor because
//     the API's duration/duration_night relationship isn't a fixed offset.
//   last-minute: today..+14d, broad duration 1-21 days (short stays are the point, no floor).
//   exotika: today..+270d (exotic season is winter), duration 7-22 days, minNights 6, filtered
//     server-side to the exotic CESYS country ids above — same shape as firo's exotika query, so
//     dovolenkovani (which aggregates the same CESYS supply) surfaces long-haul rows too, not just
//     the cheapest Mediterranean ones. The CESYS country mapping is global across clients, so the
//     ids match firo's.
// All flight-only, sorted price asc, 30 rows/page.
const QUERIES: DatesListQuery[] = [
  { label: 'leto-more', fromDays: 0, toDays: 60, durationFrom: 7, durationTo: 22, minNights: 6 },
  { label: 'last-minute', fromDays: 0, toDays: 14, durationFrom: 1, durationTo: 21 },
  { label: 'exotika', fromDays: 0, toDays: 270, durationFrom: 7, durationTo: 22, minNights: 6, countryIds: EXOTIKA_COUNTRY_IDS },
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
