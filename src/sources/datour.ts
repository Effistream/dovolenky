import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * Datour (datour.cz) — a Czech agency running on the anchoice.cz whitelabel platform (agency_id 88,
 * spec §16.1 row 16). Its storefront aggregates 23k+ offers from tour operators (Čedok, Coral Travel,
 * TUI, Exim, Fischer, Flexi tours…) including real exotic long-haul inventory (Maledivy, Zanzibar,
 * Mauricius…). The frontend search page (`/vyhledavani`) is a Next.js SPA that calls a clean JSON
 * backend, so this adapter parses JSON directly with no HTML scraping.
 *
 * The ONLY integration surface is `GET https://search.anchoice.cz/web-search` (spec §16.4). The
 * client bundle additionally leaks Elastic Cloud credentials — those are NEVER used, fetched, or
 * referenced here; the REST endpoint above is the sole legitimate surface. datour.cz's robots.txt
 * name-blocks "claudebot", so requests use only the project's standard Chrome UA (HttpClient
 * default) plus a `Referer: https://datour.cz/` header — the deviation logged in spec §16.4.
 *
 * Endpoint: `web-search?page=1&location=<country_id>&package=0` with `Referer: https://datour.cz/`
 * returns `{ total, total_docs, packages[] }`, 18 packages/page, filtered to one country by the
 * `location` id. (The earlier-recon `POST /search` has a NON-functional country filter — unused.)
 *
 * Live verification 2026-07-07 (curl, Chrome UA + Referer; see .superpowers/sdd/task-40-report.md):
 *  (a) `?page=1&location=30182&package=0` (Maledivy) → HTTP 200, total 184, 18 packages, all
 *      `country_name: "Maledivy"` (the location filter works). Providers Čedok/Coral Travel/TUI/
 *      Flexi tours/Worldee; board mix Snídaně/Polopenze/Plná penze/Bez stravy; transport Letecky.
 *  (b) `?page=1&location=452587&package=0` (Zanzibar) → HTTP 200, total 90, 18 packages, all
 *      `country_name: "Zanzibar"`. Confirms the pattern generalizes across countries.
 *  (c) Detail deep-link: the `detail` field already IS the site path (e.g.
 *      `maledivy/ari-atoll/-ari-atol-jih-/liberty-guesthouse-maldives`). datour.cz is a Next.js
 *      catch-all SPA that returns HTTP 200 for every path, but the embedded router state proves the
 *      canonical route: `https://datour.cz/{detail}` yields `subpage: [maledivy, ari-atoll, …]`
 *      (the detail segments verbatim), whereas `https://datour.cz/dovolena/{detail}` prepends a
 *      bogus `dovolena` segment. So `https://datour.cz/{detail}` is the offer URL; the per-query
 *      `https://datour.cz/vyhledavani?location=<id>` search page is the fallback when a row has no
 *      `detail` slug.
 *
 * Pricing decision (documented because it is non-obvious):
 *  - `unit_price` is the PER-PERSON price (spec §16.1: "unit_price = za osobu") and is the sole live
 *    price → `pricePerPerson = round(unit_price)`; rows with `unit_price <= 0` are skipped.
 *  - `package_price` (the party total) is `0.0` on EVERY live row — this endpoint does not populate
 *    the "package" pricing plane — so it is never used as the price source; `priceTotal` is set only
 *    when `package_price > 0`, else null.
 *  - `original_price` and `package_discount` are likewise `0.0` on every live row, so no discounted
 *    row exists to empirically pin down whether `original_price` is per-person or party-total. The
 *    documented decision (see report): treat `original_price` as PER-PERSON, directly comparable to
 *    `unit_price` — because `unit_price` is the only populated price plane and `package_price` (the
 *    party-total plane) is dead at 0.0, so a populated `original_price` is the crossed-out
 *    counterpart to the per-person `unit_price`. `claimedOriginalPrice` is set only when
 *    `original_price > pricePerPerson` (mirrors the alexandria "original > current" guard; cannot
 *    understate). `claimedDiscountPct` comes from `package_discount` (a percentage, unit-independent)
 *    only when `0 < pct < 100`. Both are null on all current live data.
 *
 * Per-package field mapping:
 *  - tour_name          -> title
 *  - detail             -> url (`https://datour.cz/<detail>`; fallback = per-query search URL)
 *  - country_name       -> country, via isKnownCountry/normalizeCountry guard (null when not a
 *                          recognized canonical country — never a raw or locality string)
 *  - destination_name   -> locality (trimmed; state_name fallback; else null)
 *  - accommodation_category ("3.0"/"4.5"/null) -> stars = round(parseFloat), null when <= 0/missing
 *  - board_name         -> board (normalizeBoard)
 *  - transport_name     -> transport (normalizeTransport; every live row "Letecky" → flight)
 *  - start (ISO)        -> departureDate; nights -> nights
 *  - unit_price         -> pricePerPerson (per person)
 *  - provider_name      -> tourOperator (Čedok, Coral Travel…)
 *  - item_id            -> sourceOfferKey = offerKeyHash([item_id]) (unique per term + room variant)
 *
 * departureAirport is null: `departure_location_name` is a single city (Vídeň/Praha) but the brief's
 * field list does not request it, so it is left null (parity with alexandria). omnibusLowestPrice is
 * null: no such field.
 *
 * Dedup: multiple room variants of the same term come back as separate `item_id` rows, and price-asc
 * order is NOT guaranteed, so parseDatourPackages dedupes by (tour_id, start, nights) keeping the
 * CHEAPEST unit_price explicitly (falling back to item_id as the discriminator if tour_id is missing,
 * so genuinely distinct rows are never merged). fetchOffers then dedupes across countries by
 * sourceOfferKey.
 */

const API_URL = 'https://search.anchoice.cz/web-search';
const DETAIL_URL_BASE = 'https://datour.cz';
const SEARCH_URL_BASE = 'https://datour.cz/vyhledavani';
const REFERER = 'https://datour.cz/';

// Country -> anchoice `location` id, verified live 2026-07-07 (spec §16.1 row 16). 12 exotic
// countries → 12 page-1 requests/scan, one host, 3s gap ≈ 36 s.
const LOCATION_IDS: Record<string, string> = {
  Maledivy: '30182',
  Thajsko: '29828',
  Zanzibar: '452587',
  Mauricius: '451780',
  'Dominikánská republika': '28824',
  'Spojené arabské emiráty': '30594',
  Kuba: '28796',
  Vietnam: '29920',
  Seychely: '28075',
  'Srí Lanka': '450831',
  Indonésie: '29632',
  Mexiko: '29011',
};

interface DatourPackage {
  item_id?: string | null;
  tour_id?: string | number | null;
  tour_name?: string | null;
  detail?: string | null;
  country_name?: string | null;
  state_name?: string | null;
  destination_name?: string | null;
  accommodation_category?: string | number | null;
  board_name?: string | null;
  transport_name?: string | null;
  start?: string | null;
  nights?: string | number | null;
  unit_price?: string | number | null;
  package_price?: string | number | null;
  original_price?: string | number | null;
  package_discount?: string | number | null;
  provider_name?: string | null;
}

interface DatourResponse {
  packages?: DatourPackage[];
}

interface DatourQuery {
  label: string;
  url: string;
  fallbackUrl: string;
}

/** Coerce a JSON value that may arrive as a number OR a numeric string (the anchoice payload mixes
 *  both — `unit_price` is a number, `accommodation_category` is a string) to a finite number, else
 *  null. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round(n: number): number {
  return Math.round(n);
}

/** The bounded set of web-search requests: one page-1 query per exotic country. Deterministic and
 *  side-effect-free so tests can assert the exact URL set. */
function buildQueries(): DatourQuery[] {
  return Object.entries(LOCATION_IDS).map(([country, id]) => ({
    label: `${country} ${id}`,
    url: `${API_URL}?page=1&location=${id}&package=0`,
    fallbackUrl: `${SEARCH_URL_BASE}?location=${id}`,
  }));
}

function mapPackage(p: DatourPackage, fallbackUrl: string): NormalizedOffer | null {
  // unit_price (per person) is the sole live price; skip rows we can't price or place in time.
  const unitPrice = toNumber(p.unit_price);
  if (unitPrice === null || !(unitPrice > 0)) return null;
  const start = typeof p.start === 'string' && p.start.trim() ? p.start.trim() : null;
  if (!start) return null;
  const title = p.tour_name?.trim();
  if (!title) return null;

  const pricePerPerson = round(unitPrice);

  // package_price is the party total but is 0.0 on every live row → only used when actually > 0.
  const packagePrice = toNumber(p.package_price);
  const priceTotal = packagePrice !== null && packagePrice > 0 ? round(packagePrice) : null;

  // claimedOriginalPrice: original_price treated as per-person (see file header) — set only when it
  // is strictly above the current per-person price (never understates; 0/<=price → null).
  const originalPrice = toNumber(p.original_price);
  const claimedOriginalPrice =
    originalPrice !== null && round(originalPrice) > pricePerPerson ? round(originalPrice) : null;

  // claimedDiscountPct: package_discount is a percentage (unit-independent), valid only in (0,100).
  const discountPct = toNumber(p.package_discount);
  const claimedDiscountPct =
    discountPct !== null && discountPct > 0 && discountPct < 100 ? round(discountPct) : null;

  const cat = toNumber(p.accommodation_category);
  const stars = cat !== null && cat > 0 ? round(cat) : null;

  const board = normalizeBoard(p.board_name ?? null);
  const transport = normalizeTransport(p.transport_name ?? null);

  // Country must be a recognized canonical country or null — never a raw string, never the locality.
  const country = isKnownCountry(p.country_name) ? normalizeCountry(p.country_name) : null;
  const locality = p.destination_name?.trim() || p.state_name?.trim() || null;

  const detail = typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim() : null;
  const url = detail ? `${DETAIL_URL_BASE}/${detail}` : fallbackUrl;

  const nights = toNumber(p.nights);

  return {
    source: 'datour',
    sourceOfferKey: offerKeyHash([p.item_id]),
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
    tourOperator: p.provider_name?.trim() || null,
    url,
  };
}

/**
 * Maps a single `web-search` response to NormalizedOffer[]. Pure function: no I/O. `fallbackUrl` is
 * used as the offer URL for any row lacking a `detail` slug. Dedupes room variants of the same term
 * by (tour_id, start, nights), keeping the CHEAPEST unit_price (order is not guaranteed). Returns []
 * for a missing/empty `packages` array rather than throwing.
 */
export function parseDatourPackages(payload: unknown, fallbackUrl: string): NormalizedOffer[] {
  const packages = (payload as DatourResponse | null | undefined)?.packages;
  if (!Array.isArray(packages)) return [];

  // Key each term by (tour_id, start, nights); keep the cheapest room variant. Fall back to item_id
  // as the discriminator when tour_id is missing so genuinely distinct rows are never merged.
  const byTerm = new Map<string, { offer: NormalizedOffer; unitPrice: number }>();
  const order: string[] = [];

  for (const p of packages) {
    const offer = mapPackage(p, fallbackUrl);
    if (!offer) continue;
    const unitPrice = offer.pricePerPerson;
    const termKey =
      p.tour_id !== null && p.tour_id !== undefined && String(p.tour_id) !== ''
        ? `${String(p.tour_id)}|${offer.departureDate}|${offer.nights}`
        : `item:${offer.sourceOfferKey}`;

    const existing = byTerm.get(termKey);
    if (existing === undefined) {
      byTerm.set(termKey, { offer, unitPrice });
      order.push(termKey);
    } else if (unitPrice < existing.unitPrice) {
      byTerm.set(termKey, { offer, unitPrice });
    }
  }

  return order.map((k) => byTerm.get(k)!.offer);
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const queries = buildQueries();
  const init: RequestInit = { headers: { Referer: REFERER } };
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  for (const query of queries) {
    let offers: NormalizedOffer[];
    try {
      const json = await ctx.http.json(query.url, init);
      offers = parseDatourPackages(json, query.fallbackUrl);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further queries (politeness) but keep the
        // offers earlier queries already yielded.
        ctx.log(`datour: query ${query.label} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`datour: query ${query.label} web-search failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      // The same term can surface under more than one country query, so dedupe globally by
      // sourceOfferKey (the per-term+room item_id hash).
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // ALL queries failed: not "market empty" but "saw nothing because every request failed".
    // Rethrow (alexandria/fischer pattern) so runScan records this source as 'failed' rather than
    // silently degrading to [] (which would flip known offers inactive and mute the health alert).
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`datour: all web-search queries failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`datour: fetched ${all.length} offers across ${successCount} queries`);
  return all;
}

export const datour: SourceAdapter = {
  name: 'datour',
  fetchOffers,
};
