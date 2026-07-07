import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://dovolena.cz';
const API_PATH = '/api/trip-listing/tripListing';

/**
 * Dovolena.cz (run by Student Agency) exposes its listing data through a JSON API,
 * `/api/trip-listing/tripListing?destination=<id>&adult=2&page=N`, that its own Next.js
 * frontend calls client-side. `destination` is a numeric id specific to this source, discovered
 * by fetching the SSR destination pages (e.g. `/recko`) and reading the `__NEXT_DATA__` payload's
 * `destinationInfo.data.attributes.destination.data.attributes.destinationId` field. Verified live
 * (2026-07-04) against the three country-level destination pages this adapter targets:
 *   - Řecko (Greece):  4826  (https://dovolena.cz/recko)
 *   - Turecko (Turkey): 4813  (https://dovolena.cz/turecko)
 *   - Egypt:            4810  (https://dovolena.cz/egypt)
 * Each id was confirmed by cross-checking `destinationName` at the same JSON path equals the
 * expected country, and (for 4826) by confirming the tripListing response's `totalHotels` is a
 * large positive number (2749) rather than 0. Note other numeric ids seen on those pages (e.g.
 * 4827, 5074, ...) are SUB-region/island picker entries (Kos, Rhodos, ...), not the country id —
 * they are deliberately not used here.
 *
 * IMPORTANT (binding, spec §3 row 7): this is a hotel-level listing API, not a departure-date
 * search. Each `hotels[]` entry is a hotel with a single "from" price for *some* upcoming date,
 * not a specific booked term. There is no departure date or nights field anywhere in the payload,
 * so `departureDate`/`nights` are always null for this source — this is EXPECTED, not a parsing
 * gap (design spec explicitly says downstream filters must tolerate null dates).
 *
 * Per-hotel fields (confirmed against tests/fixtures/dovolena/tripListing.json, hotel 954985
 * "Hotel Theonia"):
 *   - title -> title
 *   - noStars -> stars
 *   - destinations: array of `{id, name}`, broader-to-narrower (e.g. Řecko / Ostrovy / Kos).
 *     destinations[0].name is the country; normalizeCountry+isKnownCountry guard (never pass a
 *     locality through as country, per the binding country-or-null lesson). The next entry (index
 *     1, e.g. "Ostrovy"/"region") is used as locality — NOT the last (most specific, e.g. "Kos"),
 *     because index 1 is present on every sampled hotel while deeper entries vary in count.
 *   - additionalInfo.boarding (free Czech text, e.g. "Snídaně", "Bez stravy") -> normalizeBoard
 *   - additionalInfo.transport.label (e.g. "fields.transport.type.flight") -> normalizeTransport
 *     (the label's tail token, "flight"/"own"/"bus", is exactly the vocabulary normalizeTransport
 *     already matches on, so no special-casing is needed)
 *   - priceInfo.regular.amount -> pricePerPerson (already an integer CZK amount, rounded anyway
 *     defensively)
 *   - priceInfo.group.amount -> priceTotal
 *   - hotelId -> sourceOfferKey (String(hotelId)); stable across pages/destinations because the
 *     same hotel can be reachable from more than one destination request (country + the sub-region
 *     it belongs to) — fetchOffers dedupes on this key.
 *   - claimedOriginalPrice / claimedDiscountPct: always null. The source only ever exposes a
 *     "discounticon" style badge with no underlying original-price figure (per spec row 7), so
 *     there is nothing honest to compute here.
 *   - url: no canonical hotel-detail URL or slug field exists anywhere on the hotel object (only
 *     numeric ids, gallery image paths, and gps coords) — confirmed by inspecting every key on
 *     multiple sampled hotels live. Falls back to the request URL (the destination listing page
 *     the hotel was found on), which at least lets a human open the right country/page.
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

// Destination ids verified live (see module doc comment for the discovery method: SSR page
// __NEXT_DATA__ → destinationId, then a tripListing call to confirm the id actually returns
// offers). Řecko/Turecko/Egypt verified 2026-07-04. Exotic addition (spec §16.2), verified
// 2026-07-07 (Chrome UA): Maledivy id 4830 — `GET /maledivy` __NEXT_DATA__ resolved
// destinationId=4830 (destinationName "Maledivy"), and `GET /api/trip-listing/tripListing?
// destination=4830&adult=2&page=1` returned totalHotels=382 (10 hotels on page 1, e.g. "Nest By
// Hawks", destinations[0]="Maledivy", 25 860 CZK). Only ONE exotic id was added because the
// ≤3-request discovery budget (spec §16.2) covers exactly one full verify per destination (1 SSR
// request for the id + 1 tripListing request to confirm offers); per the invia precedent, no
// further exotic id is shipped without that live offers-returned confirmation.
const DESTINATIONS: { name: string; id: number }[] = [
  { name: 'Řecko', id: 4826 },
  { name: 'Turecko', id: 4813 },
  { name: 'Egypt', id: 4810 },
  { name: 'Maledivy', id: 4830 },
];

function round(n: number): number {
  return Math.round(n);
}

function buildListingUrl(destinationId: number, page: number): string {
  return `${BASE_URL}${API_PATH}?destination=${destinationId}&adult=2&page=${page}`;
}

/**
 * Maps a single `tripListing` API response to NormalizedOffer[]. Pure function: no I/O.
 * `requestUrl` is threaded through as the per-offer `url` fallback (see module doc comment —
 * this source has no canonical per-hotel detail URL in the listing payload). Dedupes by
 * `sourceOfferKey` within this single response (cross-response/destination dedup is
 * fetchOffers's job), keeping the first occurrence.
 */
export function parseDovolena(json: unknown, requestUrl: string): NormalizedOffer[] {
  const hotels = (json as DovolenaTripListingResponse | undefined)?.hotels;
  if (!Array.isArray(hotels)) return [];

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const hotel of hotels) {
    const offer = mapHotel(hotel, requestUrl);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }

  return offers;
}

function mapHotel(hotel: DovolenaHotel, requestUrl: string): NormalizedOffer | null {
  if (hotel.hotelId === undefined || hotel.hotelId === null) return null;
  const title = hotel.title?.trim();
  if (!title) return null;

  const pricePerPersonRaw = hotel.priceInfo?.regular?.amount;
  if (typeof pricePerPersonRaw !== 'number' || !(pricePerPersonRaw > 0)) return null;
  const pricePerPerson = round(pricePerPersonRaw);

  const priceTotalRaw = hotel.priceInfo?.group?.amount;
  const priceTotal = typeof priceTotalRaw === 'number' && priceTotalRaw > 0 ? round(priceTotalRaw) : null;

  const destinations = hotel.destinations ?? [];
  const countryRaw = destinations[0]?.name ?? null;
  const country = isKnownCountry(countryRaw) ? normalizeCountry(countryRaw) : null;
  const locality = destinations[1]?.name?.trim() || null;

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
    // This source lists hotels, not specific departure terms — no date/nights field exists.
    departureDate: null,
    nights: null,
    pricePerPerson,
    priceTotal,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
    tourOperator: null,
    url: requestUrl,
  };
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  destinationLoop: for (const destination of DESTINATIONS) {
    const url = buildListingUrl(destination.id, 1);
    let offers: NormalizedOffer[];
    try {
      const json = await ctx.http.json(url);
      offers = parseDovolena(json, url);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further destination requests
        // (politeness) but keep whatever offers earlier destinations already yielded. Record the
        // block as lastError so a block BEFORE the first success still trips the rethrow below.
        lastError = err;
        ctx.log(`dovolena: ${destination.name} blocked (${err.message}), stopping`);
        break destinationLoop;
      }
      // Any other per-destination failure (network error, parse error, transient 5xx
      // exhausted) must not sink the whole fetch — log and move on to the next destination.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`dovolena: ${destination.name} fetch failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      // Same hotel can appear under more than one destination request (e.g. the country id
      // and a sub-region it belongs to), so dedupe globally by sourceOfferKey.
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every destination failed: this is not "market empty" — rethrow (fischer pattern) so runScan
    // records this source 'failed' rather than degrading to [] (which would flip known offers
    // inactive and mute the health alert). A block on the first destination lands here → BLOCKED
    // marker / 24h backoff engages.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`dovolena: all ${DESTINATIONS.length} destinations failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`dovolena: fetched ${all.length} offers across ${DESTINATIONS.length} destinations`);
  return all;
}

export const dovolena: SourceAdapter = {
  name: 'dovolena',
  fetchOffers,
};
