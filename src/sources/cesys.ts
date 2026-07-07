import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const API_BASE_URL = 'https://api-ng.cesys.eu/online/v1.4/cs';
const ROWS_ON_PAGE = 30;
// Politeness ceiling: at most 2 accommodation-sitemap shards are fetched even if the index
// lists more (budget math in the header comment already counts exactly 2).
const MAX_ACCOMMODATION_SITEMAPS = 2;
// Politeness ceiling on per-hotel detail-page redirect lookups (see header comment: the
// sitemap only covers a handful of hotels, so most master_ids need this fallback). Capped at 40
// distinct hotels per scan run; any further unresolved hotels are logged as skipped and keep the
// "Hotel <id>" fallback for this run (they may resolve on a later run once revisited, or once
// the sitemap grows).
const MAX_NAME_LOOKUPS = 40;

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
 *     density pre-filter (biases the 30-row price-asc page toward longer stays / more distinct
 *     hotels, as in probe A), PLUS a client-side `duration_night >= minNights` post-filter in
 *     `fetchOffers` (the `minNights` field on the query) to make the invariant exact regardless
 *     of the API's loose duration/duration_night relationship. last-minute queries are left broad
 *     (duration 1-21, no floor) — short stays are the *point* of that profile.
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
 * Hotel id -> name resolution (most master_ids show "Hotel <id>" because the sitemap only lists a
 * handful of hotels). Two sources are merged, cheapest first:
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
 *      `parseHotelNameFromDetail` extracts the name (ld+json preferred, `<h1>` fallback). After
 *      building offers, `fetchOffers` collects the distinct master_ids still on the numeric
 *      "Hotel <id>" fallback and resolves up to `MAX_NAME_LOOKUPS` (40) of them this way,
 *      applying the resolved name to every offer for that hotel. A failed lookup (network error,
 *      no name found) is not fatal: that hotel simply keeps the "Hotel <id>" fallback and the
 *      loop continues. A `SourceBlockedError` from a lookup stops further lookups for this run
 *      (politeness) but keeps every name resolved so far. Any hotels beyond the 40-lookup cap are
 *      logged as skipped, not resolved this run. Storefronts whose detail-redirect URL differs
 *      from the default shape pass an explicit `detailPathTemplate` in opts.
 * Merge order per hotel: sitemap name > prior-title > redirect-resolved name > "Hotel <id>".
 *
 * Request budget per storefront: 1 sitemap index + up to 2 accommodation shards + 1 countries +
 * N dates-list (one per query) + up to `MAX_NAME_LOOKUPS` (40) detail-page lookups. The detail
 * lookups are same-host as the sitemap, so HttpClient's per-host politeness gap (3s default)
 * applies between them; at the project's 2h scan cadence this is a non-issue even at the
 * 40-lookup ceiling.
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
}

/** One dates-list query (one watch profile). */
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
 * Pure function: no I/O. URLs are expected in the shape
 * `<siteBaseUrl>/detail-zajezdu/<slug>/<code>`, where `<code>` is a numeric hotel id followed by
 * a CESYS-internal letter suffix (e.g. "6a" -> id 6). Rows whose `<loc>` doesn't match that shape
 * are silently skipped (not fatal — this map degrades to "Hotel <id>" fallback for any master_id
 * not present here, by design).
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
    const match = url.match(/\/detail-zajezdu\/([^/]+)\/(\d+)[A-Za-z]*\/?$/);
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

/**
 * Extracts the real hotel name from a `detail-zajezdu/<slug>/<id>a` detail page (reached via the
 * 301 redirect described in the header comment). Prefers a `<script type="application/ld+json">`
 * block whose `@type` contains "Lodging" (e.g. `LodgingBusiness`) -> `.name`; falls back to the
 * first `<h1>` element's text. Both sources are run through cheerio's `.text()`, which decodes
 * HTML entities (e.g. `&amp;` -> `&`). Pure function: no I/O. Returns null if neither source is
 * present, parsing fails, or the resolved name is empty/whitespace-only.
 */
export function parseHotelNameFromDetail(html: string): string | null {
  if (!html || !html.trim()) return null;

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  let ldJsonName: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (ldJsonName) return; // first match wins
    const raw = $(el).text();
    if (!raw || !raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as { '@type'?: unknown; name?: unknown };
      const type = parsed['@type'];
      const typeStr = Array.isArray(type) ? type.join(' ') : String(type ?? '');
      if (!/Lodging/i.test(typeStr)) return;
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (name) ldJsonName = name;
    } catch {
      // malformed JSON in this block: ignore and keep looking / fall back to <h1>
    }
  });

  if (ldJsonName) return ldJsonName;

  const h1Text = $('h1').first().text().trim();
  return h1Text ? h1Text : null;
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
  const url = hotelInfo?.url ?? maps.fallbackUrl;

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

  const sourceOfferKey = offerKeyHash([masterId, departureDate, nights, row.boarding_id]);

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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildDatesListBody(query: DatesListQuery, clientId: string, customerId: string): string {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() + query.fromDays);
  const to = new Date(today);
  to.setDate(to.getDate() + query.toDays);

  const body: Record<string, unknown> = {
    page: 1,
    date: { from: isoDate(from), to: isoDate(to) },
    duration: { from: query.durationFrom, to: query.durationTo },
    composition: { adults: 2, children: [] },
    price: { from: 0, to: 999999 },
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

async function fetchOffers(ctx: SourceContext, opts: CesysStorefrontOpts): Promise<NormalizedOffer[]> {
  const sitemapIndexUrl = `${opts.siteBaseUrl}/sitemap.xml`;
  const accommodationsXmlUrl = `${opts.siteBaseUrl}/accommodations.xml`;

  // Sitemap + country mapping are best-effort enrichment: failure here degrades gracefully to
  // "Hotel <id>" titles / null country, it is NOT fatal for the whole source.
  const hotels = new Map<number, HotelInfo>();
  let accommodationUrls: string[] = [];
  try {
    const indexXml = await ctx.http.text(sitemapIndexUrl);
    accommodationUrls = extractAccommodationSitemapUrls(indexXml).slice(0, MAX_ACCOMMODATION_SITEMAPS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`${opts.name}: sitemap.xml index fetch failed (${message}), falling back to accommodations.xml directly`);
  }

  if (accommodationUrls.length === 0) {
    // Either the index fetch failed, or it parsed to zero matching <loc> entries (e.g.
    // malformed/unexpected index shape) — either way, fall back to the previously known-good
    // direct URL rather than giving up on hotel enrichment entirely.
    accommodationUrls = [accommodationsXmlUrl];
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

  let countries: CesysCountriesResponse = {};
  try {
    countries = await ctx.http.json<CesysCountriesResponse>(
      `${API_BASE_URL}/mapping/countries?client_id=${opts.clientId}&lang=cs`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`${opts.name}: mapping/countries fetch failed (${message}), country will be null`);
  }

  const maps: CesysMaps = { hotels, countries, source: opts.name, fallbackUrl: opts.fallbackUrl };
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  for (const query of opts.queries) {
    let offers: NormalizedOffer[];
    try {
      const body = buildDatesListBody(query, opts.clientId, opts.customerId);
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
        // Site is actively blocking us: stop issuing further queries (politeness) but keep
        // whatever offers the earlier query already yielded.
        ctx.log(`${opts.name}: query ${query.label} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`${opts.name}: query ${query.label} dates-list failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // ALL dates-list queries failed: this is not "market empty", it means we saw nothing
    // because every request failed. Rethrow (fischer pattern) so runScan records this source
    // as 'failed' rather than silently degrading to [] (which would eventually flip every
    // known offer inactive and mute the 3x-failed health alert).
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`${opts.name}: all dates-list queries failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  await resolveUnknownHotelNames(ctx, all, opts);

  ctx.log(`${opts.name}: fetched ${all.length} offers across ${opts.queries.length} queries`);
  return all;
}

/** Matches the numeric fallback title assigned in `mapRow` ("Hotel <id>"), capturing the id. */
const FALLBACK_TITLE_RE = /^Hotel (\d+)$/;

/**
 * Fills in real hotel names for offers still on the numeric "Hotel <id>" fallback (i.e. not
 * resolved by the sitemap), via two sources, cheapest first:
 *
 *   1. `ctx.priorTitles` (spec: feed prior titles to avoid re-lookup): a sourceOfferKey -> title
 *      map of this source's previously-resolved (non-placeholder) names, loaded by run.ts from
 *      the DB. The sourceOfferKey is per-TERM (hash of [master_id, date_from, duration_night,
 *      boarding_id]), not per-hotel, so it can't be reverse-mapped to a master_id directly.
 *      Instead: after `offers` are built (each one already carries both its master_id-derived
 *      fallback title and its own sourceOfferKey), look up `ctx.priorTitles.get(offer.
 *      sourceOfferKey)` for every still-unresolved offer. If ANY one of a hotel's terms has a
 *      matching prior title, that resolves the WHOLE hotel (master_id) for this run: the resolved
 *      name is applied to all of that master_id's offers, and the id is removed from the set that
 *      would otherwise consume a detail-page lookup. This works in practice because at least one
 *      prior term of a previously-seen hotel usually persists across runs (dates roll forward
 *      gradually; full term turnover in a single 2h scan interval is rare).
 *   2. Per-hotel detail-page redirect lookup, for any master_id NOT resolved by step 1:
 *      `GET <siteBaseUrl><detailPath(master_id)>` (see header comment). Mutates `offers` in place
 *      (updates `title`). Best-effort: a failed lookup for one hotel leaves its offers on the
 *      fallback and does not affect other hotels. Capped at `MAX_NAME_LOOKUPS` distinct hotels
 *      per call; any beyond that are logged as skipped. A `SourceBlockedError` from a lookup
 *      stops further lookups for this run (politeness) but keeps whatever names were already
 *      resolved.
 */
async function resolveUnknownHotelNames(
  ctx: SourceContext,
  offers: NormalizedOffer[],
  opts: CesysStorefrontOpts,
): Promise<void> {
  const unresolvedIds = new Set<number>();
  for (const offer of offers) {
    const match = offer.title.match(FALLBACK_TITLE_RE);
    if (!match) continue;
    unresolvedIds.add(Number(match[1]));
  }
  if (unresolvedIds.size === 0) return;

  // Step 1: resolve from ctx.priorTitles first — free, no network cost, and frees up the
  // detail-page lookup cap for genuinely-new hotels.
  const resolvedNames = new Map<number, string>();
  if (ctx.priorTitles && ctx.priorTitles.size > 0) {
    for (const offer of offers) {
      const match = offer.title.match(FALLBACK_TITLE_RE);
      if (!match) continue;
      const id = Number(match[1]);
      if (resolvedNames.has(id)) continue;
      const prior = ctx.priorTitles.get(offer.sourceOfferKey);
      if (prior) resolvedNames.set(id, prior);
    }
    for (const id of resolvedNames.keys()) {
      unresolvedIds.delete(id);
    }
  }

  // Step 2: detail-page lookup for whatever's still unresolved after step 1.
  if (unresolvedIds.size > 0) {
    const detailPath = opts.detailPathTemplate ?? DEFAULT_DETAIL_PATH_TEMPLATE;
    const idsToLookUp = [...unresolvedIds].slice(0, MAX_NAME_LOOKUPS);
    const skipped = unresolvedIds.size - idsToLookUp.length;
    if (skipped > 0) {
      ctx.log(`${opts.name}: ${skipped} hotel(s) beyond the ${MAX_NAME_LOOKUPS}-lookup cap skipped this run, keeping "Hotel <id>" fallback`);
    }

    for (const id of idsToLookUp) {
      try {
        const html = await ctx.http.text(`${opts.siteBaseUrl}${detailPath(id)}`);
        const name = parseHotelNameFromDetail(html);
        if (name) resolvedNames.set(id, name);
      } catch (err) {
        if (err instanceof SourceBlockedError) {
          ctx.log(`${opts.name}: hotel-name detail-page lookup blocked (${err.message}), stopping further lookups`);
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`${opts.name}: hotel-name detail-page lookup failed for id ${id} (${message}), keeping fallback`);
        // Not fatal: this hotel keeps its "Hotel <id>" fallback title, loop continues.
      }
    }
  }

  if (resolvedNames.size === 0) return;

  for (const offer of offers) {
    const match = offer.title.match(FALLBACK_TITLE_RE);
    if (!match) continue;
    const resolved = resolvedNames.get(Number(match[1]));
    if (resolved) offer.title = resolved;
  }
}

/** Builds a CESYS storefront adapter (dovolenkovani, firo, …) from per-storefront opts. */
export function makeCesysAdapter(opts: CesysStorefrontOpts): SourceAdapter {
  return {
    name: opts.name,
    fetchOffers: (ctx: SourceContext) => fetchOffers(ctx, opts),
  };
}
