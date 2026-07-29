import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const API_BASE_URL = 'https://api-ng.cesys.eu/online/v1.4/cs';
// rows_on_page is honored up to at least 200 (verified live 2026-07-29) at NO extra latency —
// 40 is a deliberate self-limit, not an API ceiling: 11 bands x 40 rows lands the source in the
// project's 200-500 offers/scan target instead of the ~2,200 rows the same 11 requests could
// pull. Raise it only together with the DB write-volume budget.
const ROWS_ON_PAGE = 40;
// Politeness ceiling: at most 2 accommodation-sitemap shards are fetched even if the index
// lists more (budget math in the header comment already counts exactly 2).
const MAX_ACCOMMODATION_SITEMAPS = 2;
// HARD REQUEST BUDGET (src/core/run.ts ADAPTER_FETCH_TIMEOUT_MS = 240s; HttpClient enforces a 3s
// gap per host). A storefront run spends at most:
//   1 sitemap index + 2 shards + 1 mapping/countries + MAX_DATES_LIST_REQUESTS + MAX_NAME_LOOKUPS
//   = 3 + 1 + 12 + 26 = 42 requests. Measured end-to-end 2026-07-29 with BOTH storefronts
//   running concurrently on one HttpClient (as src/cli/scan.ts does): 111s / 122s per adapter,
//   41 requests each, ~120s of margin under the 240s timeout.
// ⚠️ api-ng.cesys.eu is SHARED between the CESYS storefronts, which run concurrently against one
// HttpClient — the ladder's wall clock is therefore roughly DOUBLE this adapter's own dates-list
// time. That, not the request count, is why the ladder is 11 bands and not 16.
// Measured live 2026-07-29: dates-list latency scales with the band's candidate-set size (0.5s for
// a narrow cheap band, ~12s for the 42-62k exotika band), so the 12-request cap is the real
// safety valve, not the count alone. An adapter that overruns 240s is recorded 'failed' and the
// whole source drops off the board — strictly worse than partial coverage, so these caps are
// enforced in code (extra bands are dropped with a log line) rather than left to config
// discipline.
export const MAX_DATES_LIST_REQUESTS = 12;
// Politeness ceiling on per-hotel detail-page redirect lookups (see header comment: the sitemap
// covers 168 hotels on FIRO and only 3 on dovolenkovani, so most master_ids need this fallback).
// 26 distinct hotels per scan run; the rest keep the "Hotel <id>" fallback for this run but still
// get a working per-hotel URL, and they resolve over the following runs via `ctx.priorTitles`.
export const MAX_NAME_LOOKUPS = 26;
// WALL-CLOCK ceiling on the hotel-enrichment tail, complementing MAX_NAME_LOOKUPS' count ceiling.
// A bounded COUNT is not a bounded DURATION: a storefront that tarpits our IP (the documented
// datacenter-IP failure mode — GitHub Actions runners get this treatment) answers neither quickly
// nor with a 403, so SourceBlockedError never fires and each lookup burns HttpClient's full retry
// chain (3 x 25s REQUEST_TIMEOUT_MS + 2.5s backoff + the 3s host gap ≈ 80s). 26 of those is ~35
// minutes. By then the ladder's offers are already in hand, so without this guard the adapter
// would blow ADAPTER_FETCH_TIMEOUT_MS and be recorded 'failed' — trading ~410 real offers for a
// blank board, purely to finish fetching cosmetic titles.
// 150s + one worst-case in-flight lookup (~80s) stays inside the 240s ceiling. The measured
// healthy run completes everything in ~120s, so this never engages in normal operation.
export const ENRICHMENT_DEADLINE_MS = 150_000;

/**
 * Shared factory for CESYS white-label storefronts. CESYS (api-ng.cesys.eu) is a booking
 * platform many Czech travel agencies white-label under their own domain: the storefront domain
 * (e.g. dovolenkovani.cz, www.firotravel.cz) serves the SSR pages + sitemaps, while pricing and
 * availability come from the shared third-party CESYS API keyed by a per-storefront `client_id`
 * / `customer_id`. Every storefront behaves identically apart from those ids, its own domain, and
 * (optionally) its detail-page URL shape — so `makeCesysAdapter(opts)` instantiates one adapter
 * per storefront and every behavior below is shared. Live investigation 2026-07-07 (spec §3
 * row 10 dovolenkovani, §16.1 row 11 FIRO):
 *
 * - `GET <siteBaseUrl>/sitemap.xml` (own host) is a sitemap *index* listing `pages.xml`,
 *   `accommodations.xml` and `am-accommodations.xml`. We fetch the index first and pull every
 *   `<loc>` matching /accommodations/i (currently the latter two) rather than hardcoding just
 *   `accommodations.xml`, so a future third `*-accommodations.xml` shard is picked up
 *   automatically. If the index fetch itself fails, we fall back to fetching
 *   `<siteBaseUrl>/accommodations.xml` directly (previous behavior) so hotel-name enrichment
 *   still degrades gracefully instead of going to zero.
 * - Each `accommodations.xml`-like sitemap is a small file mapping hotel codes like "6a" to a
 *   detail-page slug (e.g. `kalia-beach`). The trailing letter(s) after the numeric id are a
 *   CESYS-internal suffix we discard; the numeric prefix IS the `master_id` used by the CESYS
 *   API (confirmed live for dovolenkovani: code "6a" -> master_id 6 -> SSR detail page titled
 *   "Kalia Beach"). Live, `am-accommodations.xml` was empty (0 entries) and `accommodations.xml`
 *   had only 3 hotels — so hotel-name coverage from this source is inherently partial; most
 *   `master_id`s returned by dates-list fall back to "Hotel <id>", which is expected, not a
 *   parsing bug.
 * - `GET <API_BASE_URL>/mapping/countries?client_id=<clientId>&lang=cs` (third-party host)
 *   returns `{status, data:{country: {"<id>": "<name>"}}}`, e.g. `"48": "Egypt"`. Country ids on
 *   dates-list rows are only meaningful through this mapping — never surface the raw numeric id as
 *   `country`. The mapping is global across CESYS clients (a given numeric id means the same
 *   country for every storefront), which is why the exotika `country_id` filter list is shared.
 * - `POST <API_BASE_URL>/cesys/dates-list?client_id=<clientId>&lang=cs` (third-party host, no
 *   auth required, verified live via curl) accepts a JSON body and works cross-hotel (no
 *   `hotel_id`/`master_id` filter parameter was found to actually narrow results during live
 *   probing — every attempted filter param was silently ignored by the API), returning
 *   `{status, data:{results, more_exists, dates:[...]}}`. The optional `country_id: ["<id>",…]`
 *   body field DOES filter server-side (verified live against FIRO: `country_id:["131"]` returns
 *   only Maledivy rows) — this is what the exotika query uses to pull long-haul destinations.
 *   ⚠️ `sort:["discount desc"]` makes the server return HTTP 500 (verified live, FIRO) — only
 *   price/date_from sorts are safe, so `sort` is hardcoded to `['price asc', 'date_from asc']`
 *   for every query and no storefront may request a discount sort.
 *
 * ⚠️ THE PRICE LADDER — why every query is a list of narrow price bands (live recon 2026-07-29,
 * the fix for the audited "exotika returns 1 of its 12 countries" defect):
 *   `sort:['price asc']` is NOT globally correct once the candidate set is large. The shipped
 *   exotika body (12 country ids, `price:{from:0,to:999999}`) reported results=7,598,906 and came
 *   back as 30 rows of ONE hotel (master 6564, Sheraton Jumeirah, SAE, 19,975+ CZK) — no
 *   Thailand/Maldives/Mexico/… at all, and not even SAE's own cheapest rows. Above roughly 10^6
 *   candidates the backend stops returning a globally price-ordered head; each page is internally
 *   ascending but drawn from a single master_id. Narrowing the country list does NOT fix it
 *   (`country_id:["198"]` alone still reported 1.24M candidates and still missed the true cheapest
 *   SAE row), and neither does `price.from` alone (`from:1, to:999999` → 3 hotels, 21,440+).
 *   What DOES fix it, reproducibly, is bounding the price window on BOTH ends so the band's
 *   candidate set stays small. Same 12-id exotika body, `rows_on_page:200`, measured 2026-07-29:
 *       price 0-16,000     → 200 rows,  26 hotels,  3 countries, 11,690-15,080 CZK, 0.6s
 *       price 16,000-22,000→ 200 rows,  28 hotels,  2 countries, 16,000-16,190 CZK, 3.0s
 *       price 22,000-30,000→ 200 rows,  48 hotels,  2 countries, 22,000-22,020 CZK, 9.5s
 *       price 30,000-42,000→ 200 rows,  55 hotels,  5 countries, 30,000-30,021 CZK, 12.5s
 *       price 42,000-62,000→ 200 rows,  62 hotels, 10 countries, 42,000-42,027 CZK, 12.5s
 *   i.e. each band returns the CHEAPEST rows at its own floor, so the ladder is a stratified
 *   cheapest-first sample of the whole price spectrum instead of one collapsed head. Note the
 *   latency column: it tracks the band's candidate-set size, which is why `MAX_DATES_LIST_REQUESTS`
 *   exists and why no band is left open-ended at 999999.
 *   Band tops are chosen just above the matching watch profile's `max_price_per_person`
 *   (config/watch.yaml: léto-moře 25k, last-minute 20k, exotika 60k) — fetching far above the cap
 *   buys nothing and is the slowest part of the ladder.
 *
 * Query-quality probe results (live, 2026-07-07, ≤3 dates-list requests spent on dovolenkovani),
 * driven by the finding that the original léto-moře query (duration 1-21, no boarding filter)
 * returned mostly short 2-5 night stays at a single cheap hotel (19/30 rows):
 *   - Probe A: `duration: {from: 6, to: 15}`, no `boarding_id`. Result: 4 distinct master_id
 *     (17/7/5/1 rows), duration_night spread 5-11, boarding mixed (Ultra all inclusive,
 *     All inclusive, Snídaně/breakfast). VERDICT: **duration filters server-side** — it works,
 *     but on the API's own `duration` field (calendar days spanning the trip), not
 *     `duration_night` directly; the two aren't a fixed offset apart (diff observed as 1 *or* 2
 *     nights depending on flight times), so `duration.from` alone does not strictly guarantee a
 *     `duration_night` floor (one row came back with `duration_night: 5` despite
 *     `duration.from: 6`).
 *   - Probe B: same duration window + `boarding_id: ["8","10","13"]` (the AI ids). Result: only
 *     2 distinct master_id (26/4 rows), duration_night spread narrowed to 4-7, boarding
 *     correctly restricted to Ultra/All inclusive only (no Snídaně leaked through). VERDICT:
 *     **boarding_id filters server-side too** — but it *reduces* hotel diversity further (2
 *     hotels vs 4) because price-asc sorting then concentrates on whichever single AI-boarded
 *     hotel is cheapest at each duration. Not adopted for léto-moře: it fights the diversity
 *     goal rather than helping it, and duration+price-sort already biases toward AI/UAI board
 *     types at longer stays without it.
 *   - ADOPTED for léto-moře-style queries: server-side `duration: {from: 7, to: 22}` (days) as a
 *     density pre-filter (biases the price-asc page toward longer stays / more distinct
 *     hotels, as in probe A), PLUS a client-side `duration_night >= minNights` post-filter in
 *     `fetchOffers` (the `minNights` field on the query) to make the invariant exact regardless
 *     of the API's loose duration/duration_night relationship. last-minute queries are left broad
 *     (duration 1-21, no floor) — short stays are the *point* of that profile.
 *   - LONG-HAUL CORRECTION (2026-07-29): on exotic supply the day→night offset is 2, not 1 (the
 *     first and last night are spent on the plane), so `duration.from: 7` used to hand back a page
 *     that was 20/30 `duration_night: 5` rows — all discarded by the `minNights: 6` floor. The
 *     exotika queries therefore use `duration.from: 8`; measured live, 200/200 rows then survive
 *     the floor in every band. Short-haul (léto-moře) keeps `from: 7`, where 95%+ survive.
 *
 * price_from.CZK per-person vs total (resolved empirically, Step 1):
 * - The SSR detail page for Kalia Beach (master_id 6) shows `od 11 290 Kč <b>/ osobu a
 *   pobyt</b>` (explicitly "per person and stay").
 * - A same-window adults:1 probe against Egypt flight+AI/breakfast packages returned prices in
 *   the same 12,000-15,000 CZK order of magnitude as the adults:2 default fixture (13,990-
 *   14,490 CZK) for similar duration/board combinations. If `price_from.CZK` were a *couple's
 *   total*, the solo (adults:1) total should be roughly half, not equal — it isn't. Confirmed
 *   again live for FIRO (adults:1 == adults:2 for the same master_id).
 * - Conclusion: `price_from.CZK` is PER-PERSON. Mapped directly to `pricePerPerson`. The raw
 *   payload DOES carry a `price_total` field, but it was null on every row observed live —
 *   so `priceTotal` is left null (nothing honest to map), not because the field is absent.
 *
 * discount_percent was null on every row observed in the live fixture — guarded per spec: only
 * accepted as a real claimed discount when `0 < pct < 100`; `claimedOriginalPrice` is then
 * back-computed from `pricePerPerson / (1 - pct/100)`. Anything outside that range (including the
 * all-null common case) leaves both fields null, matching every other adapter's "nothing honest
 * to compute" convention.
 *
 * `transport_id: 1` is used directly as the query filter ("Letecká"/flight) per the brief; on
 * the response side transport is mapped straight to 'flight' when `transport_id === 1` (no
 * ambiguity — this is CESYS's own canonical flight code, not free text), falling back to
 * `normalizeTransport(transport)` for any other transport_id so non-flight rows (buses, own
 * transport) still classify correctly if a query ever returns them.
 *
 * Per compliance (§9 / spec §16.4): some storefronts' robots.txt block ClaudeBot BY NAME
 * (dovolenkovani.cz and www.firotravel.cz both do), so this factory must NEVER send any
 * Claude-identifying UA — it relies entirely on the project's standard Chrome UA (HttpClient's
 * default). api-ng.cesys.eu is a third-party internal API with no robots.txt of its own; using
 * it is a conscious §9 deviation.
 *
 * Per-offer URL (audited defect: every offer used to land on the generic search form). The
 * dates-list row carries no URL, but `<siteBaseUrl>/detail-zajezdu/x/<master_id>a` is itself a
 * working per-hotel link — CESYS routes purely on the numeric id and 301s to the canonical
 * `/detail-zajezdu/<…>/<slug>/<id>a`. So EVERY offer now gets that deep link at zero request cost,
 * and the `fallbackUrl` search page is only used when a storefront supplies no detail-path shape.
 * Hotels that also get a detail-page lookup (below) are upgraded to the canonical URL, read from
 * the page's `<link rel="canonical">` / ld+json `url` — `HttpClient.text()` discards
 * `response.url`, so the canonical must come out of the HTML itself.
 *
 * `locality` comes from the same ld+json block (`address.addressLocality`, e.g. "Dubaj" for
 * master 6564, "Burgas" for 185781). It is therefore populated only for hotels that got a detail
 * lookup this run — partial by construction, never guessed. The row's own `destination` id cannot
 * substitute: `GET /mapping/destinations` is HTTP 404 on this API (re-verified 2026-07-29), as is
 * `/mapping/accommodations`, so there is no bulk id→name/locality source at all.
 *
 * Hotel id -> name resolution (most master_ids show "Hotel <id>" because the sitemap lists 168
 * hotels on FIRO and 3 on dovolenkovani, against ~200-300 distinct master_ids per scan). Sources
 * are merged, cheapest first:
 *   1. `accommodations.xml` / `am-accommodations.xml` sitemap slugs (see above) — free, but
 *      covers only a handful of hotels live.
 *   2. `ctx.priorTitles` (spec: feed prior titles to avoid re-lookup) — free, no network cost.
 *   3. Per-hotel detail-page redirect: `GET <siteBaseUrl><detailPath(master_id)>` (default path
 *      `/detail-zajezdu/x/<master_id>a`, any dummy slug works) 301-redirects to the canonical
 *      `/detail-zajezdu/<real-slug>/<master_id>a` URL, whose page contains the real hotel name
 *      both in a `<script type="application/ld+json">` `LodgingBusiness.name` and in the page's
 *      `<h1>` (verified live 2026-07-07, e.g. dovolenkovani master_id 320645 -> "Creek Hotel &
 *      Residences El Gouna"). `HttpClient.text` follows redirects via fetch's default
 *      `redirect: 'follow'`, so a plain `ctx.http.text(url)` call is enough.
 *      `parseHotelDetail` extracts name (ld+json preferred, `<h1>` fallback), canonical URL and
 *      locality. After building offers, `fetchOffers` collects the distinct master_ids still on
 *      the numeric "Hotel <id>" fallback and resolves up to `MAX_NAME_LOOKUPS` (26) of them this
 *      way. Lookups are queued band by band as offers arrive, so the cheapest bands' hotels get
 *      named first — the right priority for a deals board, and it lets the lookups overlap the
 *      remaining dates-list requests instead of running after them. A failed
 *      lookup (network error, no name found) is not fatal: that hotel keeps the "Hotel <id>"
 *      fallback plus its `/detail-zajezdu/x/<id>a` link and the loop continues. A
 *      `SourceBlockedError` from a lookup stops further lookups for this run (politeness) but
 *      keeps everything resolved so far. Hotels beyond the cap are logged as skipped; they
 *      typically resolve on a later run via `ctx.priorTitles`. Storefronts whose detail-redirect
 *      URL differs from the default shape pass an explicit `detailPathTemplate` in opts.
 * Merge order per hotel: sitemap name > prior-title > redirect-resolved name > "Hotel <id>".
 *
 * Request budget per storefront (see MAX_DATES_LIST_REQUESTS): 1 sitemap index + up to 2
 * accommodation shards + 1 countries + up to 12 dates-list (query × price band) + up to 26
 * detail-page lookups = 42 max, every term a compile-time constant — nothing here loops on a
 * site-reported `results`/`more_exists` total, and `page` is pinned to 1. The count bound is not
 * on its own enough to keep the run inside ADAPTER_FETCH_TIMEOUT_MS, because a tarpitting host
 * makes each request cost ~80s rather than ~4s; `ENRICHMENT_DEADLINE_MS` supplies the matching
 * wall-clock bound on the one phase that is pure enrichment. The detail lookups run CONCURRENTLY with the dates-list ladder
 * (different host, independent politeness queue), so they cost almost no extra wall clock. Measured end-to-end 2026-07-29 well inside the 240s
 * ADAPTER_FETCH_TIMEOUT_MS. The detail lookups are same-host as the sitemap, so HttpClient's
 * per-host politeness gap (3s default) applies between them; the dates-list POSTs sit on the
 * separate api-ng host.
 */

interface CesysPriceFrom {
  CZK?: number | null;
}

interface CesysTourOperator {
  name?: string | null;
}

interface CesysDateRow {
  master_id?: number | string | null;
  name?: number | string | null;
  date_from?: string | null;
  date_to?: string | null;
  duration_night?: number | null;
  boarding?: string | null;
  boarding_id?: number | string | null;
  transport?: string | null;
  transport_id?: number | string | null;
  airport?: string | null;
  airport_code?: string | null;
  price_from?: CesysPriceFrom | null;
  discount?: number | null;
  discount_percent?: number | null;
  country?: number | string | null;
  destination?: number | string | null;
  rating?: number | null;
  tour_operator?: CesysTourOperator | null;
  last_minute?: boolean | null;
  package_id?: number | string | null;
}

interface CesysDatesListResponse {
  status?: string;
  data?: {
    results?: number;
    more_exists?: boolean;
    dates?: CesysDateRow[];
  };
}

export interface CesysCountriesResponse {
  status?: string;
  data?: {
    country?: Record<string, string>;
  };
}

export interface HotelInfo {
  name: string;
  url: string;
}

/** What a detail page yields beyond the hotel name: its canonical URL and its locality. */
export interface HotelDetail {
  name: string | null;
  url: string | null;
  locality: string | null;
}

/**
 * Everything `mapRow`/`parseCesysDates` need beyond the raw row: the resolved hotel + country
 * maps, plus the per-storefront `source` tag and `fallbackUrl` (used when a master_id has no
 * resolved detail URL). Parameterizing source/fallbackUrl here is what makes the pure mappers
 * storefront-agnostic.
 */
export interface CesysMaps {
  hotels: Map<number, HotelInfo>;
  countries: CesysCountriesResponse;
  source: string;
  fallbackUrl: string;
  /** Builds the storefront's per-hotel deep link from a master_id (the `/detail-zajezdu/x/<id>a`
   * redirect shape). When absent, offers of unknown hotels fall back to `fallbackUrl`. */
  detailUrlFor?: (masterId: number) => string;
}

/**
 * One price band of the ladder — a dates-list request with `price:{from,to}`. Both ends are
 * always bounded: an open-ended band is exactly the shape that makes the server's price-asc head
 * collapse onto a single hotel (see the header comment's PRICE LADDER section).
 */
export interface PriceBand {
  from: number;
  to: number;
}

/** One dates-list query (one watch profile), issued once per price band. */
export interface DatesListQuery {
  label: string;
  fromDays: number;
  toDays: number;
  durationFrom: number;
  durationTo: number;
  /** Client-side floor on duration_night, enforced after parsing (see header comment: the
   * API's `duration` param filters loosely and does not guarantee this on its own). Undefined
   * means "no floor" (last-minute query, where short stays are the point). */
  minNights?: number;
  /** Optional server-side country filter -> body `country_id: [...]`. Undefined/empty means no
   * country filter (the whole catalogue). Used by the exotika query to pull long-haul rows. */
  countryIds?: string[];
  /** The price ladder for this profile: one request per band, cheapest-first inside each band.
   * Bands must be ordered and non-overlapping; the top band's `to` should sit just above the
   * matching watch profile's max_price_per_person. */
  priceBands: PriceBand[];
}

/** Per-storefront configuration for {@link makeCesysAdapter}. */
export interface CesysStorefrontOpts {
  /** Source tag + log prefix (e.g. 'dovolenkovani', 'firo'). */
  name: string;
  /** Storefront domain root, no trailing slash (e.g. 'https://www.firotravel.cz'). */
  siteBaseUrl: string;
  /** CESYS API client_id for this storefront. */
  clientId: string;
  /** CESYS API customer_id for this storefront. */
  customerId: string;
  /** URL used for an offer whose master_id has no resolved detail-page URL. */
  fallbackUrl: string;
  /** The dates-list queries to issue per scan (one per watch profile). */
  queries: DatesListQuery[];
  /** Detail-redirect path builder for hotel-name lookups; defaults to the dovolenkovani shape
   * `/detail-zajezdu/x/<id>a`. Return a path (leading slash) appended to `siteBaseUrl`. */
  detailPathTemplate?: (id: number) => string;
}

const DEFAULT_DETAIL_PATH_TEMPLATE = (id: number): string => `/detail-zajezdu/x/${id}a`;

function round(n: number): number {
  return Math.round(n);
}

/** Title-cases a URL slug: "kalia-beach" -> "Kalia Beach". */
function titleCaseFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Parses `accommodations.xml` (a plain sitemap.xml) into a map of hotel id -> {name, url}.
 * Pure function: no I/O. URLs end in `.../detail-zajezdu/<…>/<slug>/<code>`, where `<code>` is a
 * numeric hotel id followed by a CESYS-internal letter suffix (e.g. "6a" -> id 6) and `<slug>` is
 * the last path segment before the code. The number of segments between `detail-zajezdu` and the
 * code varies per storefront — dovolenkovani uses one (`/detail-zajezdu/kalia-beach/6a`) while
 * FIRO prefixes a country segment (`/detail-zajezdu/recko/porto-elounda-.../4a`, verified live
 * 2026-07-07) — so the pattern skips any number of leading segments and always takes the segment
 * immediately before the numeric code as the slug (byte-identical result for the single-segment
 * shape). Rows whose `<loc>` doesn't match are silently skipped (not fatal — this map degrades to
 * "Hotel <id>" fallback for any master_id not present here, by design).
 */
export function parseAccommodationsSitemap(xml: string): Map<number, HotelInfo> {
  const map = new Map<number, HotelInfo>();

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    return map;
  }

  $('url > loc').each((_, el) => {
    const url = $(el).text().trim();
    if (!url) return;
    const match = url.match(/\/detail-zajezdu\/(?:[^/]+\/)*([^/]+)\/(\d+)[A-Za-z]*\/?$/);
    if (!match) return;
    const [, slug, idRaw] = match;
    const id = Number(idRaw);
    if (!Number.isFinite(id)) return;
    map.set(id, { name: titleCaseFromSlug(slug!), url });
  });

  return map;
}

/**
 * Parses a sitemap *index* (`<sitemapindex><sitemap><loc>...`) and returns every `<loc>` whose
 * URL matches /accommodations/i — currently `accommodations.xml` and `am-accommodations.xml`,
 * but written to also pick up any future `*-accommodations.xml` shard without a code change.
 * Pure function: no I/O. Malformed/empty XML yields an empty array (caller falls back to the
 * direct `accommodations.xml` URL).
 */
export function extractAccommodationSitemapUrls(xml: string): string[] {
  const urls: string[] = [];

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    return urls;
  }

  $('sitemap > loc').each((_, el) => {
    const url = $(el).text().trim();
    if (!url) return;
    if (/accommodations/i.test(url)) urls.push(url);
  });

  return urls;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Extracts name + canonical URL + locality from a `detail-zajezdu/<slug>/<id>a` detail page
 * (reached via the 301 redirect described in the header comment). Prefers a
 * `<script type="application/ld+json">` block whose `@type` contains "Lodging" (e.g.
 * `LodgingBusiness`), which carries all three (`name`, `url`, `address.addressLocality`); falls
 * back to the first `<h1>` for the name and to `<link rel="canonical">` / `og:url` for the URL.
 * Names go through cheerio's `.text()`, which decodes HTML entities (`&amp;` -> `&`).
 *
 * The canonical URL has to be read out of the HTML because `HttpClient.text()` returns only the
 * body and drops `response.url`, so the 301 target is otherwise unobservable.
 *
 * Pure function: no I/O. Every field is independently nullable — a page that yields nothing at
 * all returns all-null rather than throwing.
 */
export function parseHotelDetail(html: string): HotelDetail {
  const empty: HotelDetail = { name: null, url: null, locality: null };
  if (!html || !html.trim()) return empty;

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return empty;
  }

  let ldName: string | null = null;
  let ldUrl: string | null = null;
  let ldLocality: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (ldName) return; // first Lodging block wins
    const raw = $(el).text();
    if (!raw || !raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as {
        '@type'?: unknown;
        name?: unknown;
        url?: unknown;
        address?: { addressLocality?: unknown } | null;
      };
      const type = parsed['@type'];
      const typeStr = Array.isArray(type) ? type.join(' ') : String(type ?? '');
      if (!/Lodging/i.test(typeStr)) return;
      const name = nonEmpty(parsed.name);
      if (!name) return;
      ldName = name;
      ldUrl = nonEmpty(parsed.url);
      ldLocality = nonEmpty(parsed.address?.addressLocality);
    } catch {
      // malformed JSON in this block: ignore and keep looking / fall back to <h1>
    }
  });

  const name = ldName ?? nonEmpty($('h1').first().text());
  const url =
    ldUrl ??
    nonEmpty($('link[rel="canonical"]').attr('href')) ??
    nonEmpty($('meta[property="og:url"]').attr('content'));

  return { name, url, locality: ldLocality };
}

/**
 * Back-compatible name-only wrapper over {@link parseHotelDetail} (kept because storefront
 * modules re-export it and it is the narrow contract most call sites want).
 */
export function parseHotelNameFromDetail(html: string): string | null {
  return parseHotelDetail(html).name;
}

function resolveCountry(countryId: CesysDateRow['country'], countries: CesysCountriesResponse): string | null {
  if (countryId === null || countryId === undefined) return null;
  const raw = countries.data?.country?.[String(countryId)];
  return isKnownCountry(raw) ? normalizeCountry(raw) : null;
}

function resolveTransport(row: CesysDateRow): 'flight' | 'own' | 'bus' | 'unknown' {
  const transportId = row.transport_id;
  if (transportId === 1 || transportId === '1') return 'flight';
  return normalizeTransport(row.transport ?? null);
}

function mapRow(row: CesysDateRow, maps: CesysMaps): NormalizedOffer | null {
  const masterId = row.master_id;
  if (masterId === null || masterId === undefined) return null;

  const priceRaw = row.price_from?.CZK;
  if (typeof priceRaw !== 'number' || !(priceRaw > 0)) return null;
  const pricePerPerson = round(priceRaw);

  const departureDate = row.date_from ?? null;
  const nights = typeof row.duration_night === 'number' ? row.duration_night : null;
  if (!departureDate || nights === null) return null;

  const hotelInfo = maps.hotels.get(Number(masterId));
  const title = hotelInfo?.name ?? `Hotel ${masterId}`;
  // Even an unknown hotel gets a real per-hotel link: /detail-zajezdu/x/<id>a 301s to the
  // canonical page. The generic search form is a last resort, not the default.
  const url = hotelInfo?.url ?? maps.detailUrlFor?.(Number(masterId)) ?? maps.fallbackUrl;

  const country = resolveCountry(row.country, maps.countries);
  const board = normalizeBoard(row.boarding ?? null);
  const transport = resolveTransport(row);

  const discountPct = row.discount_percent;
  const validDiscount = typeof discountPct === 'number' && discountPct > 0 && discountPct < 100;
  const claimedDiscountPct = validDiscount ? Math.round(discountPct as number) : null;
  const claimedOriginalPrice = validDiscount
    ? round(pricePerPerson / (1 - (discountPct as number) / 100))
    : null;

  const stars = typeof row.rating === 'number' && row.rating > 0 ? row.rating : null;
  const tourOperator = row.tour_operator?.name ?? null;

  // departureAirport and tourOperator are part of the identity: the same hotel/date/nights/board
  // really is sold as separate products from PRG vs VIE (measured: 13 of 20 dedupe collisions in
  // one live run differed ONLY by airport_code) and by competing operators at different prices.
  // Without them the cheaper row silently swallowed the others, and a price shift between two
  // airports read as a price change on one offer rather than two distinct products.
  const sourceOfferKey = offerKeyHash([
    masterId,
    departureDate,
    nights,
    row.boarding_id,
    row.airport_code ?? null,
    row.tour_operator?.name ?? null,
  ]);

  return {
    source: maps.source,
    sourceOfferKey,
    title,
    country,
    locality: null,
    stars,
    board,
    transport,
    departureAirport: row.airport_code ?? null,
    departureDate,
    nights,
    pricePerPerson,
    priceTotal: null,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator,
    url,
  };
}

/**
 * Maps a `dates-list` API response to NormalizedOffer[], resolving hotel names/URLs and
 * country ids via the provided maps (which also carry the storefront `source` tag and
 * `fallbackUrl`). Pure function: no I/O. Dedupes by `sourceOfferKey`, keeping the first
 * occurrence.
 */
export function parseCesysDates(payload: unknown, maps: CesysMaps): NormalizedOffer[] {
  const dates = (payload as CesysDatesListResponse | undefined)?.data?.dates;
  if (!Array.isArray(dates)) return [];

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const row of dates) {
    const offer = mapRow(row, maps);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }

  return offers;
}

/**
 * LOCAL calendar date, not `toISOString()` — the latter is UTC, so a scan running between 00:00
 * and 02:00 CEST used to ask for `date.from` = yesterday and pull already-departed rows.
 */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildDatesListBody(
  query: DatesListQuery,
  band: PriceBand,
  clientId: string,
  customerId: string,
  adults: number,
): string {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() + query.fromDays);
  const to = new Date(today);
  to.setDate(to.getDate() + query.toDays);

  const body: Record<string, unknown> = {
    page: 1,
    date: { from: isoDate(from), to: isoDate(to) },
    duration: { from: query.durationFrom, to: query.durationTo },
    composition: { adults, children: [] },
    // Bounded on BOTH ends on purpose — see the PRICE LADDER section of the header comment.
    price: { from: band.from, to: band.to },
    transport_id: ['1'],
    rows_on_page: ROWS_ON_PAGE,
    // NEVER 'discount desc' — that sort makes the CESYS server return HTTP 500 (verified live,
    // FIRO). Only price/date_from sorts are safe.
    sort: ['price asc', 'date_from asc'],
    client_id: clientId,
    customer_id: customerId,
  };
  // Only add country_id when a query actually filters by country — this keeps a no-country query
  // (e.g. dovolenkovani's léto-moře/last-minute) byte-identical to its pre-factory body.
  if (query.countryIds && query.countryIds.length > 0) {
    body.country_id = query.countryIds;
  }

  return JSON.stringify(body);
}

/** One planned dates-list request: a profile query narrowed to one band of its price ladder. */
interface PlannedRequest {
  query: DatesListQuery;
  band: PriceBand;
}

/**
 * Flattens `queries × priceBands` into the request plan, enforcing `MAX_DATES_LIST_REQUESTS`.
 * The cap is enforced here rather than trusted to the storefront configs so that adding a band
 * to firo.ts/dovolenkovani.ts can never silently push the adapter past the 240s run timeout.
 * Exported for the budget test.
 */
export function planDatesListRequests(queries: DatesListQuery[]): {
  plan: PlannedRequest[];
  dropped: number;
} {
  const plan: PlannedRequest[] = [];
  for (const query of queries) {
    for (const band of query.priceBands) {
      plan.push({ query, band });
    }
  }
  const dropped = Math.max(0, plan.length - MAX_DATES_LIST_REQUESTS);
  return { plan: plan.slice(0, MAX_DATES_LIST_REQUESTS), dropped };
}

/**
 * Loads the sitemap-derived hotel map. Best-effort: every failure degrades to a smaller (or
 * empty) map and is logged, never thrown — hotel-name enrichment is not worth failing a source
 * over. Split out of `fetchOffers` so it can run concurrently with the api-host requests (a
 * different host, therefore a different HttpClient politeness queue).
 */
async function loadSitemapHotels(
  ctx: SourceContext,
  opts: CesysStorefrontOpts,
): Promise<Map<number, HotelInfo>> {
  const hotels = new Map<number, HotelInfo>();
  let accommodationUrls: string[] = [];
  try {
    const indexXml = await ctx.http.text(`${opts.siteBaseUrl}/sitemap.xml`);
    accommodationUrls = extractAccommodationSitemapUrls(indexXml).slice(0, MAX_ACCOMMODATION_SITEMAPS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`${opts.name}: sitemap.xml index fetch failed (${message}), falling back to accommodations.xml directly`);
  }

  if (accommodationUrls.length === 0) {
    // Either the index fetch failed, or it parsed to zero matching <loc> entries (e.g.
    // malformed/unexpected index shape) — either way, fall back to the previously known-good
    // direct URL rather than giving up on hotel enrichment entirely.
    accommodationUrls = [`${opts.siteBaseUrl}/accommodations.xml`];
  }

  for (const url of accommodationUrls) {
    try {
      const xml = await ctx.http.text(url);
      for (const [id, info] of parseAccommodationsSitemap(xml)) {
        hotels.set(id, info);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`${opts.name}: accommodation sitemap fetch failed for ${url} (${message}), skipping`);
    }
  }

  return hotels;
}

async function fetchOffers(ctx: SourceContext, opts: CesysStorefrontOpts): Promise<NormalizedOffer[]> {
  // Anchor the enrichment deadline to the adapter's own start, not to the resolver's construction:
  // the sitemap/countries phase below is itself on the clock that ADAPTER_FETCH_TIMEOUT_MS measures.
  const startedAt = Date.now();
  // Sitemap (storefront host) and mapping/countries (api-ng host) sit on independent HttpClient
  // politeness queues, so running them together costs the slower of the two instead of the sum.
  // Both are best-effort enrichment: failure degrades to "Hotel <id>" titles / null country.
  const [hotels, countries] = await Promise.all([
    loadSitemapHotels(ctx, opts),
    ctx.http
      .json<CesysCountriesResponse>(`${API_BASE_URL}/mapping/countries?client_id=${opts.clientId}&lang=cs`)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`${opts.name}: mapping/countries fetch failed (${message}), country will be null`);
        return {} as CesysCountriesResponse;
      }),
  ]);

  const detailPath = opts.detailPathTemplate ?? DEFAULT_DETAIL_PATH_TEMPLATE;
  const maps: CesysMaps = {
    hotels,
    countries,
    source: opts.name,
    fallbackUrl: opts.fallbackUrl,
    detailUrlFor: (masterId) => `${opts.siteBaseUrl}${detailPath(masterId)}`,
  };
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  const { plan, dropped } = planDatesListRequests(opts.queries);
  if (dropped > 0) {
    ctx.log(
      `${opts.name}: request budget — ${dropped} price band(s) dropped, capped at ${MAX_DATES_LIST_REQUESTS} dates-list requests`,
    );
  }

  // Hotel enrichment runs CONCURRENTLY with the dates-list ladder, not after it. The lookups hit
  // the storefront host while the ladder hits api-ng, so they occupy two independent politeness
  // queues; done sequentially they would simply add their ~2 minutes to the run. This matters
  // because api-ng is shared: firo and dovolenkovani scan concurrently against the SAME host, so
  // the ladder's wall clock is roughly double one adapter's own request time.
  const resolver = new HotelResolver(ctx, opts, startedAt + ENRICHMENT_DEADLINE_MS);

  for (const { query, band } of plan) {
    const label = `${query.label} ${band.from}-${band.to}`;
    let offers: NormalizedOffer[];
    try {
      const body = buildDatesListBody(query, band, opts.clientId, opts.customerId, ctx.adults);
      const res = await ctx.http.json<CesysDatesListResponse>(
        `${API_BASE_URL}/cesys/dates-list?client_id=${opts.clientId}&lang=cs`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      );
      offers = parseCesysDates(res, maps);
      if (query.minNights !== undefined) {
        // The API's `duration` filter is a loose pre-filter (see header comment): it biases
        // toward longer stays but doesn't guarantee duration_night >= minNights on every row,
        // so we enforce the real floor here.
        const minNights = query.minNights;
        offers = offers.filter((o) => o.nights !== null && o.nights >= minNights);
      }
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further requests (politeness) but keep
        // whatever offers the earlier bands already yielded. Record the block as lastError so a
        // block BEFORE the first success still trips the successCount===0 rethrow below (→ BLOCKED
        // marker → 24h backoff) instead of silently degrading to []. (A block hitting the
        // HotelResolver's own lookups is separate and correctly only stops enrichment.)
        lastError = err;
        ctx.log(`${opts.name}: query ${label} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`${opts.name}: query ${label} dates-list failed (${message}), skipping`);
      continue;
    }

    const fresh: NormalizedOffer[] = [];
    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
      fresh.push(offer);
    }
    // Hand this band's newly-seen hotels to the resolver; once it has heard from two profiles it
    // looks them up on the storefront queue while later bands are still in flight on api-ng.
    resolver.observe(query.label, fresh);
  }

  if (successCount === 0 && lastError !== undefined) {
    // ALL dates-list queries failed: this is not "market empty", it means we saw nothing
    // because every request failed. Rethrow (fischer pattern) so runScan records this source
    // as 'failed' rather than silently degrading to [] (which would eventually flip every
    // known offer inactive and mute the 3x-failed health alert). Settle the enrichment chain
    // first so no lookup keeps running after fetchOffers has returned.
    await resolver.finish();
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`${opts.name}: all dates-list queries failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  await resolver.finish();
  resolver.applyTo(all);

  ctx.log(`${opts.name}: fetched ${all.length} offers across ${plan.length} dates-list requests`);
  return all;
}

/** Matches the numeric fallback title assigned in `mapRow` ("Hotel <id>"), capturing the id. */
const FALLBACK_TITLE_RE = /^Hotel (\d+)$/;

/** master_id of an offer still on the "Hotel <id>" fallback title, or null if it is named. */
function fallbackTitleId(title: string): number | null {
  const match = title.match(FALLBACK_TITLE_RE);
  return match ? Number(match[1]) : null;
}

/**
 * Fills in real hotel names (plus canonical URL and locality) for offers still on the numeric
 * "Hotel <id>" fallback, i.e. not covered by the sitemap. Two sources, cheapest first:
 *
 *   1. `ctx.priorTitles` (spec: feed prior titles to avoid re-lookup): a sourceOfferKey -> title
 *      map of this source's previously-resolved (non-placeholder) names, loaded by run.ts from
 *      the DB. The sourceOfferKey is per-TERM, not per-hotel, so it can't be reverse-mapped to a
 *      master_id directly. Instead every unresolved offer's own key is looked up; if ANY one of a
 *      hotel's terms has a matching prior title, that resolves the WHOLE hotel (master_id) for
 *      this run and spares it a detail-page lookup. This works because at least one prior term of
 *      a previously-seen hotel usually persists across runs (dates roll forward gradually), and
 *      it is how the long tail beyond `MAX_NAME_LOOKUPS` eventually gets named.
 *   2. Per-hotel detail-page redirect lookup for whatever step 1 missed, capped at
 *      `MAX_NAME_LOOKUPS` per run.
 *
 * `observe()` is called after each price band instead of once at the end, so the lookups (which
 * are I/O-bound on the storefront host's 3s politeness gap) overlap the remaining dates-list
 * requests on api-ng rather than being appended to them. Done sequentially they would add their
 * own ~2 minutes to a run that already spends ~2 minutes on the ladder, which does not fit the
 * 240s adapter timeout. Lookups are chained one at a time — HttpClient serializes them per host
 * anyway, and a chain keeps the cap accounting deterministic.
 *
 * The overlap has one cost, and `pendingBatches` is what pays it: a hotel's previously-stored
 * term may be excluded from the profile that happens to introduce that hotel (the profiles carry
 * different night floors and date windows — a 5-night term is invisible to léto-moře but present
 * in last-minute), so scheduling straight off the first band would burn lookups on hotels the DB
 * could have named for free. Batches are therefore held until at least TWO profiles have
 * reported, which is where prior-title coverage stops improving materially; from then on
 * scheduling is immediate and still has most of the ladder left to hide under.
 *
 * Everything here is best-effort: a failed lookup leaves that hotel on its "Hotel <id>" title and
 * its `/detail-zajezdu/x/<id>a` link, and never affects other hotels or fails the source. A
 * `SourceBlockedError` stops further lookups for the run (politeness) but keeps what was resolved.
 *
 * Because it is best-effort, enrichment must never be able to sink a successful ladder. Two
 * independent bounds enforce that: `MAX_NAME_LOOKUPS` (count) and `ENRICHMENT_DEADLINE_MS` (wall
 * clock). The second is the load-bearing one under failure — a tarpitting host returns no 403, so
 * the `blocked` flag never trips and each lookup instead burns HttpClient's full ~80s retry chain.
 * Past the deadline every remaining lookup resolves as a no-op, so `finish()` returns promptly and
 * the run keeps its offers instead of being killed by ADAPTER_FETCH_TIMEOUT_MS.
 */
class HotelResolver {
  private readonly ctx: SourceContext;
  private readonly opts: CesysStorefrontOpts;
  private readonly detailPath: (id: number) => string;
  private readonly names = new Map<number, string>();
  private readonly details = new Map<number, HotelDetail>();
  /** Hotels already handled (resolved from priorTitles, queued, or skipped over the cap). */
  private readonly claimed = new Set<number>();
  /** Batches held back until prior-title harvesting has seen more than one profile. */
  private pendingBatches: NormalizedOffer[][] = [];
  private readonly profilesSeen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private spent = 0;
  private skipped = 0;
  private blocked = false;
  /** Epoch ms after which no further lookup may START (see ENRICHMENT_DEADLINE_MS). */
  private readonly deadlineAt: number;
  private deadlineLogged = false;

  constructor(ctx: SourceContext, opts: CesysStorefrontOpts, deadlineAt: number) {
    this.ctx = ctx;
    this.opts = opts;
    this.detailPath = opts.detailPathTemplate ?? DEFAULT_DETAIL_PATH_TEMPLATE;
    this.deadlineAt = deadlineAt;
  }

  /**
   * True once the enrichment budget is spent. Checked both when queueing and again inside each
   * lookup, because the queue is built long before it drains — a chain scheduled while there was
   * still time must stop issuing requests the moment the deadline passes, not run to completion.
   */
  private pastDeadline(): boolean {
    if (Date.now() < this.deadlineAt) return false;
    if (!this.deadlineLogged) {
      this.deadlineLogged = true;
      this.ctx.log(
        `${this.opts.name}: hotel-name enrichment deadline (${ENRICHMENT_DEADLINE_MS}ms) reached, keeping "Hotel <id>" fallback for the rest — offers are unaffected`,
      );
    }
    return true;
  }

  /**
   * Feeds one price band's freshly-parsed offers in. `profile` is the owning query's label; once
   * two distinct profiles have reported, this and every later batch schedule lookups immediately.
   */
  observe(profile: string, offers: NormalizedOffer[]): void {
    this.harvestPriorTitles(offers);
    this.profilesSeen.add(profile);
    this.pendingBatches.push(offers);
    if (this.profilesSeen.size >= 2) this.flush();
  }

  /**
   * A hotel is resolved by any ONE of its terms carrying a prior title, and that term is rarely
   * the first row seen — so harvest across the whole batch before anything is scheduled.
   */
  private harvestPriorTitles(offers: NormalizedOffer[]): void {
    if (!this.ctx.priorTitles || this.ctx.priorTitles.size === 0) return;
    for (const offer of offers) {
      const id = fallbackTitleId(offer.title);
      if (id === null || this.names.has(id)) continue;
      const prior = this.ctx.priorTitles.get(offer.sourceOfferKey);
      if (prior) this.names.set(id, prior);
    }
  }

  /** Queues a lookup for every still-unnamed hotel the held batches introduced. */
  private flush(): void {
    const batches = this.pendingBatches;
    this.pendingBatches = [];
    for (const offers of batches) {
      for (const offer of offers) {
        const id = fallbackTitleId(offer.title);
        if (id === null || this.claimed.has(id)) continue;
        this.claimed.add(id);
        if (this.names.has(id)) continue; // resolved for free from a prior run

        if (this.spent >= MAX_NAME_LOOKUPS || this.blocked || this.pastDeadline()) {
          this.skipped += 1;
          continue;
        }
        this.spent += 1;
        this.chain = this.chain.then(() => this.lookup(id));
      }
    }
  }

  private async lookup(id: number): Promise<void> {
    // Re-checked here, not just at queue time: a tarpitting host stretches each lookup to ~80s, so
    // a chain that was well inside budget when it was built can run far past the adapter's ceiling
    // while draining. Past the deadline the remaining links resolve instantly as no-ops.
    if (this.blocked || this.pastDeadline()) {
      this.skipped += 1;
      return;
    }
    try {
      const html = await this.ctx.http.text(`${this.opts.siteBaseUrl}${this.detailPath(id)}`);
      const detail = parseHotelDetail(html);
      if (detail.name) this.names.set(id, detail.name);
      // URL/locality are worth keeping even when the name did not parse.
      if (detail.url || detail.locality) this.details.set(id, detail);
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        this.blocked = true;
        this.ctx.log(`${this.opts.name}: hotel-name detail-page lookup blocked (${err.message}), stopping further lookups`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.log(`${this.opts.name}: hotel-name detail-page lookup failed for id ${id} (${message}), keeping fallback`);
      // Not fatal: this hotel keeps its "Hotel <id>" fallback title, the chain continues.
    }
  }

  /** Flushes anything still held back, then waits for every scheduled lookup. Never rejects. */
  async finish(): Promise<void> {
    // A ladder that only ever reported one profile (every other query failed, or a single-profile
    // storefront) must still get its lookups.
    this.flush();
    await this.chain;
    if (this.skipped > 0) {
      // "cap" here means whichever budget bound first: the ${MAX_NAME_LOOKUPS}-lookup count, the
      // enrichment deadline, or a block. All three leave the offer itself intact and clickable.
      this.ctx.log(`${this.opts.name}: ${this.skipped} hotel(s) past the enrichment budget (${MAX_NAME_LOOKUPS} lookups / ${ENRICHMENT_DEADLINE_MS}ms) skipped this run, keeping "Hotel <id>" fallback`);
    }
  }

  /** Applies every resolved name / canonical URL / locality to the offers, in place. */
  applyTo(offers: NormalizedOffer[]): void {
    if (this.names.size === 0 && this.details.size === 0) return;
    for (const offer of offers) {
      const id = fallbackTitleId(offer.title);
      if (id === null) continue;
      const name = this.names.get(id);
      if (name) offer.title = name;
      const detail = this.details.get(id);
      if (!detail) continue;
      // Upgrade the /detail-zajezdu/x/<id>a redirect link to the canonical target, and fill in the
      // locality the ld+json block gave us for free.
      if (detail.url) offer.url = detail.url;
      if (detail.locality) offer.locality = detail.locality;
    }
  }
}

/** Builds a CESYS storefront adapter (dovolenkovani, firo, …) from per-storefront opts. */
export function makeCesysAdapter(opts: CesysStorefrontOpts): SourceAdapter {
  return {
    name: opts.name,
    fetchOffers: (ctx: SourceContext) => fetchOffers(ctx, opts),
  };
}
