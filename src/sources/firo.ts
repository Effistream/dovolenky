import { makeCesysAdapter, type DatesListQuery } from './cesys.js';

/**
 * FIRO Travel (www.firotravel.cz) — a second white-label storefront on the shared CESYS platform
 * (spec §16.1 row 11), instantiated via {@link makeCesysAdapter}. It is byte-for-byte the same
 * platform as dovolenkovani.ts with a different client_id/customer_id; all behavior lives in
 * cesys.ts. This adapter exists to give the project genuine exotic/long-haul coverage (Thailand,
 * Maldives, Mauritius, UAE, …) via a third `exotika` query that server-side-filters on the exotic
 * CESYS country ids. FIRO aggregates Coral Travel, Čedok, TUI, Fischer CK, Rainbow Tours.
 *
 * ⚠️ The 12-country exotika filter alone was NOT enough: with an unbounded price window the CESYS
 * server's price-asc head collapses onto a single hotel, so the query that justifies this adapter
 * delivered 1 of its 12 countries (30 rows of one Dubai hotel, 19,975+ CZK, no Thailand/Maldives
 * at all). Each profile is therefore issued once per price band — see the PRICE LADDER section in
 * cesys.ts for the measurements. Live run 2026-07-29 after the change: 411 offers / 163 hotels /
 * 19 countries (incl. Maledivy, Mauricius, Thajsko, Srí Lanka, Kapverdy, Dominikánská republika),
 * 4,792-42,001 CZK, in 122s — against 50 offers / 19 hotels / 6 countries / 7,871-22,455 CZK
 * before.
 *
 * Live verification 2026-07-07 (curl, Chrome UA, ≥3s per-host gap — see task-35 report):
 *   (a) POST dates-list?client_id=12352 with customer_id 3593 → HTTP 200, status "success".
 *   (b) `country_id:["131"]` filters server-side: every returned row is country 131 (Maledivy).
 *       The exotika query passes the full exotic id list below; the CESYS country mapping is
 *       global across clients, so these ids match dovolenkovani's too. ⚠️ Re-verified 2026-07-29:
 *       this holds for a SINGLE id but says nothing about a 12-id list, which is what the price
 *       ladder had to fix.
 *   (c) sitemap index + `accommodations.xml` exist and mirror dovolenkovani, EXCEPT the detail
 *       URLs carry an extra country segment (`/detail-zajezdu/<country>/<slug>/<code>`); the
 *       shared parseAccommodationsSitemap takes the last segment before the code as the slug, so
 *       it handles both shapes without a per-storefront tweak.
 *   (d) detail-redirect: GET `/detail-zajezdu/x/<master_id>a` (the DEFAULT dovolenkovani shape)
 *       301-redirects to the canonical `/detail-zajezdu/<country>/<slug>/<code>` page, which
 *       carries the hotel name in BOTH an ld+json LodgingBusiness block and an `<h1>`. CESYS
 *       routes purely on the numeric master_id and ignores the dummy slug segment(s) (the
 *       3-segment `/detail-zajezdu/x/x/<id>a` redirects to the same target), so NO custom
 *       `detailPathTemplate` is needed — the factory default is correct for FIRO.
 *
 * Caveats (shared CESYS behavior, documented in full in cesys.ts):
 *   - `price_from.CZK` is per-person (adults:1 == adults:2 for the same master_id, verified live).
 *   - `discount_percent` is generally null → the (0,100) guard leaves claimed* null.
 *   - ⚠️ `sort:["discount desc"]` makes the server return HTTP 500 (verified live) → the factory
 *     hardcodes the safe `['price asc', 'date_from asc']` sort for every query.
 *   - ⚠️ Compliance (§9 / §16.4): firotravel.cz's robots.txt blocks ClaudeBot BY NAME → this
 *     adapter must NEVER send any Claude-identifying UA; it relies entirely on the project's
 *     standard Chrome UA (conscious deviation, same as dovolenkovani).
 */

const SITE_BASE_URL = 'https://www.firotravel.cz';
const CLIENT_ID = '12352';
const CUSTOMER_ID = '3593';
const FALLBACK_URL = 'https://www.firotravel.cz/vyhledavani-zajezdu/';

// Exotic CESYS country ids (global across clients, spec §16.1 row 11): Thajsko 220, Maledivy 131,
// Mauricius 138, SAE 198, Dominikánská 46, Mexiko 142, Seychely 192, Srí Lanka 215, Tanzanie 219,
// Kuba 112, Vietnam 239, Kapverdy 102.
const EXOTIKA_COUNTRY_IDS = ['220', '131', '138', '198', '46', '142', '192', '215', '219', '112', '239', '102'];

// Three profiles per scan, each issued once per price band (11 dates-list requests total — the
// cesys.ts budget allows 12). léto-moře + last-minute mirror dovolenkovani's two watch profiles;
// the third, exotika, is FIRO's reason for existing — a +270d window (exotic season is winter)
// with the server-side country_id filter AND the price ladder, without which the whole long-haul
// band is invisible. All flight-only, sorted price asc.
//
// Band edges are cheap-dense at the bottom (that is where a Mediterranean deal lives) and coarse
// at the top, ending just above each watch profile's max_price_per_person (config/watch.yaml:
// léto-moře 25k, last-minute 20k, exotika 60k). exotika uses durationFrom 8, not 7: on long-haul
// supply the day→night offset is 2, so `from: 7` produced pages of 5-night rows that the
// minNights floor then threw away (measured 20 of 30).
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

export const firo = makeCesysAdapter({
  name: 'firo',
  siteBaseUrl: SITE_BASE_URL,
  clientId: CLIENT_ID,
  customerId: CUSTOMER_ID,
  fallbackUrl: FALLBACK_URL,
  queries: QUERIES,
});
