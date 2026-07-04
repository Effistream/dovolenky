import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.fischer.cz';
const MAX_TOURS = 10;
const HOTELS_PER_TOUR = 5;

/**
 * Fischer (CK Fischer) runs on the DER Touristik platform, like eTravel (see der.ts), but its
 * `/last-minute` flow is fundamentally different: the page embeds a server-rendered hydration
 * JSON blob (`div[data-component-name="appTourList"] > script[type="application/json"]`) that
 * lists tours (destination+term summaries with a `searchFilter` querystring), and hotel-level
 * detail for each tour requires a separate POST to `/api/TourList/getTourHotelList`. This is a
 * genuinely different two-step flow from eTravel/der.ts's single search-result JSON endpoint
 * (which already carries hotel+tour combined), so nothing from der.ts's `DerTour`/`mapDerTours`
 * fits here — those assume hotel and tour data arrive together in one response.
 *
 * Empirical hydration shape (from tests/fixtures/fischer/last-minute.html), confirmed live:
 * - `documentGuid` lives at `toursSearchSettings.documentGuid`, NOT at the top level.
 * - `tours` lives at `tourListResult.tours`, NOT at the top level.
 * - Each tour: `id`, `searchFilter` (full querystring incl. TT/D/DD/RD/NN/AC1/...), `departureDate`
 *   (ISO datetime, e.g. "2026-07-06T00:00:00"), `location.country`/`location.destination`,
 *   `departureLocation` (Czech departure city, e.g. "Praha"/"Brno"/"Pardubice"/"Ostrava"),
 *   `nightsCount: { from, to }` (an object, not a plain number — every sampled tour had
 *   `{from:7,to:7}` since /last-minute is fixed at a 7-night stay), `adultPriceFrom.amount`.
 * - No explicit transport field on the tour or hotel. /last-minute is a fly-package section by
 *   construction (searchFilter carries `TT=1`, matching der.ts's flight-tour-type convention),
 *   so transport is hardcoded to 'flight' per the task brief — no counterexample observed.
 *
 * Empirical getTourHotelList shape (from tests/fixtures/fischer/getTourHotelList.json):
 * - `hotels[]`: `detailUrl` (root-relative, incl. its own querystring), `hotelId`, `name`,
 *   `rating: { count, style: "stars" }` (count is the star rating, including 0 for unrated
 *   villas), `meal` (Czech free text, e.g. "Polopenze"/"Bez stravování"/"All Inclusive Ultra"),
 *   `adultPrice.amount`. Requesting `hotelsCountToGet: 20` on one tour returned only 1 hotel
 *   (hotelsTotalCount: 1) while another tour returned 5 of 8 available — hotel counts per tour
 *   vary a lot, so no fixed count can be assumed; we just take whatever comes back (up to
 *   HOTELS_PER_TOUR requested).
 *
 * claimedOriginalPrice/claimedDiscountPct are left null in v1: computing them needs a further
 * per-hotel GET to /searchresult/getsearch (embedded dataLayer JSON) which is deferred to the
 * backlog per the design doc (spec §3 row 2) — real discount tracking comes from this project's
 * own price-history/market comparison, not the source's claimed discount.
 */
interface FischerHydration {
  documentGuid: string;
  tours: unknown[];
}

interface FischerTour {
  id: number;
  searchFilter: string;
  departureDate: string | null;
  location: {
    country?: string | null;
    destination?: string | null;
  };
  departureLocation?: string | null;
  nightsCount?: { from?: number | null; to?: number | null } | null;
  adultPriceFrom?: { amount?: number | null } | null;
}

interface FischerHotel {
  detailUrl: string;
  hotelId: number | string;
  name: string;
  rating?: { count?: number | null } | null;
  meal?: string | null;
  roomType?: string | null;
  adultPrice?: { amount?: number | null } | null;
}

interface TourMeta {
  departureDate: string | null;
  nights: number | null;
  /** Raw country string from tour.location.country, NOT yet canonicalized — mapOneHotel
   *  applies isKnownCountry/normalizeCountry itself so the country-or-null invariant holds
   *  regardless of what the caller passes in. */
  country: string | null;
  locality: string | null;
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Parses the `/last-minute` hydration JSON out of the page HTML. Pure function: no I/O.
 * Returns an empty tours array (not a throw) if the hydration script is missing/malformed,
 * so callers can decide how to react (fetchOffers logs and returns early).
 */
export function parseFischerHydration(html: string): FischerHydration {
  const $ = cheerio.load(html);
  const raw = $('div[data-component-name="appTourList"] > script[type="application/json"]').first().html();
  if (!raw) return { documentGuid: '', tours: [] };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { documentGuid: '', tours: [] };
  }

  const obj = data as {
    toursSearchSettings?: { documentGuid?: string };
    tourListResult?: { tours?: unknown[] };
  };

  return {
    documentGuid: obj?.toursSearchSettings?.documentGuid ?? '',
    tours: obj?.tourListResult?.tours ?? [],
  };
}

/**
 * Maps a `hotels[]` array from one tour's getTourHotelList response to NormalizedOffer[],
 * combining it with that tour's shared metadata (departure date/nights/country/locality —
 * identical for every hotel under the same tour). Pure function: no I/O. Dedupes by
 * `sourceOfferKey`, keeping the first occurrence.
 */
export function mapFischerHotels(hotels: unknown[], tourMeta: TourMeta): NormalizedOffer[] {
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const raw of hotels) {
    const offer = mapOneHotel(raw as FischerHotel, tourMeta);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }

  return offers;
}

function mapOneHotel(h: FischerHotel, tourMeta: TourMeta): NormalizedOffer | null {
  if (!h?.name || !h.detailUrl) return null;

  const priceRaw = h.adultPrice?.amount;
  if (priceRaw === null || priceRaw === undefined || !(priceRaw > 0)) return null;
  const pricePerPerson = round(priceRaw);

  const board = normalizeBoard(h.meal ?? null);
  const stars = h.rating?.count ?? null;
  const url = new URL(h.detailUrl, BASE_URL).toString();
  const sourceOfferKey = offerKeyHash([h.hotelId ?? h.name, tourMeta.departureDate, tourMeta.nights, board]);

  // LESSON (binding): country must be the real country from tour location data, canonical
  // via normalizeCountry, and null (never a raw/unknown string, never the locality/city) when
  // it doesn't resolve to a known country.
  const country = isKnownCountry(tourMeta.country) ? normalizeCountry(tourMeta.country) : null;

  return {
    source: 'fischer',
    sourceOfferKey,
    title: h.name,
    country,
    locality: tourMeta.locality,
    stars,
    board,
    transport: 'flight',
    departureAirport: null,
    departureDate: tourMeta.departureDate,
    nights: tourMeta.nights,
    pricePerPerson,
    priceTotal: null,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
    tourOperator: null,
    url,
  };
}

function toTourMeta(t: FischerTour): TourMeta {
  const departureDate = t.departureDate ? t.departureDate.slice(0, 10) : null;
  // Deliberate collapse: nightsCount is a {from,to} range but every sampled /last-minute tour
  // had {from:7,to:7} (see the file-header note), so we take the minimum stay (`from`) as the
  // single `nights` value. If Fischer ever serves a live from!=to range, this silently reports
  // the shortest stay rather than the full range — revisit if that's observed.
  const nights = t.nightsCount?.from ?? null;
  const country = t.location?.country ?? null;
  const locality = t.location?.destination ?? null;
  return { departureDate, nights, country, locality };
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  let hydration: FischerHydration;
  try {
    const html = await ctx.http.text(`${BASE_URL}/last-minute`);
    hydration = parseFischerHydration(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`fischer: last-minute page fetch failed (${message}), aborting`);
    return [];
  }

  const tours = (hydration.tours as FischerTour[]).filter((t) => t?.adultPriceFrom?.amount);
  if (tours.length === 0) {
    ctx.log('fischer: no tours with adultPriceFrom found on last-minute page, aborting');
    return [];
  }

  // Adapter-owned ordering: pick the MAX_TOURS earliest-departing tours ourselves rather than
  // trusting the server's response order. The server currently already returns tours in
  // departureDate-ascending order on /last-minute, so this sort is a no-op in practice today —
  // but making the semantics explicit here means the "top N" selection stays correct (and
  // testable) even if that server-side ordering ever changes. Stable sort; null departureDate
  // sorts last (unknown-date tours are least useful to prioritize).
  const sortedTours = [...tours].sort((a, b) => {
    if (a.departureDate === b.departureDate) return 0;
    if (a.departureDate === null) return 1;
    if (b.departureDate === null) return -1;
    return a.departureDate < b.departureDate ? -1 : 1;
  });

  const targetTours = sortedTours.slice(0, MAX_TOURS);
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();

  for (const tour of targetTours) {
    const tourMeta = toTourMeta(tour);
    let offers: NormalizedOffer[];
    try {
      const url = `${BASE_URL}/api/TourList/getTourHotelList`;
      const body = JSON.stringify({
        searchFilter: tour.searchFilter,
        searchSettings: {
          sortBy: 'ByDefault',
          sortOrder: 'asc',
          searchFromIndex: 0,
          hotelsCountToGet: HOTELS_PER_TOUR,
        },
      });
      const res = await ctx.http.json<{ hotels: unknown[] }>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      offers = mapFischerHotels(res.hotels ?? [], tourMeta);
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further tour requests (politeness) but
        // keep whatever offers earlier tours already yielded.
        ctx.log(`fischer: tour ${tour.id} blocked (${err.message}), stopping`);
        break;
      }
      // Any other per-tour failure (network error, parse error, transient 5xx exhausted)
      // must not sink the whole fetch — log and move on to the next tour.
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`fischer: tour ${tour.id} getTourHotelList failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  ctx.log(`fischer: fetched ${all.length} offers across ${targetTours.length} tours`);
  return all;
}

export const fischer: SourceAdapter = {
  name: 'fischer',
  fetchOffers,
};
