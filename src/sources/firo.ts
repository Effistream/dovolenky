import { makeCesysAdapter, type DatesListQuery } from './cesys.js';

/**
 * FIRO Travel (www.firotravel.cz) — a second white-label storefront on the shared CESYS platform
 * (spec §16.1 row 11), instantiated via {@link makeCesysAdapter}. It is byte-for-byte the same
 * platform as dovolenkovani.ts with a different client_id/customer_id; all behavior lives in
 * cesys.ts. This adapter exists to give the project genuine exotic/long-haul coverage (Thailand,
 * Maldives, Mauritius, UAE, …) via a third `exotika` query that server-side-filters on the exotic
 * CESYS country ids. FIRO aggregates Coral Travel, Čedok, TUI, Fischer CK, Rainbow Tours.
 *
 * Live verification 2026-07-07 (curl, Chrome UA, ≥3s per-host gap — see task-35 report):
 *   (a) POST dates-list?client_id=12352 with customer_id 3593 → HTTP 200, status "success".
 *   (b) `country_id:["131"]` filters server-side: every returned row is country 131 (Maledivy).
 *       The exotika query passes the full exotic id list below; the CESYS country mapping is
 *       global across clients, so these ids match dovolenkovani's too.
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

// Three queries per scan. léto-moře + last-minute mirror dovolenkovani's two watch profiles; the
// third, exotika, is FIRO's reason for existing — a +270d window (exotic season is winter) with
// the server-side country_id filter, so the page is exotic long-haul rather than the cheapest
// Mediterranean rows. All flight-only, sorted price asc, 30 rows/page.
const QUERIES: DatesListQuery[] = [
  { label: 'leto-more', fromDays: 0, toDays: 60, durationFrom: 7, durationTo: 22, minNights: 6 },
  { label: 'last-minute', fromDays: 0, toDays: 14, durationFrom: 1, durationTo: 21 },
  { label: 'exotika', fromDays: 0, toDays: 270, durationFrom: 7, durationTo: 22, minNights: 6, countryIds: EXOTIKA_COUNTRY_IDS },
];

export const firo = makeCesysAdapter({
  name: 'firo',
  siteBaseUrl: SITE_BASE_URL,
  clientId: CLIENT_ID,
  customerId: CUSTOMER_ID,
  fallbackUrl: FALLBACK_URL,
  queries: QUERIES,
});
