import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.fischer.cz';

/* ── request budget ───────────────────────────────────────────────────────────────────────────
 * HttpClient serializes per host with a 3 s gap and run.ts aborts an adapter after
 * ADAPTER_FETCH_TIMEOUT_MS (240 s), so the whole run must fit in ~40 requests. Worst case here is
 * 1 + MAX_TOUR_LIST_PAGES + MAX_TOUR_DETAILS = 35 requests ≈ 35 × (3 s gap + ~1 s fetch) ≈ 140 s,
 * leaving ~100 s of headroom. MAX_REQUESTS is the hard stop: if fischer ever grows its catalogue,
 * the loops run out of budget instead of silently blowing the adapter timeout (which would record
 * the source 'failed' and drop it off the board entirely — strictly worse than partial coverage).
 */
const MAX_REQUESTS = 35;
const TOURS_PER_PAGE = 20; // server-side cap: asking for 100 still returns 20 (verified 2026-07-29)
const MAX_TOUR_LIST_PAGES = 9; // 9 × 20 on top of the 20 embedded in the page = all 200 tours today
const MAX_TOUR_DETAILS = 25; // one /searchresult/getsearch per selected tour, ≤20 hotels each

/**
 * Fischer (CK Fischer) runs on the DER Touristik platform, like eTravel (see der.ts), but its
 * `/last-minute` flow is fundamentally different: the page embeds a server-rendered hydration
 * JSON blob (`div[data-component-name="appTourList"] > script[type="application/json"]`) that
 * lists TOURS (destination+term summaries with a `searchFilter` querystring); hotel-level detail
 * for a tour needs a second request. This is a genuinely different two-step flow from
 * eTravel/der.ts's single search-result JSON endpoint (which already carries hotel+tour combined),
 * so nothing from der.ts's `DerTour`/`mapDerTours` fits here.
 *
 * Live recon 2026-07-29 (Chrome UA, ≥3 s apart) — what the three endpoints actually give:
 *
 * 1. GET /last-minute → hydration with `toursSearchSettings.documentGuid`
 *    (04af28e1-df72-4dc0-894e-6548566d67dc — a stable document id, not a session token: identical
 *    in the committed fixture and live), `tourListResult.tours` (the FIRST 20 tours only) and
 *    `tourListResult.totalCount` = 200.
 * 2. POST /api/TourList/getTourList {documentGuid, searchSettings:{searchFromIndex, toursCountToGet,
 *    sortOrder:'asc', sortBy:''}} → the remaining 180 tours, 20 per call (asking for 40 or 100
 *    still returns 20 — the page size is server-side). ~50 ms per call, so all 9 extra pages cost
 *    almost nothing but the politeness gap. The full 200-tour corpus is what makes a *spread*
 *    selection possible: 7 countries (Řecko 53, Španělsko 46, Tunisko 42, Bulharsko 35, Egypt 17,
 *    Kapverdské ostrovy 6, Jamajka 1), departures 2026-07-29 → 08-14, nights 4…14,
 *    `adultPriceFrom` 9 590 – 193 150 CZK, departure cities Praha/Brno/Ostrava/Pardubice/
 *    České Budějovice/Karlovy Vary. The 20 embedded tours alone top out at 29 990 and hold only
 *    4/7/11-night stays — no 14-night term and none of the 30–193k band exists in them — which is
 *    why the adapter pages the list before it picks anything instead of sampling whichever 20 the
 *    page happens to inline.
 * 3. GET /searchresult/getsearch?<tour.searchFilter> → `{HTML, groupData:{ProductsCount},
 *    paging:{Count,PageSize:20}}`: the site's own result-card renderer, all hotels of that tour in
 *    ONE request (PageSize 20 server-side, so ≥21-hotel tours are truncated — accepted).
 *    Deliberately used INSTEAD OF POST /api/TourList/getTourHotelList: identical hotel set at
 *    identical request cost, but the cards additionally carry the party total, the crossed-out
 *    original price and the discount, and the per-hotel departure city — all of which
 *    getTourHotelList omits. (getTourHotelList caps nothing: `hotelsCountToGet:30` on the Kos tour
 *    returned all 19 hotels. It is simply the poorer of two equally priced options.)
 *
 * Card shape (tests/fixtures/fischer/getsearch.json, a real 3-card slice of that response):
 * - Offer-critical fields come from the `data-gtm-impression` JSON attribute on
 *   `.js-gtm-product-item` (analytics payload, machine-readable): `name`, `id` (hotelId),
 *   `dimension4` = per-adult price, `price` = party total, `dimension2`/`dimension3` =
 *   country/destination, `dimension14` = "Flight-Praha" (transport + departure city),
 *   `dimension15` = meal text ("All Inclusive Ultra"/"Snídaně"/…). Nice-to-haves come from CSS
 *   hooks (`.js-stars`, `.js-roomPrice-originalPrice`, `.js-roomPrice-discount`) — deliberately
 *   split that way so a template change degrades stars/discount to null instead of zeroing offers.
 * - `data-start-date` on the card wrapper gives the real per-offer departure; `nights` is the
 *   printed "14 nocí/15 dní" figure, per card, rather than the tour's `nightsCount.from` — a tour
 *   whose range is genuinely {from,to} (1 of 200 today) sells several stay lengths under one id,
 *   and the date span is NOT a substitute: 2026-08-04 → 2026-08-19 is 15 days but is sold as
 *   14 nights (night return flight), matching the NN=14 in that offer's own booking URL.
 * - `dimension6` is NOT the star rating (it is 5 on every card, including 3* hotels) — stars are
 *   the asterisk count in `.js-stars`, cross-checked against getTourHotelList's `rating.count`.
 * - Prices are per adult, all-in incl. flight, for exactly the stated nights (verified against the
 *   site's own rendered cards).
 *
 * Not covered by this source, on purpose: /last-minute is a summer beach-charter section, so
 * Fischer's exotic/long-haul catalogue (Maledivy, Mauricius, Dominikána, …) never appears here.
 * Per the design spec §16.2 that inventory reaches the DB through the FIRO adapter instead, and
 * those pages use a different component + endpoint anyway.
 */
interface FischerHydration {
  documentGuid: string;
  tours: unknown[];
  totalCount: number;
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

interface TourMeta {
  departureDate: string | null;
  nights: number | null;
  /** Raw country string from tour.location.country, NOT yet canonicalized — mapOneCard
   *  applies isKnownCountry/normalizeCountry itself so the country-or-null invariant holds
   *  regardless of what the caller passes in. */
  country: string | null;
  locality: string | null;
  departureLocation: string | null;
}

function round(n: number): number {
  return Math.round(n);
}

function toPositiveNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** "76 000 Kč" / " 24 020 Kč" → 76000 / 24020. Non-breaking + narrow spaces are stripped too. */
function parseCardCzk(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parses the `/last-minute` hydration JSON out of the page HTML. Pure function: no I/O.
 * Returns an empty tours array (not a throw) if the hydration script is missing/malformed,
 * so callers can decide how to react (fetchOffers logs and returns early).
 */
export function parseFischerHydration(html: string): FischerHydration {
  const $ = cheerio.load(html);
  const raw = $('div[data-component-name="appTourList"] > script[type="application/json"]').first().html();
  if (!raw) return { documentGuid: '', tours: [], totalCount: 0 };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { documentGuid: '', tours: [], totalCount: 0 };
  }

  const obj = data as {
    toursSearchSettings?: { documentGuid?: string };
    tourListResult?: { tours?: unknown[]; totalCount?: number };
  };

  const tours = obj?.tourListResult?.tours ?? [];
  return {
    documentGuid: obj?.toursSearchSettings?.documentGuid ?? '',
    tours,
    totalCount: obj?.tourListResult?.totalCount ?? tours.length,
  };
}

/**
 * Picks `limit` tours out of the paged corpus so the resulting offers span the section rather than
 * one corner of it. Greedy novelty: each pick is the still-unpicked tour that adds the most unseen
 * facets — country first (weight 8), then destination (4), then price band (3), departure date (2),
 * length of stay (2) and departure city (1). Pure and deterministic: candidates are pre-sorted by
 * departure date (a last-minute watcher prefers the soonest term) and then by id, so ties always
 * resolve the same way and the selection is testable.
 *
 * Why not "the N earliest departures" (the previous behaviour): departure date is uncorrelated with
 * price and destination, and the board reliably holds ≥25 tours leaving within four days — so
 * earliest-first collapsed the output to a 4-day window, 4 countries and a 34k ceiling while the
 * 14-night / high-end / Egypt / Kapverdy segments were never requested on any run.
 */
export function selectDiverseTours(tours: FischerTour[], limit: number): FischerTour[] {
  if (limit <= 0) return [];
  const candidates = [...tours].sort((a, b) => {
    const da = a.departureDate ?? '9999';
    const db = b.departureDate ?? '9999';
    if (da !== db) return da < db ? -1 : 1;
    return a.id - b.id;
  });
  if (candidates.length <= limit) return candidates;

  // Facet value per tour, paired with the weight of "this facet is new". Price is bucketed into
  // 10k CZK bands so near-identical teasers don't each count as a fresh price point.
  const facets: { weight: number; of: (t: FischerTour) => string }[] = [
    { weight: 8, of: (t) => `c:${t.location?.country ?? '?'}` },
    { weight: 4, of: (t) => `d:${t.location?.destination ?? '?'}` },
    { weight: 3, of: (t) => `p:${Math.floor((t.adultPriceFrom?.amount ?? 0) / 10000)}` },
    { weight: 2, of: (t) => `t:${t.departureDate ?? '?'}` },
    { weight: 2, of: (t) => `n:${t.nightsCount?.from ?? '?'}` },
    { weight: 1, of: (t) => `a:${t.departureLocation ?? '?'}` },
  ];

  const seen = new Set<string>();
  const picked: FischerTour[] = [];
  const remaining = new Set(candidates);

  while (picked.length < limit && remaining.size > 0) {
    let best: FischerTour | null = null;
    let bestScore = -1;
    for (const tour of remaining) {
      let score = 0;
      for (const facet of facets) if (!seen.has(facet.of(tour))) score += facet.weight;
      // Strict > keeps the first candidate in the pre-sorted order on a tie.
      if (score > bestScore) {
        bestScore = score;
        best = tour;
      }
    }
    if (!best) break;
    remaining.delete(best);
    picked.push(best);
    for (const facet of facets) seen.add(facet.of(best));
  }

  return picked;
}

/**
 * Maps the `HTML` payload of one `/searchresult/getsearch` response (all hotel cards of a single
 * tour) to NormalizedOffer[], combining it with that tour's shared metadata. Pure function: no I/O.
 * Dedupes by `sourceOfferKey`, keeping the first occurrence.
 */
export function mapFischerSearchCards(html: string, tourMeta: TourMeta): NormalizedOffer[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  $('[id="divHotelCard"]').each((_i, el) => {
    const offer = mapOneCard($(el), tourMeta);
    if (!offer) return;
    if (seen.has(offer.sourceOfferKey)) return;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  });

  return offers;
}

/** One `#divHotelCard` wrapper as selected by cheerio. */
type Card = ReturnType<cheerio.CheerioAPI>;

function mapOneCard(card: Card, tourMeta: TourMeta): NormalizedOffer | null {
  let gtm: Record<string, unknown> = {};
  const gtmRaw = card.find('.js-gtm-product-item').first().attr('data-gtm-impression');
  if (gtmRaw) {
    try {
      gtm = JSON.parse(gtmRaw) as Record<string, unknown>;
    } catch {
      gtm = {};
    }
  }

  const title = typeof gtm.name === 'string' ? gtm.name.trim() : '';
  if (!title) return null;

  // Per-adult price: the analytics attribute first, the rendered "Dospělý …" figure as fallback so
  // a change to the gtm payload alone doesn't silently drop every offer.
  const pricePerPersonRaw =
    toPositiveNumber(gtm.dimension4) ?? parseCardCzk(card.find('.fshr-price-adult strong').first().text());
  if (pricePerPersonRaw === null) return null;
  const pricePerPerson = round(pricePerPersonRaw);

  const href =
    card.find('h2 a[href]').first().attr('href') ?? card.find('a.js-gtm-productClick[href]').first().attr('href');
  if (!href) return null;
  const url = new URL(href.split('#')[0]!, BASE_URL).toString();

  const priceTotalRaw =
    toPositiveNumber(gtm.price) ?? parseCardCzk(card.find('.js-totalPrice').first().text());
  const priceTotal = priceTotalRaw !== null ? round(priceTotalRaw) : null;

  // The card's own term wins over the tour summary: a tour whose nightsCount is a real {from,to}
  // range serves hotels of different stay lengths under one tour id.
  //
  // Nights come from the printed "14 nocí/15 dní" line, NOT from the date span: on charter terms
  // with a night return flight the two disagree (2026-08-04 → 2026-08-19 is 15 days but the site
  // sells it as 14 nights, matching the tour's own nightsCount and the NN=14 in the booking URL).
  // The date difference is only a fallback for a card that prints no term line.
  // `|| null`, not `?? null`: a present-but-empty attribute must fall through to the tour's own
  // date, otherwise departureDate would be emitted as the empty string (a malformed value that
  // still passes a `!== null` check downstream) instead of the tour date we do have.
  const startDate = card.attr('data-start-date')?.trim() || null;
  const endDate = card.attr('data-end-date')?.trim() || null;
  const departureDate = startDate ?? tourMeta.departureDate;
  const nights = printedNights(card) ?? nightsBetween(startDate, endDate) ?? tourMeta.nights;

  const board = normalizeBoard(typeof gtm.dimension15 === 'string' ? gtm.dimension15 : null);

  // Stars are the asterisk run in `.js-stars` ("****" → 4). gtm.dimension6 looks like a rating but
  // is 5 on every card including 3* hotels, so it is deliberately ignored. Unrated properties
  // (villas) render an empty span → null, matching every other adapter's "no rating" convention.
  const starsText = card.find('.js-stars').first().text().trim();
  const starCount = (starsText.match(/\*/g) ?? []).length;
  const stars = starCount > 0 ? starCount : null;

  // dimension14 is "<transport>-<departure city>", e.g. "Flight-Praha"; the tour's own
  // departureLocation is the fallback. Kept as the raw Czech city name — core/normalize's
  // normalizeAirport folds it to IATA for cross-source matching.
  const dim14 = typeof gtm.dimension14 === 'string' ? gtm.dimension14 : '';
  const cityFromCard = dim14.includes('-') ? dim14.slice(dim14.indexOf('-') + 1).trim() : '';
  // Single fallback chain: a dimension14 that is missing, has no separator, OR carries an empty
  // city ("Flight-") all fall through to the tour's departure city rather than only the middle case.
  const departureAirport = cityFromCard || tourMeta.departureLocation?.trim() || null;

  const { claimedOriginalPrice, claimedDiscountPct } = computeClaimedPrice(
    pricePerPerson,
    priceTotal,
    parseCardCzk(card.find('.js-roomPrice-originalPrice').first().text()),
    parseCardCzk(card.find('.js-roomPrice-discount').first().text()),
  );

  // LESSON (binding): country must be the real country from tour location data, canonical
  // via normalizeCountry, and null (never a raw/unknown string, never the locality/city) when
  // it doesn't resolve to a known country.
  const rawCountry = tourMeta.country ?? (typeof gtm.dimension2 === 'string' ? gtm.dimension2 : null);
  const country = isKnownCountry(rawCountry) ? normalizeCountry(rawCountry) : null;
  const locality = tourMeta.locality ?? (typeof gtm.dimension3 === 'string' ? gtm.dimension3 : null);

  // departureAirport is part of the key: the live list carries the same hotel/date/nights/board as
  // separate Praha and Ostrava tours, and without the city they collapsed into one offer.
  const hotelId = typeof gtm.id === 'string' || typeof gtm.id === 'number' ? gtm.id : title;
  const sourceOfferKey = offerKeyHash([hotelId, departureDate, nights, board, departureAirport]);

  return {
    source: 'fischer',
    sourceOfferKey,
    title,
    country,
    locality,
    stars,
    board,
    transport: 'flight',
    departureAirport,
    departureDate,
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
 * The "14 nocí/15 dní (Út-St)" line of a card's term summary → 14. Matched paragraph-by-paragraph
 * and anchored at the start of the line on purpose: the summary block's concatenated text reads
 * "…4. 8. 20264 nocí/5 dní", where an unanchored /(\d+)\s*noc/ would happily return 20264.
 */
function printedNights(card: Card): number | null {
  const paragraphs = card.find('.fshr-detail-summary-mainInfo .fshr-detail-summary-paragraph');
  for (let i = 0; i < paragraphs.length; i += 1) {
    const match = /^(\d+)\s*noc/i.exec(paragraphs.eq(i).text().trim());
    if (match) return toPositiveNumber(match[1]);
  }
  return null;
}

function nightsBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const nights = Math.round((to - from) / 86_400_000);
  return nights > 0 ? nights : null;
}

/**
 * Fischer prints the crossed-out original and the discount as PARTY totals ("Původní cena 76 000
 * Kč" / "Sleva 24 020 Kč" for 2 adults), while NormalizedOffer wants per-person figures — same
 * convention as der.ts. Adults are derived from total/perPerson rather than ctx.adults so the
 * mapper stays pure. Anything that doesn't check out (no discount row, inconsistent arithmetic, a
 * pct outside 0–100) yields null/null rather than a guess.
 */
function computeClaimedPrice(
  pricePerPerson: number,
  priceTotal: number | null,
  originalTotal: number | null,
  discountTotal: number | null,
): { claimedOriginalPrice: number | null; claimedDiscountPct: number | null } {
  if (originalTotal === null || discountTotal === null || !(discountTotal > 0)) {
    return { claimedOriginalPrice: null, claimedDiscountPct: null };
  }
  const adults = priceTotal !== null && priceTotal > 0 ? Math.max(1, round(priceTotal / pricePerPerson)) : 1;
  const claimedOriginalPrice = round(originalTotal / adults);
  if (!(claimedOriginalPrice > pricePerPerson)) {
    return { claimedOriginalPrice: null, claimedDiscountPct: null };
  }
  const pct = round(((claimedOriginalPrice - pricePerPerson) / claimedOriginalPrice) * 100);
  if (!(pct > 0) || !(pct < 100)) {
    return { claimedOriginalPrice: null, claimedDiscountPct: null };
  }
  return { claimedOriginalPrice, claimedDiscountPct: pct };
}

function toTourMeta(t: FischerTour): TourMeta {
  const departureDate = t.departureDate ? t.departureDate.slice(0, 10) : null;
  // Fallback only: the per-card data-start/end-date pair is the real term. `from` (the shortest
  // stay of the range) is used when a card carries no dates of its own.
  const nights = t.nightsCount?.from ?? null;
  const country = t.location?.country ?? null;
  const locality = t.location?.destination ?? null;
  return { departureDate, nights, country, locality, departureLocation: t.departureLocation ?? null };
}

/**
 * Pages POST /api/TourList/getTourList until the whole tour corpus is known, the page cap is hit or
 * the request budget runs out. A page failure is not fatal — we keep the tours already collected
 * and let the caller work with a smaller corpus — but a SourceBlockedError stops everything, since
 * hammering a host that is actively refusing us is exactly what the politeness rules forbid.
 */
async function fetchTourListPages(
  ctx: SourceContext,
  documentGuid: string,
  totalCount: number,
  budget: { used: number },
): Promise<{ tours: unknown[]; blocked: SourceBlockedError | null }> {
  const tours: unknown[] = [];
  if (!documentGuid) {
    ctx.log('fischer: no documentGuid in hydration, cannot page the tour list');
    return { tours, blocked: null };
  }

  const pages = Math.min(MAX_TOUR_LIST_PAGES, Math.ceil(Math.max(0, totalCount - TOURS_PER_PAGE) / TOURS_PER_PAGE));
  for (let page = 1; page <= pages; page += 1) {
    if (budget.used >= MAX_REQUESTS - MAX_TOUR_DETAILS) break;
    try {
      budget.used += 1;
      const res = await ctx.http.json<{ tours?: unknown[] }>(`${BASE_URL}/api/TourList/getTourList`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentGuid,
          searchSettings: {
            searchFromIndex: page * TOURS_PER_PAGE,
            toursCountToGet: TOURS_PER_PAGE,
            sortOrder: 'asc',
            sortBy: '',
          },
        }),
      });
      const batch = res.tours ?? [];
      if (batch.length === 0) break;
      tours.push(...batch);
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        ctx.log(`fischer: tour list page ${page} blocked (${err.message}), stopping`);
        return { tours, blocked: err };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`fischer: tour list page ${page} failed (${message}), continuing with ${tours.length} paged tours`);
      break;
    }
  }
  return { tours, blocked: null };
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const budget = { used: 0 };
  let hydration: FischerHydration;
  try {
    budget.used += 1;
    const html = await ctx.http.text(`${BASE_URL}/last-minute`);
    hydration = parseFischerHydration(html);
  } catch (err) {
    // Total failure of the seed/listing fetch is NOT "market empty" — it means we saw nothing
    // because the request itself failed. Rethrow so runScan records this source as 'failed'
    // (and skips markMissedOffers), rather than swallowing to [] which would flip the whole
    // source inventory inactive after 2 runs and mute the 3×-failed health alert.
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`fischer: last-minute page fetch failed (${message}), aborting`);
    throw err;
  }

  const { tours: pagedTours, blocked } = await fetchTourListPages(
    ctx,
    hydration.documentGuid,
    hydration.totalCount,
    budget,
  );
  // A block while paging means the host is refusing us right now: do not walk on to 25 more
  // requests. Nothing has been collected yet, so rethrowing here is the same contract as a block
  // on the first detail request — runScan records 'failed', the BLOCKED marker / 24h backoff engages.
  if (blocked) throw blocked;

  const tours = ([...hydration.tours, ...pagedTours] as FischerTour[]).filter((t) => t?.adultPriceFrom?.amount);
  if (tours.length === 0) {
    ctx.log('fischer: no tours with adultPriceFrom found on last-minute page, aborting');
    return [];
  }

  const detailBudget = Math.min(MAX_TOUR_DETAILS, Math.max(0, MAX_REQUESTS - budget.used));
  const targetTours = selectDiverseTours(tours, detailBudget);
  ctx.log(
    `fischer: ${tours.length}/${hydration.totalCount} tours known after ${budget.used} requests, ` +
      `selected ${targetTours.length} for detail`,
  );

  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  for (const tour of targetTours) {
    if (budget.used >= MAX_REQUESTS) {
      ctx.log(`fischer: request budget ${MAX_REQUESTS} exhausted, stopping`);
      break;
    }
    const tourMeta = toTourMeta(tour);
    let offers: NormalizedOffer[];
    try {
      budget.used += 1;
      const res = await ctx.http.json<{ HTML?: string; groupData?: { ProductsCount?: number } }>(
        `${BASE_URL}/searchresult/getsearch?${tour.searchFilter}`,
      );
      offers = mapFischerSearchCards(res.HTML ?? '', tourMeta);
      successCount += 1;
      // Canary: the response states how many products it rendered, so a template change that
      // breaks card parsing shows up in the log instead of quietly shrinking the source.
      const expected = res.groupData?.ProductsCount;
      if (typeof expected === 'number' && expected > 0 && offers.length === 0) {
        ctx.log(`fischer: tour ${tour.id} reported ${expected} products but no card parsed`);
      }
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further tour requests (politeness) but
        // keep whatever offers earlier tours already yielded. Record the block as lastError so a
        // block BEFORE the first successful tour still trips the rethrow below.
        lastError = err;
        ctx.log(`fischer: tour ${tour.id} blocked (${err.message}), stopping`);
        break;
      }
      // Any other per-tour failure (network error, parse error, transient 5xx exhausted)
      // must not sink the whole fetch — log and move on to the next tour.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`fischer: tour ${tour.id} getsearch failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every per-tour request failed (the /last-minute page itself was fine): this is not "market
    // empty" — rethrow (matching the seed-fetch rethrow above and every sibling adapter) so
    // runScan records this source 'failed' rather than degrading to [] (which would flip known
    // offers inactive and mute the health alert). A block on the first tour lands here → BLOCKED
    // marker / 24h backoff engages.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`fischer: all ${targetTours.length} tour requests failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(
    `fischer: fetched ${all.length} offers across ${successCount} tours in ${budget.used} requests`,
  );
  return all;
}

export const fischer: SourceAdapter = {
  name: 'fischer',
  fetchOffers,
};
