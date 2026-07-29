import type { NormalizedOffer } from '../core/types.js';
import { normalizeBoard, normalizeCountry, offerKeyHash } from '../core/normalize.js';

/**
 * Shared shapes/mapping for DER Touristik-platform sources (eTravel confirmed; Fischer/Exim
 * reuse this IF their `tours[]` fixtures turn out to have the same shape — verify against
 * their own fixtures in Tasks 15/16 before assuming so, and fall back to source-specific
 * mapping there if the shapes diverge).
 *
 * Confirmed (from tests/fixtures/etravel/getsearchresult.json) shape of one `tours[]` element:
 * - detailUrl: string, site-root-relative (e.g. "/hotely/recko/kreta/…")
 * - hotel.id: number; hotel.name: string; hotel.breadcrumbs.country/.destination: string
 * - tour.nightsCount: number
 * - tour.date.from: ISO datetime string, e.g. "2026-08-26T00:00"
 * - tour.price.adultPrice / .total / .discount: number (CZK); .lowestPrice: number | null
 *   (Omnibus 30-day legal minimum — see spec §3 row 8). Empirically, on the search-listing
 *   endpoint `lowestPrice` was consistently null across hundreds of sampled tours (several
 *   destinations, with and without active discounts) — the field is real but this adapter
 *   null-guards it rather than assuming when it populates.
 * - tour.tourOperator: string, e.g. "FISCHER" / "TUI-CZ" / "EXIM Tours" / "ETI" / "BLUE SKY".
 *   eTravel is a reseller carrying several operators, so this is what lets the board tell an
 *   eTravel-listed Fischer package apart from the same package pulled by the fischer adapter.
 * - tour.flight.departure.segments[0].airport.{from,fromIATA,fromId} — the ORIGIN of the
 *   outbound leg, e.g. {"from":"Praha","fromIATA":"PRG","fromId":4312}. Added 2026-07-29:
 *   both fields were dropped as hardcoded nulls until then, which mattered because the API
 *   sorts price-ascending and cheap non-Czech departures crowd the top of every exotic
 *   destination (live: 17/40 cheapest Chorvatsko tours leave from Vienna, 10 from Katowice,
 *   9 from Budapest — shown on the board with no airport signal at all).
 */
export interface DerTour {
  detailUrl: string;
  hotel: {
    id: number | string;
    name: string;
    starsCount?: number | null;
    breadcrumbs: {
      country?: string | null;
      destination?: string | null;
    };
  };
  tour: {
    nightsCount: number | null;
    transportType?: number | null;
    date: {
      from: string | null;
    };
    price: {
      adultPrice: number | null;
      total: number | null;
      discount: number | null;
      lowestPrice: number | null;
    };
    rooms?: Array<{ meal?: string | null }>;
    tourOperator?: string | null;
    flight?: {
      departure?: {
        segments?: Array<{
          airport?: {
            from?: string | null;
            fromIATA?: string | null;
          } | null;
        }> | null;
      } | null;
    } | null;
  };
}

/**
 * Origin airport of the outbound leg. Prefers `fromIATA` because core/normalize.ts's
 * `normalizeAirport` passes 3-letter codes straight through (so the offer stays comparable
 * cross-source in `computeMatchKey`) and the web board matches uppercased codes. Falls back
 * to the Czech city name only when the IATA code is missing/malformed: `normalizeAirport`
 * knows the domestic + neighbouring-capital names (Praha/Brno/Ostrava/Vídeň/…), and even
 * where it doesn't, a rendered "MNICHOV" in the Odlet column beats today's "—".
 */
function pickDepartureAirport(t: DerTour): string | null {
  const airport = t.tour?.flight?.departure?.segments?.[0]?.airport;
  const iata = airport?.fromIATA?.trim();
  if (iata && /^[a-zA-Z]{3}$/.test(iata)) return iata.toUpperCase();
  return airport?.from?.trim() || null;
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * `tour.price.discount` is an absolute CZK amount on the TOTAL price (all travellers
 * combined), NOT per person. Verified empirically against tests/fixtures/etravel/
 * getsearchresult.json ("Piatsa Michalis": adultPrice=9990, total=19980 (=2×adultPrice),
 * discount=28280 — total+discount=48260 is a sane "original total", giving a 59% discount;
 * per-person discount amounts of that same magnitude would imply the current price is a
 * small fraction of a per-person discount alone, which doesn't reconcile with total/adultPrice).
 *
 * Adults-per-room count is derived from `total / adultPrice` (rounded) rather than a
 * hardcoded `2`, so the pure mapper doesn't need the caller's `ctx.adults` threaded through.
 * Guards: adultPrice must be positive, and the resulting pct must fall strictly between 0
 * and 100 — otherwise both claimed fields are set to null rather than guessing.
 */
function computeClaimedPrice(
  adultPrice: number,
  total: number,
  discount: number,
): { claimedOriginalPrice: number | null; claimedDiscountPct: number | null } {
  if (!(discount > 0) || !(adultPrice > 0) || !(total > 0)) {
    return { claimedOriginalPrice: null, claimedDiscountPct: null };
  }
  const adults = Math.max(1, round(total / adultPrice));
  const discountPerPerson = discount / adults;
  const claimedOriginalPrice = round(adultPrice + discountPerPerson);
  const pct = round((discountPerPerson / claimedOriginalPrice) * 100);
  if (!(pct > 0) || !(pct < 100)) {
    return { claimedOriginalPrice: null, claimedDiscountPct: null };
  }
  return { claimedOriginalPrice, claimedDiscountPct: pct };
}

/**
 * Maps a `tours[]` array from the DER Touristik search-result API shape to NormalizedOffer[].
 * Pure function: no I/O, no per-source config beyond `source` name and `baseUrl` for resolving
 * relative detailUrls. Dedupes by `sourceOfferKey` (hotel id/title + departure date + nights),
 * keeping the first occurrence.
 */
export function mapDerTours(tours: unknown[], source: string, baseUrl: string): NormalizedOffer[] {
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const raw of tours) {
    const offer = mapOneTour(raw as DerTour, source, baseUrl);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }

  return offers;
}

function mapOneTour(t: DerTour, source: string, baseUrl: string): NormalizedOffer | null {
  if (!t?.hotel?.name || !t.detailUrl) return null;

  const adultPriceRaw = t.tour?.price?.adultPrice;
  if (adultPriceRaw === null || adultPriceRaw === undefined || !(adultPriceRaw > 0)) return null;
  const pricePerPerson = round(adultPriceRaw);

  const totalRaw = t.tour?.price?.total;
  const priceTotal = totalRaw !== null && totalRaw !== undefined ? round(totalRaw) : null;

  const discountRaw = t.tour?.price?.discount;
  const { claimedOriginalPrice, claimedDiscountPct } =
    discountRaw && totalRaw
      ? computeClaimedPrice(adultPriceRaw, totalRaw, discountRaw)
      : { claimedOriginalPrice: null, claimedDiscountPct: null };

  const lowestPriceRaw = t.tour?.price?.lowestPrice;
  const omnibusLowestPrice =
    lowestPriceRaw !== null && lowestPriceRaw !== undefined ? round(lowestPriceRaw) : null;

  const country = normalizeCountry(t.hotel.breadcrumbs?.country ?? null);
  const locality = t.hotel.breadcrumbs?.destination ?? null;

  const departureDate = t.tour?.date?.from ? t.tour.date.from.slice(0, 10) : null;
  const nights = t.tour?.nightsCount ?? null;

  const url = new URL(t.detailUrl, baseUrl).toString();
  const sourceOfferKey = offerKeyHash([t.hotel.id ?? t.hotel.name, departureDate, nights]);

  const stars = t.hotel.starsCount ?? null;
  const board = normalizeBoard(t.tour?.rooms?.[0]?.meal ?? null);
  // `tour.transportType` is a numeric enum from the DER platform; `1` = flight is still the only
  // value ever observed — 902 offers across all 24 queried countries on 2026-07-29, drive-to
  // Chorvatsko and Itálie included. That is expected: the adapter pins `tt=1` (tour type = flight
  // package) in the query. No own-transport/bus example has been seen, so anything else falls back
  // to 'unknown' rather than guessing.
  const transport = t.tour?.transportType === 1 ? 'flight' : 'unknown';

  return {
    source,
    sourceOfferKey,
    title: t.hotel.name,
    country,
    locality,
    stars,
    board,
    transport,
    departureAirport: pickDepartureAirport(t),
    departureDate,
    nights,
    pricePerPerson,
    priceTotal,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice,
    tourOperator: t.tour?.tourOperator?.trim() || null,
    url,
  };
}
