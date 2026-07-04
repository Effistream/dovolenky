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
  };
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
  // `tour.transportType` is a numeric enum from the DER platform; `1` = flight has been the
  // only value observed so far (fly-to destinations Řecko/Turecko/Egypt). No own-transport/bus
  // example has been seen yet, so anything else falls back to 'unknown' rather than guessing.
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
    departureAirport: null,
    departureDate,
    nights,
    pricePerPerson,
    priceTotal,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice,
    tourOperator: null,
    url,
  };
}
