import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * Alexandria (alexandria.cz) — a large Czech operator whose search results come from a clean,
 * anti-bot-free JSON backend (spec §16.1 row 12), so this adapter parses JSON directly with no HTML
 * scraping. The frontend calls `GET https://bck-new.alexandria.cz/web-search?page=N[&location=<id>]`
 * (open CORS, permissive robots) which returns `{ packages[], total, query_params }`.
 *
 * Exotic long-haul is Alexandria's winter product, so in summer the exotic `location` feeds are
 * often seasonally empty; the adapter still queries them (cheap, bounded) alongside the default feed
 * so coverage flips on automatically once the winter catalogue goes on sale. Location ids are
 * hard-coded from the one-off destination tree (`https://bck.alexandria.cz/filter-location`) and
 * verified live.
 *
 * Live re-verification 2026-07-29 (curl, Chrome UA) — the coverage rewrite:
 *  (a) `page_size` IS honoured, and it is the only page-widening knob that is: of
 *      limit / per_page / perPage / pageSize / size / page_size, ONLY `page_size` changes the row
 *      count (the other five all still return the default 18). `?page=1&page_size=200` → 200 rows in
 *      ~8.5 s / ~780 KB; `page_size=100` → ~4.2 s. `page` then pages in units of `page_size` with no
 *      overlap. This is why the adapter now reads the WHOLE default feed in 6 requests instead of
 *      36 rows in 2: total = 1042, pages 1-6 at 200/page returned 200/200/191/194/112/19 = 916 rows.
 *  (b) What the old 2-page window was losing (measured on those 916 rows): 50 distinct
 *      country_name values vs 8; per-person floor 3,351 CZK vs 17,990; 116 `Vlastní` (self-drive)
 *      rows vs 0; nights 3-18 vs {7,10}; the 'Plavby' (cruise) and 'Poznávací zájezdy' product
 *      lines. Note the feed is ordered roughly by deal-ness: all 429 currently-discounted rows sit
 *      in the first ~500, and the tail is the zero-discount Worldee city-break marketplace — so the
 *      extra pages buy price/destination breadth, not extra discounts.
 *  (c) A row's `packages[].detail` is NOT always a slug. 158 of 916 rows (the Worldee partner
 *      inventory, tour_id `WORLDEE_*`) carry an absolute `https://alexandria.worldee.com/...` URL
 *      there; prefixing those with /hotel/ produced a broken link. Now passed through verbatim.
 *  (d) Every row carries `autofixes`, the term identifier the site's own result cards link with
 *      (`/hotel/<detail>?ages=1_20%7C2_20&autofixes=<term>`). Without it the detail page opens its
 *      OWN default term: verified live, `/hotel/BV_281-adi-dharma-hotel-kuta` renders the
 *      2026-08-24 departure while the feed row is 2026-08-03; appending
 *      `?ages=1_20%7C2_20&autofixes=BV_281_2026-08-03_...` makes the page render the 2026-08-03 term
 *      and its exact package_price 84848. So the term is now part of the emitted URL.
 *  (e) `accommodation_category` 3.5/4.5 exist (5 of 916 rows). The detail page draws floor(cat) full
 *      stars plus a half star — `.../7096-zeravi-beach-alexandria-club` (4.5) renders 4 full + 1
 *      half — so `Math.round` was inflating a 3.5 hotel to 4. Now floored.
 *  (f) `country_name` 'Itálie (zima)' (41 rows) failed isKnownCountry, because normalizeCountry
 *      splits on /[\/,–-]/ and never strips a parenthesis → country null → the row drops out of
 *      cross-source matching and the hotel discount-reference rung. The parenthetical qualifier is
 *      now stripped before the country guard.
 *
 * Earlier live verification 2026-07-07 (see .superpowers/sdd/task-36-report.md), still valid:
 *  (g) `persons` is an INTEGER count (=2 on all 916 rows), NOT an array — spec §16.1 row 12's
 *      formula is `package_price/persons` and the live payload is a scalar. `package_price` is the
 *      TOTAL for the party, `original_price` is the crossed-out total. Confirmed against the site's
 *      own printed "Celkem za 2 osoby / Osoba za" lines on both in-house and BV_/Worldee rows.
 *  (h) `https://www.alexandria.cz/hotel/{detail}` → HTTP 200 directly (no redirect);
 *      `https://www.alexandria.cz/vyhledavani` (also HTTP 200) is the fallback for the (unobserved)
 *      case of a package with no `detail` at all.
 *
 * Per-package field mapping (fields confirmed against the live fixtures):
 *  - tour_name          -> title (hotel/property name)
 *  - detail + autofixes -> url  (absolute `detail` verbatim; else `/hotel/<detail>?ages=…&autofixes=…`;
 *                          fallback `/vyhledavani`)
 *  - country_name       -> country, parenthetical qualifier stripped ('Itálie (zima)' -> 'Itálie'),
 *                          then via isKnownCountry/normalizeCountry guard (null, never a raw or
 *                          locality string, when it isn't a recognized canonical country — so the
 *                          Worldee tail's USA/Island/Norsko/… correctly stay null)
 *  - destination_name   -> locality (the resort/city, e.g. "Primorsko"/"Kuta"; state_name fallback)
 *  - accommodation_category (float stars, e.g. 3.5) -> stars, Math.floor (3.5 → 3), null when <= 0
 *  - board_name         -> board (normalizeBoard)
 *  - transport_name     -> transport (normalizeTransport; 'Letecky' → flight, 'Vlastní' → own)
 *  - start (ISO)        -> departureDate; nights -> nights
 *  - package_price      -> priceTotal (group total); pricePerPerson = round(package_price/persons),
 *                          `persons` clamped to 1..MAX_PERSONS; a row that rounds to 0/person drops
 *  - original_price     -> claimedOriginalPrice = round(original_price/persons) and
 *                          claimedDiscountPct = round((original-package)/original*100), but ONLY when
 *                          original_price > package_price; 0/null/<=package_price → both null
 *  - sourceOfferKey     = offerKeyHash([tour_id, start, nights, board_id]) — a departure-term key
 *                          (the same hotel has one package per term); fetchOffers dedupes on it
 *
 * departureAirport is null: `departure_location_name` is a comma-joined multi-city string
 * ("Praha, Brno, Ostrava, Pardubice"), not a single airport. tourOperator is null: Alexandria sells
 * its own inventory and the payload carries no per-package operator field (the `source` tag already
 * identifies it). omnibusLowestPrice is null: no such field exists.
 */

const API_BASE_URL = 'https://bck-new.alexandria.cz/web-search';
const HOTEL_URL_BASE = 'https://www.alexandria.cz/hotel';
const FALLBACK_URL = 'https://www.alexandria.cz/vyhledavani';

// `page_size` is the one honoured page-width parameter (see header note (a)). 200 rows/request is
// the sweet spot measured live: ~8.5 s server time, comfortably inside HttpClient's 25 s
// REQUEST_TIMEOUT_MS, while 400+ would push the per-request time toward that ceiling for no gain.
const FEED_PAGE_SIZE = 200;

// HARD REQUEST BUDGET. src/core/run.ts aborts an adapter after ADAPTER_FETCH_TIMEOUT_MS = 240 s and
// HttpClient serialises same-host requests with a 3 s gap, so each request costs ~3 s + fetch time
// (~8.5 s for a 200-row feed page, ~1 s for a small location page). MAX_FEED_PAGES + the exotic ids
// is the ceiling on requests per scan: 6 + 7 = 13 ≈ 6*11.5 + 7*4 = 97 s. buildQueries() slices to
// MAX_REQUESTS so a future site change (e.g. the catalogue tripling) can never silently explode the
// count past the budget — coverage would stop growing, but the source would never be timed out and
// dropped from the board.
// 6 * 200 = 1200 slots ≥ today's catalogue. Verified 2026-07-29: pages 1-6 return ~916 rows and
// page 7 is already the clamped tail (a single repeated row), so 6 pages is full coverage today.
const MAX_FEED_PAGES = 6;
const MAX_REQUESTS = 13;

// Exotic `location` ids, verified live 2026-07-07 (spec §16.1 row 12): Maledivy 3175, Emiráty 8288,
// Dominikánská 3030, Seychely 5899, Mexiko 3163, Srí Lanka 453555, Bali 453246. These are the ids
// alexandria.cz's own /zajezdy/exotika category queries, and `available:false` in filter-location is
// the site's own "sold out right now" state, not a retirement — so they stay, one page each, and
// flip on by themselves when the winter charter catalogue goes on sale.
const EXOTIC_LOCATION_IDS = ['3175', '8288', '3030', '5899', '3163', '453555', '453246'];

// Sanity ceiling on the payload's `persons` count. It is 2 on every live row, but it is remote
// input and it drives BOTH a division and an `ages` array built per person — an absurd value would
// divide the price to 0 AND allocate a multi-megabyte URL string that then gets written to the DB
// (measured: persons=5e6 → a 63.9 MB url). Anything above this is treated as invalid and falls back
// to the same conservative persons=1 branch as a missing value.
const MAX_PERSONS = 12;

interface AlexandriaPackage {
  tour_id?: string | number | null;
  tour_name?: string | null;
  detail?: string | null;
  autofixes?: string | number | null;
  country_name?: string | null;
  state_name?: string | null;
  destination_name?: string | null;
  accommodation_category?: number | null;
  board_name?: string | null;
  board_id?: number | string | null;
  transport_name?: string | null;
  start?: string | null;
  nights?: number | null;
  persons?: number | null;
  package_price?: number | null;
  original_price?: number | null;
}

interface AlexandriaResponse {
  packages?: AlexandriaPackage[];
}

interface AlexandriaQuery {
  label: string;
  url: string;
  /** 'feed' queries are paged and stop early once a page comes back empty; 'exotic' are one-shot. */
  kind: 'feed' | 'exotic';
}

function round(n: number): number {
  return Math.round(n);
}

/** The bounded set of web-search requests issued per scan (default feed pages + one page per
 *  exotic location). Deterministic and side-effect-free so tests can assert the exact URL set.
 *  The final slice is the hard cap: whatever is added above, a scan never exceeds MAX_REQUESTS. */
export function buildQueries(): AlexandriaQuery[] {
  const queries: AlexandriaQuery[] = [];
  for (let page = 1; page <= MAX_FEED_PAGES; page += 1) {
    queries.push({
      label: `default p${page}`,
      url: `${API_BASE_URL}?page=${page}&page_size=${FEED_PAGE_SIZE}`,
      kind: 'feed',
    });
  }
  for (const id of EXOTIC_LOCATION_IDS) {
    queries.push({
      label: `exotika ${id}`,
      url: `${API_BASE_URL}?page=1&page_size=${FEED_PAGE_SIZE}&location=${id}`,
      kind: 'exotic',
    });
  }
  return queries.slice(0, MAX_REQUESTS);
}

/**
 * The site's own result cards deep-link as `/hotel/<detail>?ages=1_20%7C2_20&autofixes=<term>`.
 * `autofixes` pins the DEPARTURE TERM: without it the detail page opens whatever term it considers
 * default, which is routinely a different date at a different price than the row we put on the
 * board (header note (d)). `ages` mirrors the party the row is priced for — one 20-year-old adult
 * per `persons` — so the page shows the same total we did.
 *
 * The Worldee partner rows put an absolute alexandria.worldee.com URL in `detail`; those are already
 * complete deep links and must be passed through untouched, never prefixed with /hotel/.
 */
function buildOfferUrl(detail: string | null, autofixes: string | null, persons: number): string {
  if (!detail) return FALLBACK_URL;
  if (/^https?:\/\//i.test(detail)) return detail;
  const base = `${HOTEL_URL_BASE}/${detail}`;
  if (!autofixes) return base;
  const ages = Array.from({ length: persons }, (_, i) => `${i + 1}_20`).join('|');
  return `${base}?${new URLSearchParams({ ages, autofixes }).toString()}`;
}

/**
 * Alexandria qualifies a few country_name values with a season in parentheses ('Itálie (zima)').
 * normalizeCountry/isKnownCountry tokenize on /[\/,–-]/ only, so the parenthesis would sink the row
 * to country=null — which in turn nulls computeMatchKey/computeHotelKey and drops it out of
 * cross-source matching. Strip the qualifier, keep the country.
 */
function stripCountryQualifier(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s*\([^)]*\)/g, '').trim();
  return cleaned || null;
}

function mapPackage(p: AlexandriaPackage): NormalizedOffer | null {
  // Skip rows we can't price or place in time: no positive group price, or no departure date.
  const packagePrice = p.package_price;
  if (typeof packagePrice !== 'number' || !(packagePrice > 0)) return null;
  const start = typeof p.start === 'string' && p.start.trim() ? p.start.trim() : null;
  if (!start) return null;

  const title = p.tour_name?.trim();
  if (!title) return null;

  // `persons` is a scalar count (=2 on every live row). Guard 1..MAX_PERSONS so a missing, absurd
  // or invalid value degrades to treating package_price as already per-person (conservative: never
  // fabricates a cheaper deal, and never lets a junk count blow up the ages string below).
  const persons =
    typeof p.persons === 'number' && p.persons >= 1 && p.persons <= MAX_PERSONS
      ? Math.floor(p.persons)
      : 1;
  const pricePerPerson = round(packagePrice / persons);
  // A sub-1 CZK package price would round the per-person figure to 0 and then divide by zero in
  // every downstream discount/median computation. Drop the row instead.
  if (!(pricePerPerson > 0)) return null;
  const priceTotal = round(packagePrice);

  // Only an original_price strictly above the current group price is an honest crossed-out price;
  // 0 / null / <= package_price (the frequent no-discount case) leaves both claimed fields null.
  const original = p.original_price;
  let claimedOriginalPrice: number | null = null;
  let claimedDiscountPct: number | null = null;
  if (typeof original === 'number' && original > packagePrice) {
    const pct = round(((original - packagePrice) / original) * 100);
    // Guard 0<pct<100 (matching deluxea/datour): a discount that rounds to 0% (original barely
    // above package_price) — or an impossible >=100% — leaves BOTH claimed fields null, never a
    // non-null claimedOriginalPrice paired with a 0% claimedDiscountPct.
    if (pct > 0 && pct < 100) {
      claimedOriginalPrice = round(original / persons);
      claimedDiscountPct = pct;
    }
  }

  // Half-star categories are the site's "superior" marker, and its own header draws floor(cat) full
  // stars next to a half star — so floor, not round: Math.round turned a 3.5 hotel into a 4* one.
  const cat = p.accommodation_category;
  const stars = typeof cat === 'number' && cat > 0 ? Math.floor(cat) : null;

  const board = normalizeBoard(p.board_name ?? null);
  const transport = normalizeTransport(p.transport_name ?? null);

  // Country must be a recognized canonical country or null — never a raw string, never the
  // locality (binding country-or-null invariant, shared across every adapter).
  const rawCountry = stripCountryQualifier(p.country_name);
  const country = isKnownCountry(rawCountry) ? normalizeCountry(rawCountry) : null;
  const locality = p.destination_name?.trim() || p.state_name?.trim() || null;

  const detail = typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim() : null;
  const autofixes =
    typeof p.autofixes === 'string' || typeof p.autofixes === 'number'
      ? String(p.autofixes).trim() || null
      : null;
  const url = buildOfferUrl(detail, autofixes, persons);

  const nights = typeof p.nights === 'number' ? p.nights : null;
  const sourceOfferKey = offerKeyHash([p.tour_id, start, nights, p.board_id]);

  return {
    source: 'alexandria',
    sourceOfferKey,
    title,
    country,
    locality,
    stars,
    board,
    transport,
    departureAirport: null,
    departureDate: start,
    nights,
    pricePerPerson,
    priceTotal,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator: null,
    url,
  };
}

/** Row count of a raw web-search response, used only to detect "we paged past the end". */
function packageCount(json: unknown): number {
  const packages = (json as AlexandriaResponse | null | undefined)?.packages;
  return Array.isArray(packages) ? packages.length : 0;
}

/**
 * Maps a single `web-search` response to NormalizedOffer[]. Pure function: no I/O. Dedupes by
 * `sourceOfferKey` within this one response (cross-query dedup is fetchOffers's job), keeping the
 * first occurrence. Returns [] for a missing/empty `packages` array (e.g. a seasonally-empty
 * exotic location, or a feed page past the end) rather than throwing.
 */
export function parseAlexandria(json: unknown): NormalizedOffer[] {
  const packages = (json as AlexandriaResponse | null | undefined)?.packages;
  if (!Array.isArray(packages)) return [];

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];
  for (const p of packages) {
    const offer = mapPackage(p);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }
  return offers;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const queries = buildQueries();
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;
  // Once a feed page comes back with zero rows we have paged past the end of the catalogue; the
  // remaining feed pages would all be empty, so skip them and spend nothing on them.
  //
  // MEASURED 2026-07-29 (review): today's backend does NOT actually do this — it CLAMPS instead of
  // emptying. With total=1040, pages 5/6 returned 111/18 rows and pages 7, 8, 12 and 30 every one
  // returned the SAME single row (WORLDEE_791604). So against the live site this early stop never
  // fires, and it is MAX_FEED_PAGES — not this flag — that bounds the budget. The flag is kept as a
  // cheap guard for the case where the backend does start returning `{packages:[]}` past the end;
  // the clamp itself is harmless because a repeated row dedupes away on sourceOfferKey below.
  let feedExhausted = false;

  for (const query of queries) {
    if (query.kind === 'feed' && feedExhausted) continue;

    let offers: NormalizedOffer[];
    try {
      const json = await ctx.http.json(query.url);
      if (query.kind === 'feed' && packageCount(json) === 0) feedExhausted = true;
      offers = parseAlexandria(json);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further queries (politeness) but keep
        // whatever offers the earlier queries already yielded. Record the block as lastError so a
        // block BEFORE the first success still trips the successCount===0 rethrow below (→ BLOCKED
        // marker → 24h backoff) instead of silently degrading to [].
        lastError = err;
        ctx.log(`alexandria: query ${query.label} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`alexandria: query ${query.label} web-search failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      // The same hotel term can surface on both the default feed and its exotic location page,
      // so dedupe globally by sourceOfferKey.
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // ALL web-search queries failed: this is not "market empty", it means we saw nothing because
    // every request failed. Rethrow (fischer pattern) so runScan records this source as 'failed'
    // rather than silently degrading to [] (which would eventually flip every known offer inactive
    // and mute the 3x-failed health alert).
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`alexandria: all web-search queries failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`alexandria: fetched ${all.length} offers across ${successCount} queries`);
  return all;
}

export const alexandria: SourceAdapter = {
  name: 'alexandria',
  fetchOffers,
};
