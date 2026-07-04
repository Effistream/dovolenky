import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, parseCzDate, offerKeyHash } from '../core/normalize.js';

const BASE_URL = 'https://www.blue-style.cz';
const LISTING_PATHS = ['/last-minute/', '/recko/', '/turecko/', '/egypt/'];

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s;

const STAR_MAP: Record<string, number> = {
  STAR_1: 1,
  STAR_2: 2,
  STAR_3: 3,
  STAR_3_PLUS: 3,
  STAR_4: 4,
  STAR_4_PLUS: 4,
  STAR_5: 5,
};

function starsFromEnum(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  return STAR_MAP[raw] ?? null;
}

/**
 * Raw shape of a fully-populated `CheapestTerm` Apollo cache entry, as seen on the
 * /last-minute/ listing page. Country/region/destination pages (e.g. /recko/) also contain
 * objects with `__typename: 'CheapestTerm'`, but those are partial "cheapest offer" teasers
 * referenced from `LocationCountry.cheapestTerm` — they carry only a subset of these fields
 * (no hotelName/boardingType/hotelStars/percentageDiscount) and are skipped by the parser
 * below since they lack the fields required to build a NormalizedOffer.
 */
interface RawCheapestTerm {
  __typename: 'CheapestTerm';
  hotelName?: string;
  hotelStars?: string;
  destinationName?: string;
  boardingType?: string;
  roomType?: string;
  departureDate?: string;
  dayCount?: number;
  nightCount?: number;
  priceFrom?: number;
  percentageDiscount?: number;
  url?: string;
}

/**
 * The apolloState cache is a normalized graph: the same `CheapestTerm-<id>` object is often
 * referenced from multiple places (e.g. both a listing array and a location's "cheapest"
 * pointer), so a naive recursive walk visits it more than once. We collect every match
 * recursively (per the task brief — the exact JSON shape may shift) and rely on
 * `seen`/`sourceOfferKey` dedup, plus a WeakSet guard against revisiting the same node twice
 * during the walk itself, to avoid duplicate work on cyclic/shared structures.
 */
function collectCheapestTerms(node: unknown, out: RawCheapestTerm[], visited: WeakSet<object>): void {
  if (node === null || typeof node !== 'object') return;
  if (visited.has(node)) return;
  visited.add(node);

  if (!Array.isArray(node) && (node as { __typename?: unknown }).__typename === 'CheapestTerm') {
    out.push(node as RawCheapestTerm);
  }

  const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
  for (const value of values) {
    collectCheapestTerms(value, out, visited);
  }
}

export function parseBluestyle(html: string): NormalizedOffer[] {
  const match = html.match(NEXT_DATA_RE);
  if (!match?.[1]) return [];

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const apolloState = (data as { apolloState?: Record<string, unknown> })?.apolloState;
  if (!apolloState || typeof apolloState !== 'object') return [];

  const raw: RawCheapestTerm[] = [];
  collectCheapestTerms(apolloState, raw, new WeakSet());

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const term of raw) {
    const offer = mapOffer(term);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }

  return offers;
}

function mapOffer(term: RawCheapestTerm): NormalizedOffer | null {
  const title = term.hotelName?.trim();
  if (!title) return null;
  if (typeof term.priceFrom !== 'number' || !Number.isFinite(term.priceFrom) || term.priceFrom <= 0) return null;
  if (!term.url) return null;

  const url = new URL(term.url, BASE_URL).toString();
  const pricePerPerson = Math.round(term.priceFrom);

  const pct = term.percentageDiscount;
  const claimedDiscountPct = typeof pct === 'number' && pct > 0 ? pct : null;
  const claimedOriginalPrice =
    claimedDiscountPct !== null ? Math.round(pricePerPerson / (1 - claimedDiscountPct / 100)) : null;

  const country = normalizeCountry(term.destinationName ?? null);
  const board = normalizeBoard(term.boardingType ?? null);
  const departureDate = parseCzDate(term.departureDate ?? null);
  const nights = typeof term.nightCount === 'number' ? term.nightCount : null;
  const stars = starsFromEnum(term.hotelStars);

  const sourceOfferKey = offerKeyHash([title, departureDate, nights, board]);

  return {
    source: 'bluestyle',
    sourceOfferKey,
    title,
    country,
    locality: null,
    stars,
    board,
    transport: 'unknown',
    departureAirport: null,
    departureDate,
    nights,
    pricePerPerson,
    priceTotal: null,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator: null,
    url,
  };
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();

  for (const path of LISTING_PATHS) {
    const html = await ctx.http.text(`${BASE_URL}${path}`);
    const offers = parseBluestyle(html);
    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  ctx.log(`bluestyle: fetched ${all.length} offers across ${LISTING_PATHS.length} pages`);
  return all;
}

export const bluestyle: SourceAdapter = {
  name: 'bluestyle',
  fetchOffers,
};
