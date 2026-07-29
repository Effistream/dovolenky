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
 * Query shape: `web-search?page=1&location=<ids>&package=0&page_size=<n>&adults_count=<n>`.
 * Returns `{ total, total_docs, packages[] }` ordered by `unit_price` ASCENDING (server default —
 * we send no `sort`, see below). Every parameter here is one the site's own search page sends;
 * `page_size` is read verbatim out of the search bundle (chunk 76589: `page_size:18` on every
 * pagination click), and `location` accepts a `|`-joined id list (URL-encoded `%7C`) so several
 * countries can share one request. (The earlier-recon `POST /search` has a NON-functional country
 * filter — unused.)
 *
 * ── Live recon 2026-07-29 (curl, Chrome UA + Referer; supersedes the 2026-07-07 notes) ──
 *  (a) `page_size` is honoured up to at least 1000 (Thajsko: page_size=1000 → 506 rows, total 508),
 *      but the response is generated at roughly 0.09 s/row: 50 rows ≈ 4.5 s, 150 ≈ 13.8 s, 300 ≈
 *      23.1 s, 500 ≈ 44 s. HttpClient aborts a single request after 25 s, so page_size is capped
 *      well below that ceiling (see the budget block below). This is the reason the adapter buys
 *      coverage with page_size rather than with `page=2,3,4…`: same rows, a third of the requests.
 *  (b) `adults_count` is honoured (adults_count=3 → `persons: [18,18,18]`, total 168 not 187, prices
 *      shift) and its default is 2, i.e. the previous "send nothing" behaviour. It is now sent
 *      explicitly from ctx.adults so the prices are provably for the party size we advertise.
 *  (c) Ordering: the endpoint's sort options are person_price / group_price / term / category /
 *      trip_advisor_rating (search bundle), and with no `sort` the backend returns person_price ASC.
 *      We deliberately keep that default — datour publishes NO discount plane at all (see below), so
 *      there is no "discounted first" ordering to switch to, and price-ascending is the slice a
 *      price watcher with a 60 000 CZK profile cap actually wants.
 *  (d) Offer URL: `https://datour.cz/{detail}` is a 404. datour.cz is a Next.js catch-all that
 *      answers HTTP 200 for ANY path (`https://datour.cz/zzz-nonexistent/abc` renders the site 404
 *      too), so the old header's "the router echoes the detail segments, therefore the route is
 *      canonical" argument was worthless. Oracle is `__NEXT_DATA__`: `/{detail}` → page
 *      `/[...subpage]`, `props.pageProps.notFound: true`, body "Tady žádné zájezdy ani informace
 *      nejsou…"; `/zajezd/{detail}` → page `/detail-hotel` with real `pageProps.data`. Re-verified
 *      2026-07-29 on `maledivy/ari-atoll/-ari-atol-jih-/liberty-guesthouse-maldives`
 *      (25.7 KB notFound vs 114.6 KB real detail page). Hence DETAIL_URL_BASE ends in `/zajezd`.
 *      The `?item_id=<item_id_encrypted>` suffix is the site's own card link (search bundle:
 *      `href:"/zajezd/".concat(detail,"?item_id=",…)`) and upgrades the page from `/detail-hotel`
 *      (hotel, cheapest term) to `/detail` (the exact term). `adults_count` is deliberately omitted
 *      from the link: the page defaults to 2 adults, matching config scan.adults=2 — revisit if
 *      that config ever changes.
 *  (e) `accommodation_category` half-steps are TRUNCATED by the platform, not rounded: detail page
 *      `hotel_category` is 3 for `'3.5'` (thajsko/khao-lak/khao-lak-palm-beach) and 5 for `'5.5'`
 *      (thajsko/ko-samui/w-koh-samui). The old `Math.round` inflated ~8 % of rows by one star.
 *  (f) `departure_location_name` is populated on ~83 % of rows and is NOT always Czech: across an
 *      811-offer live run it is Praha 508 / Vídeň 144 / Bratislava 17 / Mnichov 1 / Katowice 1 /
 *      null 140. Dropping it made a Vienna departure look CZ-equivalent on the board, so it is now
 *      mapped to departureAirport (a city name, same convention as skrz.ts `deptPlace.title`).
 *      The literal placeholder "Neuvedeno" is mapped to null rather than to a fake city.
 *
 * ── Request budget (the hard constraint; run.ts aborts fetchOffers at 240 s) ──
 * Cost per query ≈ 3 s host gap + ~0.5 s overhead + ~0.09 s per returned row. The plan below is
 * 14 requests / ≈820 rows and measured 110–116 s end-to-end on 2026-07-29, i.e. >50 % headroom (the
 * scan runs on a GitHub Actions runner, which may be slower than the recon machine — the headroom
 * is the point). MAX_REQUESTS is a hard cap so a future edit to the country table cannot silently
 * explode the count; PAGE_SIZE/GROUP_PAGE_SIZE keep every single response under the 25 s
 * per-request HttpClient timeout.
 *  - 12 countries with more inventory than one page → one request each, page_size=PAGE_SIZE.
 *  - 12 small countries (total ≤ 40 rows each, 214 rows combined) → 2 batched `location=a|b|c`
 *    requests, page_size=GROUP_PAGE_SIZE. Batching only preserves per-country coverage while the
 *    batch's `total` fits in one page (136 and 78 rows on 2026-07-29, against a 150 page size), so
 *    fetchOffers logs a `truncated` line whenever `total` exceeds the rows we got back — that line
 *    is the tripwire for "a batch outgrew its page, split it".
 *
 * Known, accepted limitation: for the big countries this is still the CHEAPEST slice, not the whole
 * catalogue. With page_size=50 Thajsko is covered from 15 839 to 21 629 CZK against the profile's
 * 60 000 CZK cap (its full 508 rows reach 121 770). Closing that would need ~440 rows for Thajsko
 * alone (~40 s) and does not fit the 240 s budget together with 23 other countries; the cheapest
 * slice is also the slice the exotika profile is most likely to match. PAGE_SIZE is the single dial
 * for trading budget against depth — 70 measured 1 034 offers in 145.6 s, also inside the budget.
 *
 * Pricing decision (documented because it is non-obvious):
 *  - `unit_price` is the PER-PERSON price (spec §16.1: "unit_price = za osobu") and is the sole live
 *    price → `pricePerPerson = round(unit_price)`; rows with `unit_price <= 0` are skipped. Verified
 *    against the site's own badge ("Cena za osobu od 22 529 Kč" = adapter 22529).
 *  - `package_price` (the party total) is `0.0` on EVERY live row — this endpoint does not populate
 *    the "package" pricing plane — so it is never used as the price source; `priceTotal` is set only
 *    when `package_price > 0`, else null.
 *  - `package_discount` is `0.0` on every live row (811/811 on 2026-07-29), so `claimedDiscountPct`
 *    — the only claimed field that feeds discount.ts's `fake` detector and format.ts's "uvádí
 *    slevu" line — is always null for datour. Every datour alert therefore comes from our own
 *    30-day price history, which is exactly why breadth of coverage matters more here than for
 *    discount-publishing sources.
 *  - `original_price` was 0.0 on all 210 rows the old page-1 adapter ever saw; widening coverage
 *    made the branch live: 19 of 811 rows carry it, ALL of them Kapverdy/Blue Style first-minute
 *    terms. It is read as PER-PERSON (directly comparable to `unit_price`), and that reading is
 *    load-bearing enough to record the evidence: `original_fid` equals `price_id`, i.e. it is the
 *    pre-recalculation price of the SAME per-person record; and the party-total reading is
 *    falsified outright — `original_price/2` lands BELOW `unit_price` on several rows (Ouril Pontao
 *    34 947 vs 18 890; "Kapverdy – zelené Santiago" 52 990 vs 49 990), which no crossed-out price
 *    can do. Caveat kept honest: datour.cz never renders `original_price` (no JS chunk references
 *    it), so there is no site-side oracle to confirm the resulting 6–57 % implied discounts.
 *    `claimedOriginalPrice` is set only when `original_price > pricePerPerson` (mirrors the
 *    alexandria "original > current" guard; cannot understate).
 *
 * Per-package field mapping:
 *  - tour_name          -> title
 *  - detail (+ item_id_encrypted) -> url
 *                          (`https://datour.cz/zajezd/<detail>?item_id=<item_id_encrypted>`;
 *                          the query is dropped when item_id_encrypted is absent, and the whole URL
 *                          falls back to the per-query search page when `detail` is absent)
 *  - country_name       -> country, via COUNTRY_NAME_ALIASES + isKnownCountry/normalizeCountry guard
 *                          (null when not a recognized canonical country — never a raw or locality
 *                          string). The alias table exists because anchoice spells Kapverdy
 *                          "Kapverdské ostrovy", which COUNTRY_BY_KEY does not know: without it all
 *                          37 Kapverdy rows would ingest with country=null and be filtered out.
 *  - destination_name   -> locality (trimmed; state_name fallback; else null)
 *  - accommodation_category ("3.0"/"4.5"/null) -> stars = FLOOR (the platform truncates, see (e)),
 *                          null when the floored value is <= 0 (so '0.4'/'0.0' yield null, never 0)
 *  - board_name         -> board (normalizeBoard)
 *  - transport_name     -> transport (normalizeTransport; almost all rows "Letecky" → flight, but a
 *                          minority — 20/210 in the 2026-07-07 audit — are "Vlastní" → own: cruise
 *                          legs priced WITHOUT airfare. Faithful mapping, but worth knowing that
 *                          the exotika profile omits the transport filter on purpose, so a 3 170 CZK
 *                          Caribbean cruise segment can outrank real flight packages on price)
 *  - departure_location_name -> departureAirport (city name: Praha/Vídeň/Bratislava/Mnichov/…;
 *                          the "Neuvedeno" placeholder → null)
 *  - start (ISO)        -> departureDate; nights -> nights
 *  - unit_price         -> pricePerPerson (per person)
 *  - provider_name      -> tourOperator (Čedok, Coral Travel…)
 *  - sourceOfferKey     = offerKeyHash([tour_id, start, nights, board_id]) — a STABLE departure-
 *                          term+board key, room-agnostic (matching alexandria). item_id encodes the
 *                          room/flight variant, so hashing it would rotate the key whenever the
 *                          cheapest room variant changes week-to-week, resetting price history and
 *                          muting price-drop alerts. departureAirport is deliberately NOT in the key
 *                          (unlike fischer): live pages show one departure city per term row — 506/506
 *                          distinct keys on a full 508-row Thajsko pull — so adding it would only
 *                          reset every stored key for no gain. offerKeyHash([item_id]) is the
 *                          fallback ONLY when tour_id is missing (unobserved live).
 *
 * omnibusLowestPrice is null: no such field.
 *
 * Dedup: multiple room variants of the same term can come back as separate `item_id` rows, and
 * price-asc order is NOT guaranteed within a bucket, so parseDatourPackages buckets rows by the
 * (tour_id, start, nights, board_id) key — i.e. by sourceOfferKey, whose item_id fallback keeps
 * tour_id-less rows unmerged — keeping the CHEAPEST unit_price explicitly. Different boards of the
 * same term stay distinct offers (board is part of the cross-source match identity). fetchOffers
 * then dedupes across queries by sourceOfferKey.
 */

const API_URL = 'https://search.anchoice.cz/web-search';
const DETAIL_URL_BASE = 'https://datour.cz/zajezd';
const SEARCH_URL_BASE = 'https://datour.cz/vyhledavani';
const REFERER = 'https://datour.cz/';

// Rows per request. Sized against two ceilings at once: HttpClient's 25 s per-request timeout
// (~0.09 s/row ⇒ 50 rows ≈ 4.5 s, 150 rows ≈ 14 s) and run.ts's 240 s ADAPTER_FETCH_TIMEOUT_MS for
// the whole plan. Raising these is the cheap way to buy coverage — but re-measure first.
const PAGE_SIZE = 50;
const GROUP_PAGE_SIZE = 150;

// Hard ceiling on requests per scan. The plan below is 14; this exists so that adding countries to
// LOCATION_IDS (or a batch getting split) can never silently push the adapter past its time budget
// and get the whole source recorded as 'failed'. 20 × (3 s gap + ~7 s response) ≈ 200 s < 240 s.
const MAX_REQUESTS = 20;

// Country -> anchoice `location` id. All 24 ids re-verified live 2026-07-29 (each returns HTTP 200
// with country_name matching); the trailing number is that country's `total` on the same day. This
// is the full country list of the `exotika` watch profile — config/watch.yaml lists 24 countries and
// all 24 are queried here (the adapter used to ship only the first 12).
const LOCATION_IDS: Record<string, string> = {
  // One request per country — inventory larger than a single page.
  Thajsko: '29828', //                  508
  'Spojené arabské emiráty': '30594', // 265
  'Dominikánská republika': '28824', //  198
  Maledivy: '30182', //                  187
  Mexiko: '29011', //                    139
  'Srí Lanka': '450831', //              117
  Japonsko: '29513', //                  112
  Indonésie: '29632', //                 106
  Mauricius: '451780', //                103
  Zanzibar: '452587', //                  84
  Vietnam: '29920', //                    71
  Seychely: '28075', //                   53
  // Batched — small enough that a shared page covers them whole.
  Keňa: '27990', //                       40
  Kapverdy: '452557', //                  37
  'Jihoafrická republika': '28422', //    32
  Filipíny: '29724', //                   27
  Réunion: '567314', //                   24
  Kambodža: '599485', //                  23
  Kuba: '28796', //                       14
  Nepál: '30211', //                       7
  Peru: '29246', //                        5
  Namibie: '28408', //                     3
  Tanzanie: '452666', //                   1
  Madagaskar: '27998', //                  1
};

/** The query plan: each entry becomes exactly ONE web-search request. Single-country groups get
 *  PAGE_SIZE rows; multi-country groups share GROUP_PAGE_SIZE rows and are sized so the group's
 *  combined `total` fits inside one page (136 and 78 rows on 2026-07-29). */
const QUERY_GROUPS: string[][] = [
  ['Thajsko'],
  ['Spojené arabské emiráty'],
  ['Dominikánská republika'],
  ['Maledivy'],
  ['Mexiko'],
  ['Srí Lanka'],
  ['Japonsko'],
  ['Indonésie'],
  ['Mauricius'],
  ['Zanzibar'],
  ['Vietnam'],
  ['Seychely'],
  ['Keňa', 'Kapverdy', 'Jihoafrická republika', 'Filipíny'],
  ['Réunion', 'Kambodža', 'Kuba', 'Nepál', 'Peru', 'Namibie', 'Tanzanie', 'Madagaskar'],
];

/** anchoice spells a few countries differently from our canonical COUNTRY_BY_KEY list. Applied
 *  BEFORE the isKnownCountry gate, otherwise those rows ingest with country=null and every
 *  country-scoped watch profile drops them. Keys are lowercased NFC. */
const COUNTRY_NAME_ALIASES: Record<string, string> = {
  'kapverdské ostrovy': 'Kapverdy',
};

/** `departure_location_name` placeholders that mean "unknown", not a place. Observed live on 2 of
 *  1 034 rows; without this they would render as a departure city called "Neuvedeno" on the board. */
const DEPARTURE_PLACEHOLDERS = new Set(['neuvedeno', 'neuvedeno.', '-', 'n/a']);

interface DatourPackage {
  item_id?: string | null;
  item_id_encrypted?: string | null;
  tour_id?: string | number | null;
  tour_name?: string | null;
  detail?: string | null;
  country_name?: string | null;
  state_name?: string | null;
  destination_name?: string | null;
  accommodation_category?: string | number | null;
  board_name?: string | null;
  board_id?: string | number | null;
  transport_name?: string | null;
  departure_location_name?: string | null;
  start?: string | null;
  nights?: string | number | null;
  unit_price?: string | number | null;
  package_price?: string | number | null;
  original_price?: string | number | null;
  package_discount?: string | number | null;
  provider_name?: string | null;
}

interface DatourResponse {
  total?: number | string | null;
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

/** The bounded set of web-search requests (see QUERY_GROUPS). Deterministic and side-effect-free so
 *  tests can assert the exact URL set, and hard-capped at MAX_REQUESTS. */
export function buildQueries(adults: number): DatourQuery[] {
  const adultsCount = Number.isFinite(adults) && adults > 0 ? Math.round(adults) : 2;

  return QUERY_GROUPS.slice(0, MAX_REQUESTS).map((countries) => {
    const ids = countries.map((c) => LOCATION_IDS[c]).filter((id): id is string => Boolean(id));
    // `|` is the endpoint's OR separator for `location`; encode it so the URL we build is the URL
    // that goes on the wire (fetch would otherwise normalize it to %7C behind our back).
    const location = encodeURIComponent(ids.join('|'));
    const pageSize = countries.length === 1 ? PAGE_SIZE : GROUP_PAGE_SIZE;
    return {
      label: countries.join('+'),
      url: `${API_URL}?page=1&location=${location}&package=0&page_size=${pageSize}&adults_count=${adultsCount}`,
      fallbackUrl: `${SEARCH_URL_BASE}?location=${location}`,
    };
  });
}

/** Departure city or null — a single city name (Praha/Vídeň/Bratislava/Frankfurt), same convention
 *  as skrz.ts. Placeholders are mapped to null so "unknown" never masquerades as a place. */
function resolveDepartureAirport(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return DEPARTURE_PLACEHOLDERS.has(trimmed.normalize('NFC').toLowerCase()) ? null : trimmed;
}

/** Canonical country or null. Runs the anchoice spelling through COUNTRY_NAME_ALIASES first. */
function resolveCountry(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const name = COUNTRY_NAME_ALIASES[trimmed.normalize('NFC').toLowerCase()] ?? trimmed;
  return isKnownCountry(name) ? normalizeCountry(name) : null;
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

  // Stars: FLOOR, because the platform itself truncates half-steps ('3.5' renders as hotel_category
  // 3 on the offer's own detail page). Guard applies after flooring so '0.4' yields null, never 0.
  const cat = toNumber(p.accommodation_category);
  const catFloored = cat !== null ? Math.floor(cat) : null;
  const stars = catFloored !== null && catFloored > 0 ? catFloored : null;

  const board = normalizeBoard(p.board_name ?? null);
  const transport = normalizeTransport(p.transport_name ?? null);

  // Country must be a recognized canonical country or null — never a raw string, never the locality.
  const country = resolveCountry(p.country_name);
  const locality = p.destination_name?.trim() || p.state_name?.trim() || null;

  // `/zajezd/{detail}` is the hotel page; appending `?item_id=<item_id_encrypted>` is exactly what
  // the site's own result card links to and lands on the TERM we priced (page `/detail`) instead of
  // the hotel's cheapest term. Verified to degrade gracefully: a 3-week-old item_id still renders
  // the term page at its current price.
  // Caveat, measured 2026-07-29 on 3 random offers of a live run: the landing page's
  // `pageProps.data.person_price` equals our pricePerPerson on 2 of 3 (Mauricius 32 305, Nepál
  // 198 950) but NOT on the third — Thajsko "Naina Resort & Spa" renders 16 759 against our 15 839,
  // and the search API re-queried minutes later still returned 15 839. So the platform's search
  // index and its own detail page can price the same term differently, and this is NOT confined to
  // Worldee products (that row is Čedok). The adapter deliberately mirrors the search index, which
  // is what the site's own result cards show; the consequence is that a datour price alert can sit
  // a few % under the click-through price.
  const detail = typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim() : null;
  const termId = p.item_id_encrypted?.trim();
  const url = detail
    ? `${DETAIL_URL_BASE}/${detail}${termId ? `?item_id=${encodeURIComponent(termId)}` : ''}`
    : fallbackUrl;

  const nights = toNumber(p.nights);

  // STABLE per-term+board key (room-agnostic, matching alexandria): item_id encodes the room/flight
  // variant, so hashing it would rotate the key whenever the cheapest variant of a term changes,
  // resetting the watcher's price history. item_id is the fallback ONLY when tour_id is missing.
  const tourId =
    p.tour_id !== null && p.tour_id !== undefined && String(p.tour_id).trim() !== ''
      ? p.tour_id
      : null;
  const sourceOfferKey =
    tourId !== null
      ? offerKeyHash([tourId, start, nights, p.board_id])
      : offerKeyHash([p.item_id]);

  return {
    source: 'datour',
    sourceOfferKey,
    title,
    country,
    locality,
    stars,
    board,
    transport,
    departureAirport: resolveDepartureAirport(p.departure_location_name),
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
 * used as the offer URL for any row lacking a `detail` slug. Dedupes room variants of the same
 * term+board — bucketed by sourceOfferKey, which IS the (tour_id, start, nights, board_id) hash
 * (item_id-hash fallback keeps tour_id-less rows unmerged) — keeping the CHEAPEST unit_price
 * explicitly (order is not guaranteed). Returns [] for a missing/empty `packages` array rather than
 * throwing.
 */
export function parseDatourPackages(payload: unknown, fallbackUrl: string): NormalizedOffer[] {
  const packages = (payload as DatourResponse | null | undefined)?.packages;
  if (!Array.isArray(packages)) return [];

  const byTerm = new Map<string, NormalizedOffer>();
  const order: string[] = [];

  for (const p of packages) {
    const offer = mapPackage(p, fallbackUrl);
    if (!offer) continue;

    const key = offer.sourceOfferKey;
    const existing = byTerm.get(key);
    if (existing === undefined) {
      byTerm.set(key, offer);
      order.push(key);
    } else if (offer.pricePerPerson < existing.pricePerPerson) {
      byTerm.set(key, offer);
    }
  }

  return order.map((k) => byTerm.get(k)!);
}

/** Rows we asked for vs rows that exist. Logged (not thrown) so a country/batch outgrowing its page
 *  shows up in the scan log instead of silently capping coverage the way page=1 used to. */
function logTruncation(ctx: SourceContext, label: string, payload: unknown): void {
  const response = payload as DatourResponse | null | undefined;
  const returned = Array.isArray(response?.packages) ? response.packages.length : 0;
  const total = toNumber(response?.total);
  if (total !== null && total > returned) {
    ctx.log(`datour: ${label} truncated at ${returned}/${total} rows (price-ascending slice)`);
  }
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const queries = buildQueries(ctx.adults);
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
      logTruncation(ctx, query.label, json);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further queries (politeness) but keep the
        // offers earlier queries already yielded. Record the block as lastError so a block BEFORE
        // the first success still trips the successCount===0 rethrow below (→ BLOCKED marker → 24h
        // backoff) instead of silently degrading to [].
        lastError = err;
        ctx.log(`datour: query ${query.label} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`datour: query ${query.label} web-search failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      // The same term can surface under more than one query, so dedupe globally by sourceOfferKey
      // (the per-term+board [tour_id, start, nights, board_id] hash).
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
