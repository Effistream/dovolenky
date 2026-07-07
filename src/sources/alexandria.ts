import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * Alexandria (alexandria.cz) — a large Czech operator whose search results come from a clean,
 * anti-bot-free JSON backend (spec §16.1 row 12), so this adapter parses JSON directly with no HTML
 * scraping. The frontend calls `GET https://bck-new.alexandria.cz/web-search?page=N[&location=<id>]`
 * (open CORS, permissive robots) which returns `{ packages[], total, query_params }`, ~18 packages
 * per page.
 *
 * Exotic long-haul is Alexandria's winter product, so in summer the exotic `location` feeds are
 * often seasonally empty; the adapter still queries them (cheap, bounded) alongside the default feed
 * so coverage flips on automatically once the winter catalogue goes on sale. Location ids are
 * hard-coded from the one-off destination tree (`https://bck.alexandria.cz/filter-location`) and
 * verified live.
 *
 * Live verification 2026-07-07 (curl, Chrome UA; see .superpowers/sdd/task-36-report.md):
 *  (a) `?page=1` → HTTP 200, total 825, 18 packages. `persons` is an INTEGER count (=2), NOT an
 *      array — the task brief said `persons.length` but spec §16.1 row 12's own formula is
 *      `package_price/persons` and the live payload is a scalar, so this adapter divides by the
 *      integer. `package_price` is the TOTAL for the party (35980 for persons=2 → 17990/person, a
 *      sensible per-person figure), `original_price` is the crossed-out total (74980) → per-person
 *      equivalent 37490, ~52% off. CONFIRMED the total-for-party semantics; only the field shape
 *      (scalar vs array) differed from the brief's wording.
 *  (b) `?page=1&location=3175` (Maledivy) → `{packages:[], total:0}`: seasonally empty in July.
 *      Per the brief, `?page=1&location=453246` (Bali) was used as the exotic fixture instead — 10
 *      Indonésie packages where `original_price == package_price` on every row (no discount →
 *      claimed* stay null), board mix (Bez stravy/Snídaně), `tour_id` as "BV_xxx" strings, and
 *      `board_id` null.
 *  (c) `https://www.alexandria.cz/hotel/{detail}` → HTTP 200 directly (no redirect) for the live
 *      `detail` slug (e.g. 4782-belvedere-alexandria-club), so that is the canonical offer URL;
 *      `https://www.alexandria.cz/vyhledavani` (also HTTP 200) is the fallback for the (unobserved)
 *      case of a package with no `detail` slug.
 *
 * Per-package field mapping (fields confirmed against the two live fixtures):
 *  - tour_name          -> title (hotel/property name)
 *  - detail             -> url  (`/hotel/<detail>`; fallback `/vyhledavani`)
 *  - country_name       -> country, via isKnownCountry/normalizeCountry guard (null, never a raw or
 *                          locality string, when it isn't a recognized canonical country)
 *  - destination_name   -> locality (the resort/city, e.g. "Primorsko"/"Kuta"; state_name fallback)
 *  - accommodation_category (float stars, e.g. 3.5) -> stars, Math.round (3.5 → 4), null when <= 0
 *  - board_name         -> board (normalizeBoard)
 *  - transport_name     -> transport (normalizeTransport; every live row is "Letecky" → flight)
 *  - start (ISO)        -> departureDate; nights -> nights
 *  - package_price      -> priceTotal (group total); pricePerPerson = round(package_price/persons)
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

// Default feed is paged; two pages keep the request budget small while still surfacing the
// current-season deals the operator front-loads.
const DEFAULT_FEED_PAGES = 2;

// Exotic `location` ids, verified live 2026-07-07 (spec §16.1 row 12): Maledivy 3175, Emiráty 8288,
// Dominikánská 3030, Seychely 5899, Mexiko 3163, Srí Lanka 453555, Bali 453246. One page each →
// 2 default + 7 exotic = 9 requests/scan (under the ~10 budget).
const EXOTIC_LOCATION_IDS = ['3175', '8288', '3030', '5899', '3163', '453555', '453246'];

interface AlexandriaPackage {
  tour_id?: string | number | null;
  tour_name?: string | null;
  detail?: string | null;
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
}

function round(n: number): number {
  return Math.round(n);
}

/** The bounded set of web-search requests issued per scan (default feed pages + one page per
 *  exotic location). Deterministic and side-effect-free so tests can assert the exact URL set. */
function buildQueries(): AlexandriaQuery[] {
  const queries: AlexandriaQuery[] = [];
  for (let page = 1; page <= DEFAULT_FEED_PAGES; page += 1) {
    queries.push({ label: `default p${page}`, url: `${API_BASE_URL}?page=${page}` });
  }
  for (const id of EXOTIC_LOCATION_IDS) {
    queries.push({ label: `exotika ${id}`, url: `${API_BASE_URL}?page=1&location=${id}` });
  }
  return queries;
}

function mapPackage(p: AlexandriaPackage): NormalizedOffer | null {
  // Skip rows we can't price or place in time: no positive group price, or no departure date.
  const packagePrice = p.package_price;
  if (typeof packagePrice !== 'number' || !(packagePrice > 0)) return null;
  const start = typeof p.start === 'string' && p.start.trim() ? p.start.trim() : null;
  if (!start) return null;

  const title = p.tour_name?.trim();
  if (!title) return null;

  // `persons` is a scalar count (=2 live). Guard >= 1 so a missing/invalid value degrades to
  // treating package_price as already per-person (conservative: never fabricates a cheaper deal).
  const persons = typeof p.persons === 'number' && p.persons >= 1 ? p.persons : 1;
  const pricePerPerson = round(packagePrice / persons);
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

  const cat = p.accommodation_category;
  const stars = typeof cat === 'number' && cat > 0 ? round(cat) : null;

  const board = normalizeBoard(p.board_name ?? null);
  const transport = normalizeTransport(p.transport_name ?? null);

  // Country must be a recognized canonical country or null — never a raw string, never the
  // locality (binding country-or-null invariant, shared across every adapter).
  const country = isKnownCountry(p.country_name) ? normalizeCountry(p.country_name) : null;
  const locality = p.destination_name?.trim() || p.state_name?.trim() || null;

  const detail = typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim() : null;
  const url = detail ? `${HOTEL_URL_BASE}/${detail}` : FALLBACK_URL;

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

/**
 * Maps a single `web-search` response to NormalizedOffer[]. Pure function: no I/O. Dedupes by
 * `sourceOfferKey` within this one response (cross-query dedup is fetchOffers's job), keeping the
 * first occurrence. Returns [] for a missing/empty `packages` array (e.g. a seasonally-empty
 * exotic location) rather than throwing.
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

  for (const query of queries) {
    let offers: NormalizedOffer[];
    try {
      const json = await ctx.http.json(query.url);
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
