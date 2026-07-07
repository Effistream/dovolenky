import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const SITE_BASE_URL = 'https://dovolenkovani.cz';
const API_BASE_URL = 'https://api-ng.cesys.eu/online/v1.4/cs';
const CLIENT_ID = '12274';
const CUSTOMER_ID = '2119';
const FALLBACK_URL = 'https://dovolenkovani.cz/vyhledavani-zajezdu/';
const ROWS_ON_PAGE = 30;
const SITEMAP_INDEX_URL = `${SITE_BASE_URL}/sitemap.xml`;
const ACCOMMODATIONS_XML_URL = `${SITE_BASE_URL}/accommodations.xml`;
// Politeness ceiling: at most 2 accommodation-sitemap shards are fetched even if the index
// lists more (budget math in the header comment already counts exactly 2).
const MAX_ACCOMMODATION_SITEMAPS = 2;

/**
 * Dovolenkovani.cz is a white-label storefront on the CESYS platform (operated by TRAVEL
 * Group s.r.o.), not its own booking backend. Live investigation 2026-07-07 (spec §3 row 10):
 *
 * - `GET /sitemap.xml` (own host) is a sitemap *index* listing `pages.xml`, `accommodations.xml`
 *   and `am-accommodations.xml`. We fetch the index first and pull every `<loc>` matching
 *   /accommodations/i (currently the latter two) rather than hardcoding just
 *   `accommodations.xml`, so a future third `*-accommodations.xml` shard is picked up
 *   automatically. If the index fetch itself fails, we fall back to fetching
 *   `accommodations.xml` directly (previous behavior) so hotel-name enrichment still degrades
 *   gracefully instead of going to zero.
 * - Each `accommodations.xml`-like sitemap is a small file mapping hotel codes like "6a" to a
 *   detail-page slug (e.g. `kalia-beach`). The trailing letter(s) after the numeric id are a
 *   CESYS-internal suffix we discard; the numeric prefix IS the `master_id` used by the CESYS
 *   API (confirmed live: code "6a" -> master_id 6 -> SSR detail page titled "Kalia Beach").
 *   Live, `am-accommodations.xml` was empty (0 entries) and `accommodations.xml` had the same 3
 *   hotels as before — so hotel-name coverage from this source is still inherently partial;
 *   most `master_id`s returned by dates-list fall back to "Hotel <id>", which is expected, not
 *   a parsing bug.
 * - `GET https://api-ng.cesys.eu/online/v1.4/cs/mapping/countries?client_id=12274&lang=cs`
 *   (third-party host) returns `{status, data:{country: {"<id>": "<name>"}}}`, e.g. `"48":
 *   "Egypt"`. Country ids on dates-list rows are only meaningful through this mapping — never
 *   surface the raw numeric id as `country`.
 * - `POST https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12274&lang=cs`
 *   (third-party host, no auth required, verified live via curl) accepts a JSON body and works
 *   cross-hotel (no `hotel_id`/`master_id` filter parameter was found to actually narrow
 *   results during live probing — every attempted filter param was silently ignored by the
 *   API), returning `{status, data:{results, more_exists, dates:[...]}}`.
 *
 * Query-quality probe results (live, 2026-07-07, ≤3 dates-list requests spent), driven by the
 * finding that the original léto-moře query (duration 1-21, no boarding filter) returned mostly
 * short 2-5 night stays at a single cheap hotel (19/30 rows):
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
 *   - ADOPTED for léto-moře: server-side `duration: {from: 7, to: 22}` (days) as a density
 *     pre-filter (biases the 30-row price-asc page toward longer stays / more distinct hotels,
 *     as in probe A), PLUS a client-side `duration_night >= 6` post-filter in `fetchOffers`
 *     (the `minNights` field on the léto-moře entry in `QUERIES`) to make the invariant exact
 *     regardless of the API's loose duration/duration_night relationship. last-minute query is
 *     left broad (duration 1-21, no floor) — short stays are the *point* of that profile.
 *
 * price_from.CZK per-person vs total (resolved empirically, Step 1):
 * - The SSR detail page for Kalia Beach (master_id 6) shows `od 11 290 Kč <b>/ osobu a
 *   pobyt</b>` (explicitly "per person and stay").
 * - A same-window adults:1 probe against Egypt flight+AI/breakfast packages returned prices in
 *   the same 12,000-15,000 CZK order of magnitude as the adults:2 default fixture (13,990-
 *   14,490 CZK) for similar duration/board combinations. If `price_from.CZK` were a *couple's
 *   total*, the solo (adults:1) total should be roughly half, not equal — it isn't.
 * - Conclusion: `price_from.CZK` is PER-PERSON. Mapped directly to `pricePerPerson`. The raw
 *   payload DOES carry a `price_total` field, but it was null on every row observed live —
 *   so `priceTotal` is left null (nothing honest to map), not because the field is absent.
 *
 * discount_percent was null on every row observed in the live fixture (30/30) — guarded per
 * spec: only accepted as a real claimed discount when `0 < pct < 100`; `claimedOriginalPrice`
 * is then back-computed from `pricePerPerson / (1 - pct/100)`. Anything outside that range
 * (including the all-null common case) leaves both fields null, matching every other adapter's
 * "nothing honest to compute" convention.
 *
 * `transport_id: 1` is used directly as the query filter ("Letecká"/flight) per the brief; on
 * the response side transport is mapped straight to 'flight' when `transport_id === 1` (no
 * ambiguity — this is CESYS's own canonical flight code, not free text), falling back to
 * `normalizeTransport(transport)` for any other transport_id so non-flight rows (buses, own
 * transport) still classify correctly if a query ever returns them.
 *
 * Two dates-list queries per scan (matching the two watch profiles, spec §1):
 *   A) "léto-moře": today -> +60 days, flight only, duration 7-22 days (>=6 nights enforced
 *      client-side too), sorted price asc.
 *   B) "last-minute": today -> +14 days, flight only, broad duration, sorted price asc.
 * Per compliance (§9 / spec row 10 note): dovolenkovani.cz's robots.txt blocks ClaudeBot BY
 * NAME, so this adapter must NEVER send any Claude-identifying UA — it relies entirely on the
 * project's standard Chrome UA (HttpClient's default). api-ng.cesys.eu is a third-party
 * internal API with no robots.txt of its own; using it is a conscious §9 deviation, budgeted at
 * a hard ceiling of ~6 requests/scan (here: 1 sitemap index + up to 2 accommodation shards + 1
 * countries + 2 dates-list = 6 — we are now AT the ceiling; do not add further live requests to
 * this adapter without dropping one elsewhere first).
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

interface CesysCountriesResponse {
  status?: string;
  data?: {
    country?: Record<string, string>;
  };
}

export interface HotelInfo {
  name: string;
  url: string;
}

interface DovolenkovaniMaps {
  hotels: Map<number, HotelInfo>;
  countries: CesysCountriesResponse;
}

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
 * `https://dovolenkovani.cz/detail-zajezdu/<slug>/<code>`, where `<code>` is a numeric hotel id
 * followed by a CESYS-internal letter suffix (e.g. "6a" -> id 6). Rows whose `<loc>` doesn't
 * match that shape are silently skipped (not fatal — this map degrades to "Hotel <id>"
 * fallback for any master_id not present here, by design).
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

function mapRow(row: CesysDateRow, maps: DovolenkovaniMaps): NormalizedOffer | null {
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
  const url = hotelInfo?.url ?? FALLBACK_URL;

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
    source: 'dovolenkovani',
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
 * country ids via the provided maps. Pure function: no I/O. Dedupes by `sourceOfferKey`,
 * keeping the first occurrence.
 */
export function parseCesysDates(payload: unknown, maps: DovolenkovaniMaps): NormalizedOffer[] {
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

function buildDatesListBody(fromDays: number, toDays: number, durationFrom: number, durationTo: number): string {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() + fromDays);
  const to = new Date(today);
  to.setDate(to.getDate() + toDays);

  return JSON.stringify({
    page: 1,
    date: { from: isoDate(from), to: isoDate(to) },
    duration: { from: durationFrom, to: durationTo },
    composition: { adults: 2, children: [] },
    price: { from: 0, to: 999999 },
    transport_id: ['1'],
    rows_on_page: ROWS_ON_PAGE,
    sort: ['price asc', 'date_from asc'],
    client_id: CLIENT_ID,
    customer_id: CUSTOMER_ID,
  });
}

interface DatesListQuery {
  label: string;
  fromDays: number;
  toDays: number;
  durationFrom: number;
  durationTo: number;
  /** Client-side floor on duration_night, enforced after parsing (see header comment: the
   * API's `duration` param filters loosely and does not guarantee this on its own). Undefined
   * means "no floor" (last-minute query, where short stays are the point). */
  minNights?: number;
}

// Two queries per scan, matching the two watch profiles (spec §1):
//   léto-moře: today..+60d, duration 7-22 days (empirically biases toward duration_night >= 6,
//     see header comment probe A/B), plus an explicit client-side duration_night >= 6 floor
//     because the API's duration/duration_night relationship isn't a fixed offset.
//   last-minute: today..+14d, broad duration 1-21 days (short stays are the point, no floor).
// Both flight-only, sorted price asc, 30 rows/page.
const QUERIES: DatesListQuery[] = [
  { label: 'leto-more', fromDays: 0, toDays: 60, durationFrom: 7, durationTo: 22, minNights: 6 },
  { label: 'last-minute', fromDays: 0, toDays: 14, durationFrom: 1, durationTo: 21 },
];

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  // Sitemap + country mapping are best-effort enrichment: failure here degrades gracefully to
  // "Hotel <id>" titles / null country, it is NOT fatal for the whole source.
  const hotels = new Map<number, HotelInfo>();
  let accommodationUrls: string[] = [];
  try {
    const indexXml = await ctx.http.text(SITEMAP_INDEX_URL);
    accommodationUrls = extractAccommodationSitemapUrls(indexXml).slice(0, MAX_ACCOMMODATION_SITEMAPS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`dovolenkovani: sitemap.xml index fetch failed (${message}), falling back to accommodations.xml directly`);
  }

  if (accommodationUrls.length === 0) {
    // Either the index fetch failed, or it parsed to zero matching <loc> entries (e.g.
    // malformed/unexpected index shape) — either way, fall back to the previously known-good
    // direct URL rather than giving up on hotel enrichment entirely.
    accommodationUrls = [ACCOMMODATIONS_XML_URL];
  }

  for (const url of accommodationUrls) {
    try {
      const xml = await ctx.http.text(url);
      for (const [id, info] of parseAccommodationsSitemap(xml)) {
        hotels.set(id, info);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`dovolenkovani: accommodation sitemap fetch failed for ${url} (${message}), skipping`);
    }
  }

  let countries: CesysCountriesResponse = {};
  try {
    countries = await ctx.http.json<CesysCountriesResponse>(
      `${API_BASE_URL}/mapping/countries?client_id=${CLIENT_ID}&lang=cs`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`dovolenkovani: mapping/countries fetch failed (${message}), country will be null`);
  }

  const maps: DovolenkovaniMaps = { hotels, countries };
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  for (const query of QUERIES) {
    let offers: NormalizedOffer[];
    try {
      const body = buildDatesListBody(query.fromDays, query.toDays, query.durationFrom, query.durationTo);
      const res = await ctx.http.json<CesysDatesListResponse>(
        `${API_BASE_URL}/cesys/dates-list?client_id=${CLIENT_ID}&lang=cs`,
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
        ctx.log(`dovolenkovani: query ${query.label} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`dovolenkovani: query ${query.label} dates-list failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // BOTH dates-list queries failed: this is not "market empty", it means we saw nothing
    // because every request failed. Rethrow (fischer pattern) so runScan records this source
    // as 'failed' rather than silently degrading to [] (which would eventually flip every
    // known offer inactive and mute the 3x-failed health alert).
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`dovolenkovani: both dates-list queries failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`dovolenkovani: fetched ${all.length} offers across ${QUERIES.length} queries`);
  return all;
}

export const dovolenkovani: SourceAdapter = {
  name: 'dovolenkovani',
  fetchOffers,
};
