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

// Three profiles per scan (spec §16.2), each issued once per price band — 11 dates-list requests,
// inside the 12-request cap in cesys.ts. The ladder is the fix for the audited collapse: with a
// single unbounded `price:{0,999999}` request per profile, léto-moře came back as 4 hotels and
// exotika as ONE hotel in ONE of its 12 countries (see the PRICE LADDER section in cesys.ts).
//   léto-moře: today..+60d, duration 7-22 days (empirically biases toward duration_night >= 6,
//     see cesys.ts probe A/B), plus an explicit client-side duration_night >= 6 floor because
//     the API's duration/duration_night relationship isn't a fixed offset.
//   last-minute: today..+14d, broad duration 1-21 days (short stays are the point, no floor).
//   exotika: today..+270d (exotic season is winter), duration 8-22 days (long-haul burns 2 nights
//     on flights, so `from: 7` would hand back 5-night rows the minNights floor then discards),
//     minNights 6, filtered server-side to the exotic CESYS country ids above — same shape as
//     firo's exotika query, so dovolenkovani (which aggregates the same CESYS supply) surfaces
//     long-haul rows too, not just the cheapest Mediterranean ones. The CESYS country mapping is
//     global across clients, so the ids match firo's.
// Band tops sit just above each watch profile's max_price_per_person (config/watch.yaml:
// léto-moře 25k, last-minute 20k, exotika 60k). All flight-only, sorted price asc.
const LETO_BANDS = [
  { from: 0, to: 9000 },
  { from: 9000, to: 12000 },
  { from: 12000, to: 17000 },
];
const LAST_MINUTE_BANDS = [
  { from: 0, to: 8000 },
  { from: 8000, to: 13000 },
  { from: 13000, to: 21000 },
];
const EXOTIKA_BANDS = [
  { from: 0, to: 16000 },
  { from: 16000, to: 22000 },
  { from: 22000, to: 30000 },
  { from: 30000, to: 42000 },
  { from: 42000, to: 62000 },
];

const QUERIES: DatesListQuery[] = [
  { label: 'leto-more', fromDays: 0, toDays: 60, durationFrom: 7, durationTo: 22, minNights: 6, priceBands: LETO_BANDS },
  { label: 'last-minute', fromDays: 0, toDays: 14, durationFrom: 1, durationTo: 21, priceBands: LAST_MINUTE_BANDS },
  { label: 'exotika', fromDays: 0, toDays: 270, durationFrom: 8, durationTo: 22, minNights: 6, countryIds: EXOTIKA_COUNTRY_IDS, priceBands: EXOTIKA_BANDS },
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
  return parseCesysDatesCore(payload, {
    ...maps,
    source: 'dovolenkovani',
    fallbackUrl: FALLBACK_URL,
    detailUrlFor: (masterId) => `${SITE_BASE_URL}/detail-zajezdu/x/${masterId}a`,
  });
}

export const dovolenkovani = makeCesysAdapter({
  name: 'dovolenkovani',
  siteBaseUrl: SITE_BASE_URL,
  clientId: CLIENT_ID,
  customerId: CUSTOMER_ID,
  fallbackUrl: FALLBACK_URL,
  queries: QUERIES,
});
