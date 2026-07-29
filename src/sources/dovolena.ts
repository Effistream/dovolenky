import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://dovolena.cz';
const API_PATH = '/api/trip-listing/tripListing';
// Human-facing counterpart of the API: the site's own hotel page takes the SAME query params
// (hotelId + the search context), so every offer can carry a clickable URL — see the `url` note
// in the field map below.
const HUMAN_DETAIL_PATH = '/trip-detail';

/**
 * Dovolena.cz (run by Student Agency) exposes its listing data through a JSON API,
 * `/api/trip-listing/tripListing`, that its own Next.js frontend calls client-side.
 *
 * Query actually issued (re-verified live 2026-07-29, Chrome UA):
 *   GET /api/trip-listing/tripListing?destination=<id>&adult=<n>&page=1&perPage=20&length=<d>-<d>
 *   plus, for the two deepest destinations, the same URL with `&sortBy=favorite`.
 *   21 requests, timed at 117 s live; 420 offers across 19 countries (before: 4 requests, 40
 *   offers, 4 countries, every one of them nights=null).
 *
 * WHY each parameter (all four were measured, none is cargo cult):
 *  - `perPage` is a first-class supported param and the previous default of 10 rows per
 *    destination was self-inflicted: perPage=48 → 48 rows, perPage=100 → 100 rows, perPage=200 →
 *    200 rows, with totalPages recomputed each time (2779 Greek hotels: 278 pages at 10, 28 at
 *    100). It costs no extra request, so it is the cheapest coverage lever this source has — and
 *    the only one left once the request budget is spent (see MAX_REQUESTS). 20 is a deliberate
 *    ceiling, not the API's: with 21 requests per run that is ~420 offers, in line with the other
 *    adapters, instead of thousands of rows of DB churn.
 *  - `length=<d>-<d>` pins the trip length, and that is what makes `nights` knowable at all.
 *    `length` is expressed in DAYS — the site's own search form labels the field "7–10 dní", and
 *    the human detail page for a length=8-8 term renders "Termín 5. 10.–12. 10. 2026 / 8 dní /
 *    7 nocí" — so nights = days - 1. Verified end to end on hotelId 924498 (Dilino Hotel,
 *    Santorini): listing at length=8-8 → 6 879 CZK/os; https://dovolena.cz/trip-detail?hotelId=
 *    924498&adult=2&destination=4826&length=8-8 → "8 dní / 7 nocí", 6 889 Kč/os, 13 778 Kč celkem.
 *    WITHOUT the filter the API returns each hotel's cheapest term of ANY length, which is how the
 *    old 4 713 CZK "Club Sidar" row (a ONE-night stay, 12.–13. 10. 2026) got published next to
 *    week-long packages with nights=null: prices that cannot be compared and a per-night discount
 *    ladder that can never fire (computeRealDiscount needs nights for the hotel/locality/market
 *    rungs). A per-hotel `/api/trip-detail/tripDetail` call would also yield nights — at 1 request
 *    per hotel, i.e. hundreds per run, which the adapter budget does not have.
 *    Honest limit of the days-1 rule: it is the trip's calendar length (departure → return), and a
 *    term flying out late can spend one or two fewer nights IN the hotel. Sampled 2026-07-29 across
 *    Řecko/Turecko/Egypt/Maledivy, 9 of 9 resolvable cheapest rows came back tripStayNights=7 at
 *    length=8-8 (tripLength 8, from→to exactly 7 days); one 5* Turkish hotel's default detail term
 *    (Seher Resort, 20:05 departure) is displayed as "8 dní / 5 nocí". The listing row carries
 *    nothing that would let us detect that per row, so nights=7 is the best honest value — off by
 *    at most a night or two on a minority of night-flight terms, versus null, which disables
 *    per-night comparison for the entire source.
 *  - `sortBy` accepts recommended|cheapest|favorite (enum lifted from the site's own JS bundle).
 *    The default "recommended" is in fact strictly price-ascending (48-row Greek page verified
 *    monotone 3 769 → 7 157), so a single request per destination only ever samples the absolute
 *    cheapest tail. Measured on Řecko at 8 days: default → 5 339–7 739 CZK/os, 2–3*, ZERO
 *    all-inclusive; `sortBy=favorite` → 12 718–20 990 CZK/os with 4* and all-inclusive rows, and
 *    on Turecko up to 55 357 CZK/os (5* AI). The favourite slice is therefore the mid/high band
 *    the board never saw, at one extra request for the destinations where it pays.
 *  - `adult` comes from ctx.adults (config scan.adults) rather than a hardcoded 2, and also feeds
 *    the priceTotal fallback and the human URL. See the priceInfo note below for how closely the
 *    API's own group price tracks adult × regular (close, but NOT exactly).
 *
 * Destination ids: `GET /api/search/destinationTree` (ONE request, no auth) returns all 144
 * top-level destinations with `{id, name, url, children}` — that is where the ids below come from
 * and how they were cross-checked, replacing the old one-SSR-page-per-country discovery. The list
 * below is driven by config/watch.yaml, not by what happened to be verified first: 15 of exotika's
 * 24 countries (the previous version of this adapter covered exactly ONE of them) plus leto-more's
 * four deepest. See the DESTINATIONS comment for why the split leans exotic.
 *
 * Fields per hotel row (confirmed live 2026-07-29; the row object's keys are exactly
 * additionalInfo, address, destinations, fullGalleryFetched, gallery, gps, hotelId, labels,
 * noStars, numberRating, priceInfo, title):
 *   - title -> title
 *   - noStars -> stars
 *   - destinations: `{id, name}` broadest-to-narrowest (e.g. Řecko / Ostrovy / Santorini / Kamari).
 *     [0] is the country. The LAST entry is the locality: index 1 used to be taken, but for Greece
 *     (the biggest destination here) index 1 is only "Pevnina"/"Ostrovy" — two values across 2 778
 *     hotels, which collapses the locality discount rung into a second country rung. The last entry
 *     is the resort ("Kamari", "Kryopigi", "Nungwi"), matches the row's own `address` tail, and is
 *     the same granularity the other adapters emit (alexandria/datour destination_name, čedok's
 *     post-comma segment).
 *   - country: destinations[0] via normalizeCountry+isKnownCountry, else the queried destination's
 *     own canonical country (never a locality — the binding country-or-null rule). The fallback is
 *     needed because three of the site's country labels are not canonical: "Zanzibar a Tanzanie",
 *     "Kapverdské ostrovy", "Jižní Afrika". It is honest: every hotel in the response is inside the
 *     destination we asked for.
 *   - additionalInfo.boarding (free Czech text) -> normalizeBoard; can be "" (→ 'unknown'),
 *     typical for Maledivy rows.
 *   - additionalInfo.transport.label ("fields.transport.type.flight") -> normalizeTransport.
 *   - priceInfo.regular.amount -> pricePerPerson; priceInfo.group.amount -> priceTotal, and where
 *     the row omits `group` priceTotal is derived as pricePerPerson × adults. `group` is the
 *     MINORITY case, not the exception: measured 2026-07-29 at perPage=20 it is present on 2/20
 *     Turecko, 6/20 Egypt, 11/20 Španělsko rows (10/10 in the Greek fixture), so most published
 *     priceTotals are the derived ones. Prefer the API's figure when it is there, because the two
 *     are near-identical but NOT equal: the API rounds its per-person figure DOWN from the true
 *     group price, so group is 1 CZK above 2 × regular on a minority of rows (Španělsko 4/11,
 *     Egypt 1/6, Turecko 1/2; 92 of 420 rows in a full live run). Do not "simplify" this to always
 *     computing pricePerPerson × adults — that would silently drift every such row by a koruna.
 *     This is the site's own card ("od") price: the
 *     cheapest room/term inside the pinned window. It matched the hotel page exactly on the cheap
 *     rows spot-checked (5 339 / 10 678 for hotelId 924338, 6 879 vs 6 889 for 924498), but on some
 *     rows the hotel page's default room is dearer (Sunny Days Mirette: card 10 723, default room
 *     15 786) — same "from price" semantics every other adapter in this repo publishes.
 *   - hotelId -> sourceOfferKey; the same hotel is reachable from several queries (cheapest and
 *     favourite slices overlap), so fetchOffers dedupes globally on it.
 *   - url -> https://dovolena.cz/trip-detail?hotelId=<id>&adult=<n>&destination=<id>&length=<d>-<d>
 *     — a real human page (title "Dilino Hotel 2, Řecko, Ostrovy, Santorini, Kamari | STUDENT
 *     AGENCY"), not the JSON endpoint the offers used to point at. This is the very shape the
 *     site's own listing links use; the listing rows carry no hotel slug, so /hotel/<country>/<slug>
 *     cannot be constructed.
 *   - claimedOriginalPrice / claimedDiscountPct: still always null. The payload only carries a
 *     "discounticon" badge id list with no original figure anywhere, so there is nothing honest to
 *     compute (spec row 7).
 *   - departureDate: still null, and deliberately so. `date` (dd.MM.yyyy-dd.MM.yyyy) IS honored by
 *     the API, but a window only bounds the departure — the row still never says which day inside
 *     it the price belongs to. Pinning one exact day would cost one request per destination × day,
 *     and writing the window's start into departureDate would be a fabrication that feeds
 *     computeMatchKey and the ±30-day hotel rung. Downstream filters tolerate null dates (spec §3).
 *   - departureAirport / tourOperator: null. Both exist only on /api/trip-detail/tripDetail
 *     (departureFrom "Vídeň", operator "Čedok"), i.e. one request per hotel — hundreds per run,
 *     far outside the budget. Worth knowing: the cheap tail of this source is largely
 *     Vienna-departure stock.
 */

interface DovolenaDestinationRef {
  id?: number;
  name?: string;
}

interface DovolenaHotel {
  hotelId?: number;
  title?: string;
  noStars?: number;
  destinations?: DovolenaDestinationRef[];
  additionalInfo?: {
    boarding?: string;
    transport?: { label?: string };
  };
  priceInfo?: {
    regular?: { amount?: number };
    group?: { amount?: number };
  };
}

interface DovolenaTripListingResponse {
  hotels?: DovolenaHotel[];
}

/** Rows requested per query. See the module doc comment: the API allows far more; this is our cap. */
const PER_PAGE = 20;

/**
 * Hard ceiling on HTTP requests per run, independent of how the destination table grows.
 * Budget, measured not assumed: this API answers in 4–7 s with outliers to 22–26 s, and HttpClient
 * adds a 3 s per-host gap, so a request costs ~7 s of wall clock here — a 34-request plan was timed
 * at 231 s, i.e. inside run.ts's ADAPTER_FETCH_TIMEOUT_MS = 240 s only by luck. The shipped plan is
 * 21 requests (19 destinations + 2 favourite slices), timed at 157 s for 22. The cap exists so that
 * adding destinations can never silently push the adapter past its timeout — an aborted adapter is
 * recorded 'failed' and the whole source drops off the board, strictly worse than partial coverage.
 * Extra coverage must come from PER_PAGE (free) or from replacing a destination, never from more
 * requests.
 */
const MAX_REQUESTS = 24;

/**
 * Second line of defence for the same budget. run.ts's abort is all-or-nothing: an adapter that
 * overruns loses every offer it had already collected. Once this much of the run is gone we stop
 * issuing NEW requests and return what we have, so a slow day for dovolena.cz degrades to partial
 * coverage instead of a failed source.
 *
 * The value must leave room for the request that is already in flight when the deadline passes,
 * and that worst case is NOT HttpClient's 25 s — 25 s is the per-ATTEMPT ceiling. One
 * `http.json()` can cost 3 s host gap + 3 × 25 s timeouts + 500 ms + 2000 ms retry backoff
 * ≈ 80.5 s (REQUEST_TIMEOUT_MS × MAX_ATTEMPTS + RETRY_BACKOFF_MS, src/core/http.ts). So the
 * ceiling is 240 s − 80.5 s ≈ 159 s; 155 s keeps a margin. Anything higher (175 s was the first
 * cut) lets a request issued just under the deadline settle at ~255 s and trip the very abort this
 * constant exists to prevent — precisely in the slow/tarpitting-host scenario it is meant for.
 * Healthy runs never reach it: 21 requests measure 102–117 s end to end.
 */
const SOFT_DEADLINE_MS = 155_000;

/** Trip length in DAYS (nights = days - 1) for the standard week product. */
const DEFAULT_TRIP_DAYS = 8;

interface DovolenaDestination {
  /** Canonical country (src/core/normalize.ts COUNTRIES) — the fallback when the site's own label isn't canonical. */
  country: string;
  id: number;
  /** Trip length in days; nights published = days - 1. Defaults to DEFAULT_TRIP_DAYS. */
  days?: number;
  /** Also fetch the `sortBy=favorite` slice (mid/high band). Only worth it where inventory is deep. */
  popular?: boolean;
}

/**
 * Destination ids from /api/search/destinationTree (see module doc), driven by config/watch.yaml.
 * `totalHotels` in the trailing comments was measured live 2026-07-29 at adult=2 and the
 * destination's own trip length.
 *
 * Why the exotic list is long and the European one short — the request budget only buys ~21 slots,
 * and this source publishes no departureDate, so filters.ts can only ever match it against the
 * `exotika` profile (leto-more/last-minute both need a departure date). Exotic countries are also
 * where this source is NOT redundant: Kypr/Bulharsko/Chorvatsko/Itálie are already carried by
 * several other adapters, while exotika's 24 countries had exactly ONE representative here before.
 * The four European ids kept are the deepest inventory (and the ones the favourite slice pays off
 * on); dropping the other four is the price of covering 15 exotic countries instead of 1.
 *
 * Deliberately NOT shipped, measured the same day and found empty or near-empty at 8 days, so the
 * slot is better spent elsewhere: Peru 8178 (0), Kambodža 8128 (0), Madagaskar 8146 (0),
 * Nepál 8164 (1 trek), Japonsko 8121 (1), Réunion 8181 (2), Filipíny 8097 (3). Namibie has no
 * destination page on this site at all. Kuba 4899 is the opposite case — 0 hotels at 8 days but
 * 158 at 12 days, so it ships with days: 12 (11 nights).
 */
const DESTINATIONS: DovolenaDestination[] = [
  // leto-more (config/watch.yaml): the deepest mass-market inventory, worth both slices.
  { country: 'Řecko', id: 4826, popular: true }, // 2778
  { country: 'Turecko', id: 4813, popular: true }, // 1645
  // Egypt gets no favourite slice: unlike Greece/Turkey its CHEAP tail is already all-inclusive
  // (that is how the market sells Hurghada/Sharm), so the second request would buy little.
  { country: 'Egypt', id: 4810 }, // 786
  { country: 'Španělsko', id: 4873 }, // 1969
  // exotika (config/watch.yaml) — the only profile this source's null-date offers can match.
  { country: 'Spojené arabské emiráty', id: 4995 }, // 638
  { country: 'Thajsko', id: 4833 }, // 627
  { country: 'Maledivy', id: 4830 }, // 341
  { country: 'Mexiko', id: 4876 }, // 326
  { country: 'Dominikánská republika', id: 4807 }, // 244
  { country: 'Mauricius', id: 4927 }, // 227
  { country: 'Indonésie', id: 4965 }, // 204 — site label "Indonésie - Bali, Lombok, Sulawesi"
  { country: 'Kuba', id: 4899, days: 12 }, // 158 at 12 days, 0 at 8
  { country: 'Srí Lanka', id: 5043 }, // 138
  { country: 'Seychely', id: 5078 }, // 95
  { country: 'Keňa', id: 4987 }, // 75
  { country: 'Vietnam', id: 5456 }, // 64
  // Sub-destination on purpose: the top-level id 5094 is "Zanzibar a Tanzanie" (both are separate
  // canonical countries here), so querying its Zanzibar child keeps the country honest.
  { country: 'Zanzibar', id: 8814 }, // 48
  { country: 'Jihoafrická republika', id: 5756 }, // 32 — site label "Jižní Afrika"
  { country: 'Kapverdy', id: 5298 }, // 25 — site label "Kapverdské ostrovy"
];

/** One planned HTTP request plus everything the parser needs to interpret its rows. */
export interface DovolenaQuery {
  url: string;
  /** Canonical country to fall back on when the payload's own label isn't recognized. */
  fallbackCountry: string;
  /** Nights implied by the pinned `length` (days - 1). */
  nights: number;
  /** Per-offer human URL prefix (hotelId is appended per row). */
  humanUrlBase: string;
  /** For logs only. */
  label: string;
}

function round(n: number): number {
  return Math.round(n);
}

function buildListingUrl(destination: DovolenaDestination, adults: number, sortBy?: string): string {
  const days = destination.days ?? DEFAULT_TRIP_DAYS;
  const sort = sortBy ? `&sortBy=${sortBy}` : '';
  return `${BASE_URL}${API_PATH}?destination=${destination.id}&adult=${adults}&page=1&perPage=${PER_PAGE}&length=${days}-${days}${sort}`;
}

function buildHumanUrlBase(destination: DovolenaDestination, adults: number): string {
  const days = destination.days ?? DEFAULT_TRIP_DAYS;
  return `${BASE_URL}${HUMAN_DETAIL_PATH}?adult=${adults}&destination=${destination.id}&length=${days}-${days}&hotelId=`;
}

/**
 * The full request plan for one run: the cheapest slice for every destination first, then the
 * favourite (mid/high band) slice for the deep ones. Ordering matters — if the site starts failing
 * or blocks us halfway through, the run still has one slice for as many countries as possible
 * rather than two slices for a few. Truncated at MAX_REQUESTS.
 */
export function buildQueries(adults: number): DovolenaQuery[] {
  const queries: DovolenaQuery[] = [];

  for (const [sortBy, only] of [
    [undefined, () => true],
    ['favorite', (d: DovolenaDestination) => d.popular === true],
  ] as const) {
    for (const destination of DESTINATIONS) {
      if (!only(destination)) continue;
      queries.push({
        url: buildListingUrl(destination, adults, sortBy),
        fallbackCountry: destination.country,
        nights: (destination.days ?? DEFAULT_TRIP_DAYS) - 1,
        humanUrlBase: buildHumanUrlBase(destination, adults),
        label: `${destination.country}${sortBy ? ` (${sortBy})` : ''}`,
      });
    }
  }

  return queries.slice(0, MAX_REQUESTS);
}

/**
 * Maps a single `tripListing` API response to NormalizedOffer[]. Pure function: no I/O.
 * `query` carries the request context the rows themselves don't have — the pinned nights, the
 * fallback country and the human URL prefix. Dedupes by `sourceOfferKey` within this single
 * response (cross-response dedup is fetchOffers's job), keeping the first occurrence.
 */
export function parseDovolena(json: unknown, query: DovolenaQuery, adults: number): NormalizedOffer[] {
  const hotels = (json as DovolenaTripListingResponse | undefined)?.hotels;
  if (!Array.isArray(hotels)) return [];

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const hotel of hotels) {
    const offer = mapHotel(hotel, query, adults);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }

  return offers;
}

function mapHotel(hotel: DovolenaHotel, query: DovolenaQuery, adults: number): NormalizedOffer | null {
  if (hotel.hotelId === undefined || hotel.hotelId === null) return null;
  const title = hotel.title?.trim();
  if (!title) return null;

  const pricePerPersonRaw = hotel.priceInfo?.regular?.amount;
  if (typeof pricePerPersonRaw !== 'number' || !(pricePerPersonRaw > 0)) return null;
  const pricePerPerson = round(pricePerPersonRaw);

  const priceTotalRaw = hotel.priceInfo?.group?.amount;
  const priceTotal =
    typeof priceTotalRaw === 'number' && priceTotalRaw > 0 ? round(priceTotalRaw) : pricePerPerson * adults;

  const destinations = hotel.destinations ?? [];
  const countryRaw = destinations[0]?.name ?? null;
  // Prefer what the payload says; fall back to the country we asked for when the site's own label
  // isn't canonical ("Zanzibar a Tanzanie", "Kapverdské ostrovy", "Jižní Afrika"). Never a locality.
  const country = isKnownCountry(countryRaw) ? normalizeCountry(countryRaw) : normalizeCountry(query.fallbackCountry);
  // Deepest entry = the resort (see module doc); index 1 is a useless "Pevnina"/"Ostrovy" split in
  // Greece. Null when the path has no level below the country, or when it merely repeats it.
  const deepest = destinations.length > 1 ? destinations[destinations.length - 1]?.name?.trim() || null : null;
  const locality = deepest !== null && deepest !== country ? deepest : null;

  const stars = typeof hotel.noStars === 'number' && hotel.noStars > 0 ? hotel.noStars : null;
  const board = normalizeBoard(hotel.additionalInfo?.boarding ?? null);
  const transport = normalizeTransport(hotel.additionalInfo?.transport?.label ?? null);

  return {
    source: 'dovolena',
    sourceOfferKey: String(hotel.hotelId),
    title,
    country,
    locality,
    stars,
    board,
    transport,
    departureAirport: null,
    // The listing carries no departure day (only the pinned length) — see module doc comment.
    departureDate: null,
    nights: query.nights,
    pricePerPerson,
    priceTotal,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
    tourOperator: null,
    url: `${query.humanUrlBase}${hotel.hotelId}`,
  };
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const adults = Number.isFinite(ctx.adults) && ctx.adults > 0 ? ctx.adults : 2;
  const queries = buildQueries(adults);
  const startedAt = Date.now();
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;
  let requestCount = 0;

  queryLoop: for (const query of queries) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      ctx.log(`dovolena: soft deadline hit after ${requestCount} requests, returning partial coverage`);
      break queryLoop;
    }
    let offers: NormalizedOffer[];
    try {
      requestCount += 1;
      const json = await ctx.http.json(query.url);
      offers = parseDovolena(json, query, adults);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further requests (politeness) but keep
        // whatever offers earlier queries already yielded. Record the block as lastError so a block
        // BEFORE the first success still trips the rethrow below.
        lastError = err;
        ctx.log(`dovolena: ${query.label} blocked (${err.message}), stopping`);
        break queryLoop;
      }
      // Any other per-query failure (network error, parse error, transient 5xx exhausted) must not
      // sink the whole fetch — log and move on to the next query.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`dovolena: ${query.label} fetch failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      // The same hotel shows up in more than one query (the cheapest and favourite slices of a
      // destination overlap), so dedupe globally by sourceOfferKey.
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every query failed: this is not "market empty" — rethrow (fischer pattern) so runScan
    // records this source 'failed' rather than degrading to [] (which would flip known offers
    // inactive and mute the health alert). A block on the first query lands here → BLOCKED
    // marker / 24h backoff engages.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    // requestCount, not queries.length: a block on query 1 stops the loop after ONE attempt, and
    // logging "all 21 queries failed" there would send whoever reads the alert hunting for 21
    // failures that never happened.
    ctx.log(`dovolena: all ${requestCount} attempted queries failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(
    `dovolena: fetched ${all.length} offers from ${successCount}/${requestCount} requests across ${DESTINATIONS.length} destinations`,
  );
  return all;
}

export const dovolena: SourceAdapter = {
  name: 'dovolena',
  fetchOffers,
};
