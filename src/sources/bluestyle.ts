import type { NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { SourceBlockedError } from '../core/http.js';
import { normalizeBoard, normalizeCountry, parseCzDate, offerKeyHash } from '../core/normalize.js';

const BASE_URL = 'https://www.blue-style.cz';
const GRAPHQL_URL = `${BASE_URL}/graphql`;

/**
 * Live recon 2026-07-29 (Chrome UA, plain curl + POST /graphql), replacing the 2026-07-04
 * SSR-HTML approach:
 *
 * The old adapter GET-ed exactly one page (/last-minute/) and read the `__NEXT_DATA__` Apollo
 * cache. That page is page 1 of 108 — its own `Pagination` node says
 * {itemsPerPage:10, page:1, pageCount:108, totalItems:1072} — and `?page=2` is ignored by the
 * SSR (query param lands in `__NEXT_DATA__.query` but the Apollo key stays `...,"page":1`), so
 * the adapter was permanently stuck at 10 offers in a 12 590–26 390 CZK band. Paging happens
 * client-side against https://www.blue-style.cz/graphql, which we now call directly. Two
 * consequences, both good: the payload drops from 1.1 MB of HTML to ~50 KB of JSON per request,
 * and the intermittent "HTTP 200 with an empty apolloState" SSR failure mode disappears
 * (a GraphQL failure is now an explicit error instead of a silent zero).
 *
 * What is queried and why:
 *  - Request 1 resolves every landing path to its `idThematicHoliday` via `url(url:)` (the
 *    site's own router query), aliased so all 16 paths cost ONE request. Ids are not hardcoded
 *    because they are content-managed (last-minute=101, exotika=1, prémiová=38 on 2026-07-29)
 *    and would rot silently.
 *  - Requests 2..N run `thematicHoliday(idThematicHoliday:, hotelFilter:{page:})`, again
 *    aliased — up to QUERIES_PER_REQUEST listing pages per HTTP request. `hotelFilter` has NO
 *    page-size lever (limit/perPage/pageSize/first/offset/take all rejected as "Unknown field"),
 *    so 10 hotels per page-query is a hard site-side cap and aliasing is the only way to buy
 *    coverage without burning requests.
 *  - LISTING_PLAN is breadth-first: all 16 thematic/last-minute/first-minute landings get at
 *    least page 1, and only the big or otherwise-unreachable pools go deeper. /exoticka-dovolena/
 *    (280 hotels, to 63 890), /premiova-dovolena/ (48, to 82 690) and /first-minute-exotika/
 *    (110, to 54 990) are what lift the source out of its old 26 390 CZK ceiling — Omán,
 *    Zanzibar, Maledivy and Kypr are simply not present in /last-minute/.
 *  - The two last-minute pools additionally get one page sorted by DISCOUNT/DESCENDING. Default
 *    ordering (orderBy:null = "Doporučení CK") is arbitrary w.r.t. both price and discount, so a
 *    deal board that only ever saw the default first pages would miss the discount tail entirely.
 *
 * Every hotel node carries `cheapestTerm` (its best term) AND `nearestTerms` (3 alternative
 * departure dates). Both are genuine bookable terms — the audit opened several of each in a
 * browser and price/date/nights/board matched the deep link exactly — so both are mapped.
 * `nearestTerms` additionally carry `departureCity`/`depCity`, which is what lets us fill
 * `departureAirport` (it used to be hardcoded null, which parked every bluestyle offer under
 * computeMatchKey's '*' airport bucket and blocked all cross-source matching).
 *
 * Country/region pages (/recko/, /egypt/, ...) are still NOT fetched: re-verified 2026-07-29 that
 * their CheapestTerm nodes are partial "cheapest teaser" fragments with no hotel name.
 */
interface ListingPlan {
  path: string;
  /** Listing pages (10 hotels each) to pull in default "Doporučení CK" order. */
  pages: number;
  /** Also pull page 1 sorted by DISCOUNT/DESCENDING — the deal tail the default order hides. */
  alsoByDiscount?: boolean;
}

/** Exported so tests can assert the plan still fits inside MAX_REQUESTS. */
export const LISTING_PLAN: ListingPlan[] = [
  { path: '/last-minute/', pages: 3, alsoByDiscount: true },
  { path: '/super-last-minute/', pages: 2, alsoByDiscount: true },
  { path: '/first-minute/', pages: 2 },
  { path: '/first-minute-exotika/', pages: 2 },
  { path: '/exoticka-dovolena/', pages: 3 },
  { path: '/premiova-dovolena/', pages: 2 },
  { path: '/poznavaci-zajezdy/', pages: 1 },
  { path: '/multigeneracni-dovolena/', pages: 1 },
  { path: '/rodinna-dovolena-plna-zabavy/', pages: 1 },
  { path: '/all-inclusive/', pages: 1 },
  { path: '/hotely-s-aquaparkem/', pages: 1 },
  { path: '/letecky-z-ostravy/', pages: 1 },
  { path: '/letecky-z-brna/', pages: 1 },
  { path: '/letecky-z-pardubic/', pages: 1 },
  { path: '/dovolena-pro-dospele/', pages: 1 },
  { path: '/klidna-dovolena-pro-seniory/', pages: 1 },
];

/** Aliased listing-page queries per HTTP request. 10 aliases ≈ 6–10 s server-side, ~130 KB. */
export const QUERIES_PER_REQUEST = 10;

/**
 * Hard request ceiling for one fetchOffers call, enforced at runtime (not just implied by
 * LISTING_PLAN). Budget: src/core/run.ts aborts an adapter after ADAPTER_FETCH_TIMEOUT_MS =
 * 240 s, and HttpClient serializes same-host requests with a 3 s gap, so a request costs
 * ~3 s gap + up to ~10 s of server time. The current plan needs 1 id request + 3 batches = 4
 * (measured ~35 s end to end); the cap leaves room for LISTING_PLAN to grow a little but stops
 * a future site change (e.g. aliases suddenly rejected) from silently exploding into a timeout,
 * which would mark the whole source 'failed' and drop it off the board.
 */
export const MAX_REQUESTS = 8;

const STAR_MAP: Record<string, number> = {
  STAR_1: 1,
  STAR_1_PLUS: 1,
  STAR_2: 2,
  STAR_2_PLUS: 2,
  STAR_3: 3,
  STAR_3_PLUS: 3,
  STAR_4: 4,
  STAR_4_PLUS: 4,
  STAR_5: 5,
  STAR_5_PLUS: 5,
};

/**
 * `depCity` id -> departure city, seeded from live recon 2026-07-29 and extended at runtime from
 * every `nearestTerms` node in the response (those spell the city out, `cheapestTerm` does not —
 * it only carries the id inside its deep-link `?depCity=` param). The seed keeps the mapper
 * deterministic when a payload happens to contain no nearestTerms at all.
 */
const DEPARTURE_CITY_BY_ID: Record<number, string> = {
  2: 'Praha',
  10: 'Brno',
  11: 'Ostrava',
  810: 'Pardubice',
};

/** Selection set shared by every aliased listing-page query. */
const HOTEL_SELECTION = `
    name
    url
    stars
    countryName
    destinationName
    cheapestTerm { priceFrom nightCount dayCount percentageDiscount boardingType departureDate url }
    nearestTerms { priceFrom nights dayCount percentageDiscount boardingType departureDate url departureCity depCity }`;

interface RawTerm {
  priceFrom?: number;
  /** `cheapestTerm` spells it `nightCount`, `nearestTerms` spells it `nights`. */
  nightCount?: number;
  nights?: number;
  dayCount?: number;
  percentageDiscount?: number;
  boardingType?: string;
  departureDate?: string;
  url?: string;
  departureCity?: string;
  depCity?: number;
}

export interface RawHotel {
  name?: string;
  url?: string;
  stars?: string;
  countryName?: string;
  destinationName?: string;
  cheapestTerm?: RawTerm | null;
  nearestTerms?: RawTerm[] | null;
}

interface PageJob {
  path: string;
  id: number;
  page: number;
  /** null = the site's default "Doporučení CK" ordering. */
  orderBy: 'DISCOUNT' | null;
}

function starsFromEnum(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  return STAR_MAP[raw] ?? null;
}

function buildIdRequest(paths: string[]): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const defs: string[] = [];
  const sels: string[] = [];
  paths.forEach((path, i) => {
    variables[`u${i}`] = path;
    defs.push(`$u${i}: String!`);
    sels.push(`p${i}: url(url: $u${i}) { httpStatusCode ... on UrlStatus200Ok { template params } }`);
  });
  return { query: `query BsRoutes(${defs.join(', ')}) { ${sels.join(' ')} }`, variables };
}

/**
 * Reads the aliased `url(url:)` response back into path -> idThematicHoliday. Paths that do not
 * resolve to a 200 THEMATIC_HOLIDAY page (renamed slug, 404, template change) are simply absent
 * from the map — the caller drops them and keeps going rather than failing the whole source.
 */
export function parseListingIds(body: unknown, paths: string[]): Map<string, number> {
  const data = (body as { data?: Record<string, unknown> })?.data;
  const out = new Map<string, number>();
  if (!data || typeof data !== 'object') return out;

  paths.forEach((path, i) => {
    const node = data[`p${i}`] as { httpStatusCode?: number; template?: string; params?: unknown } | null | undefined;
    if (!node || node.httpStatusCode !== 200 || node.template !== 'THEMATIC_HOLIDAY') return;
    // `params` is a JSON *scalar*: the server hands it over as a JSON-encoded string.
    let params: unknown = node.params;
    if (typeof params === 'string') {
      try {
        params = JSON.parse(params);
      } catch {
        return;
      }
    }
    const id = (params as { idThematicHoliday?: unknown })?.idThematicHoliday;
    if (typeof id === 'number' && Number.isFinite(id)) out.set(path, id);
  });

  return out;
}

function buildListingRequest(jobs: PageJob[]): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const defs: string[] = [];
  const sels: string[] = [];
  jobs.forEach((job, i) => {
    variables[`i${i}`] = job.id;
    variables[`f${i}`] = {
      arrCity: [],
      orderBy: job.orderBy,
      orderDirection: job.orderBy ? 'DESCENDING' : null,
      page: job.page,
    };
    defs.push(`$i${i}: Int`, `$f${i}: ThematicHolidayHotelFilterInput`);
    sels.push(
      `q${i}: thematicHoliday(idThematicHoliday: $i${i}, hotelFilter: $f${i}) { hotels {${HOTEL_SELECTION} } }`,
    );
  });
  return { query: `query BsListing(${defs.join(', ')}) { ${sels.join(' ')} }`, variables };
}

/**
 * Flattens every aliased `thematicHoliday` result in one batched response into a hotel list.
 * A partially-failed batch (GraphQL puts `null` on the aliases it could not resolve but still
 * returns the rest) yields the aliases that did resolve instead of nothing.
 */
export function parseHotelsResponse(body: unknown): RawHotel[] {
  const data = (body as { data?: Record<string, unknown> })?.data;
  if (!data || typeof data !== 'object') return [];

  const out: RawHotel[] = [];
  for (const value of Object.values(data)) {
    const hotels = (value as { hotels?: unknown } | null)?.hotels;
    if (!Array.isArray(hotels)) continue;
    for (const hotel of hotels) {
      if (hotel && typeof hotel === 'object') out.push(hotel as RawHotel);
    }
  }
  return out;
}

/**
 * Nights, from whichever field the term type happens to use. `dayCount` (always nights + 1 on
 * this site) is the last resort: a minority of nearestTerms ship `nights: null` while still
 * carrying dayCount, and a null here would knock the offer out of discount.ts's per-night
 * hotel/locality/market reference rungs.
 */
function nightsOf(term: RawTerm): number | null {
  if (typeof term.nights === 'number') return term.nights;
  if (typeof term.nightCount === 'number') return term.nightCount;
  if (typeof term.dayCount === 'number' && term.dayCount > 1) return term.dayCount - 1;
  return null;
}

function depCityFromUrl(url: string): number | null {
  const raw = url.split('?')[1];
  if (!raw) return null;
  const value = new URLSearchParams(raw).get('depCity');
  if (value === null) return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

/**
 * Maps raw hotel nodes to offers. Two passes on purpose: the first learns every
 * `depCity` -> city pairing present anywhere in the payload (only `nearestTerms` spell the city
 * out), the second uses it to resolve `departureAirport` for `cheapestTerm` nodes, which carry
 * the id in their deep link only. Deduped by sourceOfferKey — the landing pages overlap heavily
 * (/all-inclusive/ is largely a subset of /last-minute/) and a hotel's cheapestTerm is sometimes
 * repeated inside its own nearestTerms.
 */
export function mapBluestyleOffers(hotels: RawHotel[], adults: number): NormalizedOffer[] {
  const departureCityById = new Map<number, string>(
    Object.entries(DEPARTURE_CITY_BY_ID).map(([id, city]) => [Number(id), city]),
  );
  for (const hotel of hotels) {
    for (const term of hotel.nearestTerms ?? []) {
      if (typeof term?.depCity === 'number' && term.departureCity?.trim()) {
        departureCityById.set(term.depCity, term.departureCity.trim());
      }
    }
  }

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const hotel of hotels) {
    const terms: RawTerm[] = [];
    if (hotel.cheapestTerm) terms.push(hotel.cheapestTerm);
    for (const term of hotel.nearestTerms ?? []) if (term) terms.push(term);

    for (const term of terms) {
      const offer = mapOffer(hotel, term, adults, departureCityById);
      if (!offer) continue;
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      offers.push(offer);
    }
  }

  return offers;
}

function mapOffer(
  hotel: RawHotel,
  term: RawTerm,
  adults: number,
  departureCityById: Map<number, string>,
): NormalizedOffer | null {
  const title = hotel.name?.trim();
  if (!title) return null;
  if (typeof term.priceFrom !== 'number' || !Number.isFinite(term.priceFrom) || term.priceFrom <= 0) return null;
  const rawUrl = term.url ?? hotel.url;
  if (!rawUrl) return null;

  const url = new URL(rawUrl, BASE_URL).toString();
  const pricePerPerson = Math.round(term.priceFrom);

  // Only treat the discount as usable when it's a genuine percentage in (0, 100): pct <= 0 is
  // "no discount", and pct >= 100 would divide by zero or go negative in the original-price
  // formula below (producing Infinity/negative numbers), so both ends are guarded out.
  const pct = term.percentageDiscount;
  const claimedDiscountPct = typeof pct === 'number' && pct > 0 && pct < 100 ? pct : null;
  // Derived from Blue Style's already-rounded integer percentage, so it lands 0.3–2.2 % above the
  // site's own "dnes ušetříte" figure. Kept because the schema publishes no pre-discount price at
  // all (originalPrice/priceBefore/basePrice/discountAmount/... are all rejected as unknown fields
  // on both CheapestTerm and ResultHotelTerm, probed 2026-07-29) and the only exact source is the
  // detail page — one extra request per offer, which the request budget cannot pay for.
  const claimedOriginalPrice =
    claimedDiscountPct !== null ? Math.round(pricePerPerson / (1 - claimedDiscountPct / 100)) : null;

  // countryName is the hotel's own country ("Kapverdy", "Omán"); the URL slug is the fallback for
  // the rare node that omits it. destinationName is the resort/city and stays the locality.
  const urlPath = rawUrl.split('?')[0] ?? '';
  const firstSegment = urlPath.split('/').find((seg) => seg.length > 0) ?? null;
  const country = normalizeCountry(hotel.countryName ?? null) ?? normalizeCountry(firstSegment);
  const locality = hotel.destinationName?.trim() || null;
  const board = normalizeBoard(term.boardingType ?? null);
  const departureDate = parseCzDate(term.departureDate ?? null);
  const nights = nightsOf(term);
  const stars = starsFromEnum(hotel.stars);

  const depCityId = typeof term.depCity === 'number' ? term.depCity : depCityFromUrl(rawUrl);
  const departureAirport =
    term.departureCity?.trim() || (depCityId !== null ? (departureCityById.get(depCityId) ?? null) : null);

  // Blue Style is a fly-package operator, but rather than hardcode 'flight' we require the term
  // to actually name a departure airport or an airline — a handful of "další sezóna" preview
  // terms carry neither (nor a night count), and claiming a flight for those would be inventing
  // data. Everything with a departure city is a fly package: 'flight' matters because a
  // flight-only watch profile drops anything else.
  const transport: Transport = departureAirport !== null || rawUrl.includes('airline=') ? 'flight' : 'unknown';

  // Hashes normalized fields (title, ISO departure date, nights, board enum) rather than any raw
  // source id, consistent with the cedok adapter's pattern — stable across re-fetches, and it
  // collapses the duplicate term fragments the overlapping landing pages produce.
  //
  // departureAirport IS part of the key (same lesson as fischer.ts): the plan now includes
  // /letecky-z-brna/, /letecky-z-ostravy/ and /letecky-z-pardubic/, so the very same
  // hotel/date/nights/board legitimately exists as several differently-priced departures. Live
  // 2026-07-29: 15 such pairs, 8 of them with different prices (Pyramisa 2026-08-08 2n is
  // 13 290 from Ostrava and 19 690 from Brno). Without the airport those collapse into one
  // offer whose surviving price depends on which landing page the site happened to enumerate
  // first — i.e. the stored price flips between runs and fabricates a ±44 % "price change" in
  // price_snapshots. Falls back to the raw depCity id so an as-yet-unnamed departure city still
  // discriminates (and keeps the key stable) instead of hashing as null.
  //
  // This deliberately re-keys the handful of offers the pre-GraphQL adapter had stored: keeping
  // the old key byte-identical was only safe while the adapter fetched a single-airport pool.
  // markMissedOffers ages the stale rows out over MAX_MISSES runs rather than dropping them.
  const sourceOfferKey = offerKeyHash([title, departureDate, nights, board, departureAirport ?? depCityId]);

  return {
    source: 'bluestyle',
    sourceOfferKey,
    title,
    country,
    locality,
    stars,
    board,
    transport,
    departureAirport,
    departureDate,
    nights,
    pricePerPerson,
    // Blue Style quotes priceFrom per person for a 2-adult room (every `nearestTerms.room.adults`
    // in a 260-hotel sample is 2) and the detail page's "Cena celkem" is exactly 2 × that, so the
    // total is derivable for free — but only for that occupancy. For any other ctx.adults the site
    // reprices rather than scaling linearly, so leave it unknown instead of inventing a number.
    priceTotal: adults === 2 ? pricePerPerson * 2 : null,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator: null,
    url,
  };
}

/** Expands LISTING_PLAN into the flat list of (landing page, page number, ordering) queries. */
function buildJobs(idByPath: Map<string, number>): PageJob[] {
  const jobs: PageJob[] = [];
  for (const plan of LISTING_PLAN) {
    const id = idByPath.get(plan.path);
    if (id === undefined) continue;
    for (let page = 1; page <= plan.pages; page += 1) {
      jobs.push({ path: plan.path, id, page, orderBy: null });
    }
  }
  // Appended after the default-order pass so that, if the request cap ever truncates the run, it
  // is the discount tail that is lost rather than a whole landing page's baseline coverage.
  for (const plan of LISTING_PLAN) {
    const id = idByPath.get(plan.path);
    if (id === undefined || !plan.alsoByDiscount) continue;
    jobs.push({ path: plan.path, id, page: 1, orderBy: 'DISCOUNT' });
  }
  return jobs;
}

async function postGraphql(ctx: SourceContext, body: { query: string; variables: Record<string, unknown> }): Promise<unknown> {
  const raw = await ctx.http.text(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = JSON.parse(raw) as { data?: unknown; errors?: { message?: string }[] };
  if (!parsed.data) {
    // No data at all means the query itself was rejected (schema drift, blocked, 5xx body). Throw
    // so the caller counts it as a failed request instead of silently reporting zero offers.
    const message = parsed.errors?.[0]?.message ?? 'no data in GraphQL response';
    throw new Error(`bluestyle GraphQL error: ${message}`);
  }
  if (parsed.errors?.length) {
    // Partial failure: GraphQL nulls the aliases it could not resolve but still returns the rest,
    // so parseHotelsResponse keeps going and the run "succeeds" with quietly reduced coverage.
    // Log it — a per-alias error that becomes permanent (one landing page's schema drifting) would
    // otherwise shrink the source with nothing anywhere saying why.
    ctx.log(`bluestyle: ${parsed.errors.length} partial GraphQL error(s), first: ${parsed.errors[0]?.message ?? '?'}`);
  }
  return parsed;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const paths = LISTING_PLAN.map((p) => p.path);
  let requests = 0;

  // Step 1 — resolve every landing path to its idThematicHoliday in a single aliased request.
  // A failure here is fatal by construction: without ids there is no second request to make, so
  // rethrow (fischer/cedok pattern) and let runScan record 'failed' rather than returning [],
  // which would flip the source's whole live inventory inactive.
  requests += 1;
  const idBody = await postGraphql(ctx, buildIdRequest(paths));
  const idByPath = parseListingIds(idBody, paths);
  if (idByPath.size === 0) {
    throw new Error('bluestyle: no landing page resolved to a thematic-holiday id');
  }
  const missing = paths.filter((p) => !idByPath.has(p));
  if (missing.length > 0) ctx.log(`bluestyle: ${missing.length} landing paths unresolved (${missing.join(', ')})`);

  // Step 2 — pull the listing pages, QUERIES_PER_REQUEST aliased page-queries per HTTP request.
  const jobs = buildJobs(idByPath);
  const hotels: RawHotel[] = [];
  let lastError: unknown;
  let batches = 0;
  let okBatches = 0;

  for (let i = 0; i < jobs.length; i += QUERIES_PER_REQUEST) {
    if (requests >= MAX_REQUESTS) {
      ctx.log(`bluestyle: request cap ${MAX_REQUESTS} reached, stopping after ${batches} batches`);
      break;
    }
    const batch = jobs.slice(i, i + QUERIES_PER_REQUEST);
    batches += 1;
    requests += 1;
    try {
      const body = await postGraphql(ctx, buildListingRequest(batch));
      hotels.push(...parseHotelsResponse(body));
      okBatches += 1;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof SourceBlockedError) {
        // Actively blocked: stop hitting the host but keep whatever earlier batches returned.
        ctx.log(`bluestyle: batch ${batches} blocked (${message}), stopping`);
        break;
      }
      ctx.log(`bluestyle: batch ${batches} failed (${message}), skipping`);
    }
  }

  if (okBatches === 0 && lastError !== undefined) {
    // Every listing batch failed: not "market empty". Rethrow so runScan records 'failed' rather
    // than degrading to [] (which would deactivate known offers and mute the health alert).
    ctx.log(`bluestyle: all ${batches} listing batches failed, aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const offers = mapBluestyleOffers(hotels, ctx.adults);
  ctx.log(
    `bluestyle: fetched ${offers.length} offers from ${hotels.length} hotel rows ` +
      `(${idByPath.size} landing pages, ${okBatches}/${batches} batches, ${requests} requests)`,
  );
  return offers;
}

export const bluestyle: SourceAdapter = {
  name: 'bluestyle',
  fetchOffers,
};
