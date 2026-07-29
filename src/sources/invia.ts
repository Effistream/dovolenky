import * as cheerio from 'cheerio';
import { randomUUID } from 'node:crypto';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { isKnownCountry, normalizeBoard, normalizeCountry, offerKeyHash, parseCzk } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.invia.cz';
const AJAX_URL = `${BASE_URL}/search-results/ajax-boxes`;

/**
 * Request budget. src/core/run.ts aborts any adapter whose fetchOffers exceeds
 * ADAPTER_FETCH_TIMEOUT_MS (240 s) and records the source 'failed' — which is strictly worse than
 * partial coverage, because the whole source then vanishes from the board. HttpClient serializes
 * per host with a 3 s gap, so each request costs ~5 s wall clock (3 s gap + ~2 s fetch, measured).
 *
 * COUNTRY_QUERIES + LAST_MINUTE_PAGES plan 32 requests; a full live run on 2026-07-29 took 160 s,
 * i.e. ~5 s per request. MAX_REQUESTS is the hard stop so a country added to the table can never
 * silently blow the timeout, and DEADLINE_MS stops the run early — returning a partial harvest,
 * which the board keeps — rather than letting run.ts abort it and drop the source entirely. It is
 * deliberately below the measured 160 s + one worst-case retry storm.
 */
const MAX_REQUESTS = 34;
const DEADLINE_MS = 175_000;

/**
 * Country ids re-verified live on 2026-07-29 by GETting each https://www.invia.cz/dovolena/<slug>/
 * landing page and reading `data-search_params` (the exact body the site's own search posts) plus
 * `data-found_boxes_count` as the non-zero cross-check — the same protocol dovolena.ts uses. The
 * count after each entry is that page's found_boxes_count at verification time; it is recon
 * provenance, not a runtime value.
 *
 * `pages` is how many pages we pull for that country (fetchOffers walks them with the
 * `searchProps.offsets` cursor from the previous response). Big catalogues get 2, everything else
 * 1: breadth across destinations beats depth in one, because Invia's default ordering already
 * front-loads discounted packages on page 1.
 *
 * Three countries are queried as an id PAIR because the site itself does — Španělsko [30, 9] folds
 * in the Canaries (id 9, a 2 517-offer catalogue of its own), Mauricius [16, 90] and Indonésie
 * [56, 40] likewise. We label the pair with the mainland name so config/watch.yaml's country
 * filters match. Kuba (id 17) is verified but omitted: found_boxes_count was 0, so it would spend
 * a request for nothing.
 */
interface CountryQuery {
  name: string;
  ids: number[];
  pages: number;
}

const COUNTRY_QUERIES: CountryQuery[] = [
  // léto-moře (config/watch.yaml profile "leto-more") — the eight countries it asks for, plus the
  // neighbouring Mediterranean catalogues Invia sells at the same price point.
  { name: 'Řecko', ids: [28], pages: 2 }, // 4 667
  { name: 'Turecko', ids: [31], pages: 2 }, // 2 785
  { name: 'Španělsko', ids: [30, 9], pages: 2 }, // 1 515 (+ Kanárské ostrovy 2 517)
  // Chorvatsko has the biggest catalogue of all but gets one page: its page 1 is 15/16 own-transport
  // apartments with the fewest discount badges of any country measured, so a second page buys less
  // than a first page anywhere else.
  { name: 'Chorvatsko', ids: [33], pages: 1 }, // 6 843
  { name: 'Itálie', ids: [22], pages: 2 }, // 4 143
  { name: 'Egypt', ids: [11], pages: 1 }, // 881
  { name: 'Kypr', ids: [29], pages: 1 }, // 928
  { name: 'Bulharsko', ids: [32], pages: 1 }, // 591
  { name: 'Tunisko', ids: [10], pages: 1 }, // 392
  { name: 'Albánie', ids: [143], pages: 1 }, // 390
  { name: 'Černá Hora', ids: [34], pages: 1 }, // 191
  // exotika (profile "exotika", cap 60 000 Kč/os) — the band the old cheapest-first query could
  // structurally never reach: Maledivy alone starts at 22 490 Kč/os.
  { name: 'Spojené arabské emiráty', ids: [13], pages: 2 }, // 2 132
  { name: 'Thajsko', ids: [12], pages: 2 }, // 1 980
  { name: 'Maledivy', ids: [79], pages: 1 }, // 645
  { name: 'Srí Lanka', ids: [73], pages: 1 }, // 485
  { name: 'Vietnam', ids: [68], pages: 1 }, // 434
  { name: 'Mexiko', ids: [15], pages: 1 }, // 396
  { name: 'Omán', ids: [77], pages: 1 }, // 337
  { name: 'Zanzibar', ids: [251], pages: 1 }, // 327
  { name: 'Dominikánská republika', ids: [14], pages: 1 }, // 235
  { name: 'Seychely', ids: [127], pages: 1 }, // 159
  { name: 'Mauricius', ids: [16, 90], pages: 1 }, // 107
  { name: 'Indonésie', ids: [56, 40], pages: 1 }, // 104
  { name: 'Kapverdy', ids: [123], pages: 1 }, // 53
];

/** Pages pulled by the country-agnostic last-minute query (profile "last-minute"). */
const LAST_MINUTE_PAGES = 2;

/**
 * countryId -> canonical country name, derived from the verified table above. Used to resolve the
 * country of a card returned by the country-agnostic last-minute query, where we cannot name the
 * country from the request itself.
 */
const COUNTRY_BY_ID: Record<number, string> = Object.fromEntries(
  COUNTRY_QUERIES.flatMap((q) => q.ids.map((id) => [id, q.name] as const)),
);

/**
 * mealId -> Board. Ids 1/2/4/5/6/11/12 were each observed live on 2026-07-29 next to the card's own
 * Czech meal label (1 "Plná penze", 2 "Polopenze", 4 "Bez stravy", 5 "All Inclusive", 6 "Snídaně",
 * 11 "Ultra All inclusive", 12 "Light All inclusive"). This map is only the FALLBACK — parseCard
 * reads that visible label through normalizeBoard first, so an id Invia adds later still maps
 * correctly instead of silently becoming 'unknown'.
 */
const MEAL_ID_TO_BOARD: Record<number, Board> = {
  1: 'FB',
  2: 'HB',
  4: 'none',
  5: 'AI',
  6: 'BB',
  11: 'AI',
  12: 'AI',
};

/**
 * transportationId -> Transport (3=airplane, 4=self_arranged, 2=bus). Ids outside this set exist
 * (5 was seen once during the audit) and are resolved from the card text instead — see
 * transportFromParams.
 */
const TRANSPORT_ID_TO_TRANSPORT: Record<number, Transport> = {
  2: 'bus',
  3: 'flight',
  4: 'own',
};

/** Departure airports we treat as "ours" when a card offers several (see pickDepartureAirport). */
const CZ_AIRPORTS = new Set(['PRG', 'BRQ', 'OSR', 'PED']);

/**
 * Invia resells several inventories and the `s_offer_id` JWT is shaped by whichever provider owns
 * the term. Measured live on 2026-07-29 across Egypt/Turecko/Thajsko/Řecko (64 cards):
 *
 *   prefix INVF / INVHO / INVB (Invia's own) -> `checkInDate` / `checkOutDate` + `termId`
 *   prefix TTF / TUI / MXF     (resold)      -> `dateFrom`    / `dateTo`      + `offerId`
 *                                               (TUI carries `termId: null` explicitly)
 *
 * Both date pairs are the same YYYYMMDD strings. Reading only the Invia-native names left
 * departureDate null on 273 of 458 offers in a full live run — and a null departureDate is not a
 * cosmetic gap: filters.ts rejects such an offer from every profile that sets departure_months
 * (leto-more) or departure_within_days (last-minute, the only notifying profile), market.ts returns
 * no price peers for it at all (so the discount ladder can never qualify it), and computeMatchKey
 * opts it out of cross-source matching. Hence both spellings, plus the rendered-term text fallback
 * in `termDatesFromParams` for a provider we have not seen yet.
 */
interface OfferJwtPayload {
  hotelId?: number;
  termId?: string | null;
  offerId?: string; // resold inventory's term id (TTF/TUI/MXF) — stands in for termId
  tourOperatorId?: number;
  checkInDate?: string; // YYYYMMDD (Invia-native)
  checkOutDate?: string; // YYYYMMDD (Invia-native)
  dateFrom?: string; // YYYYMMDD (resold inventory)
  dateTo?: string; // YYYYMMDD (resold inventory)
  daysCount?: number;
  mealId?: number;
  transportationId?: number;
  departureAirport?: number;
  countryId?: number;
  localityId?: number;
  [key: string]: unknown;
}

/**
 * Decodes (without verifying) the payload segment of the unsigned-for-our-purposes JWT
 * carried in a card's `s_offer_id` query param. Returns null for anything that isn't a
 * well-formed 3-segment JWT with a valid base64url JSON payload — callers must treat a null
 * result as "no term data available" and fall back to whatever GA4/text data they have.
 */
export function decodeOfferJwt(sOfferId: string): Record<string, unknown> | null {
  if (!sOfferId) return null;
  const parts = sOfferId.split('.');
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    const json = Buffer.from(payloadPart, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function unescapeHtmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#32;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

interface Ga4Item {
  item_name?: string;
  item_brand?: string;
  item_category_local?: string;
  price?: number;
  value?: number;
  item_parameter_3?: string; // departure airport IATA code(s), pipe-joined when several
  item_parameter_4?: string; // "s:_3.5_r:_4.1_o:_0_p:_0" — s = stars, r = guest rating
}

function parseGa4Item($: cheerio.CheerioAPI, card: ReturnType<cheerio.CheerioAPI>): Ga4Item | null {
  const raw = card.find('[data-ga-click-data-value]').first().attr('data-ga-click-data-value');
  if (!raw) return null;
  try {
    const decoded = unescapeHtmlEntities(raw);
    const json = JSON.parse(decoded) as { ecommerce?: { items?: Ga4Item[] } };
    return json.ecommerce?.items?.[0] ?? null;
  } catch {
    return null;
  }
}

function yyyymmddToIso(raw: string | undefined): string | null {
  if (!raw || raw.length !== 8) return null;
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function daysBetween(startRaw: string | undefined, endRaw: string | undefined): number | null {
  if (!startRaw || !endRaw || startRaw.length !== 8 || endRaw.length !== 8) return null;
  const start = Date.UTC(Number(startRaw.slice(0, 4)), Number(startRaw.slice(4, 6)) - 1, Number(startRaw.slice(6, 8)));
  const end = Date.UTC(Number(endRaw.slice(0, 4)), Number(endRaw.slice(4, 6)) - 1, Number(endRaw.slice(6, 8)));
  const diffDays = Math.round((end - start) / (24 * 60 * 60 * 1000));
  return Number.isFinite(diffDays) ? diffDays : null;
}

/**
 * Nights as Invia itself advertises them, from the card's "9 dní / 7 nocí" label.
 *
 * This must win over any date arithmetic: the JWT's checkIn/checkOut span the whole TRIP, so on a
 * flight package that leaves in the evening it is one more than the hotel nights sold, and on a bus
 * package two more (both travel nights). Measured 2026-07-29 across 68 cards carrying the label:
 * the JWT-derived number disagreed with it on 36, always overstating. Overstated nights inflate the
 * offer and skew the per-night price the discount ladder derives from it.
 */
function nightsFromParams(params: string[]): number | null {
  for (const text of params) {
    const m = text.match(/(\d+)\s*noc/i);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Departure/return dates from the card's own rendered term ("ne 11.10. - po 19.10.2026"), the last
 * resort when the JWT carries neither `checkInDate` nor `dateFrom` (an inventory provider we have
 * not seen). Every card in every live sample renders this strip, so it is a genuine safety net
 * rather than dead code.
 *
 * Only the END of the range carries a year. The start's year is the same one, except when the term
 * crosses New Year ("čt 31.12. - st 6.1.2027"), which shows up as a start month LATER than the end
 * month — then the start belongs to the previous year.
 */
export function termDatesFromParams(params: string[]): { from: string; to: string } | null {
  for (const text of params) {
    const m = text.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*-\s*\D*?(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
    if (!m) continue;
    const [, d1, m1, d2, m2, y2] = m;
    const startMonth = Number(m1);
    const endMonth = Number(m2);
    const endYear = Number(y2);
    if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) continue;
    const startYear = startMonth > endMonth ? endYear - 1 : endYear;
    const pad = (n: string) => n.padStart(2, '0');
    return {
      from: `${startYear}${pad(m1!)}${pad(d1!)}`,
      to: `${endYear}${pad(m2!)}${pad(d2!)}`,
    };
  }
  return null;
}

/** Board from the card's own Czech meal label ("Ultra All inclusive", "Polopenze", …). */
function boardFromParams(params: string[]): Board | null {
  for (const text of params) {
    const board = normalizeBoard(text);
    if (board !== 'unknown') return board;
  }
  return null;
}

/**
 * Transport from the card text, for transportationIds outside TRANSPORT_ID_TO_TRANSPORT. Flight
 * cards render the route plus a "Zobrazit letový plán" link, own-transport cards render "Vlastní".
 */
function transportFromParams(params: string[]): Transport | null {
  for (const text of params) {
    if (/letov[ýy]\s+pl[áa]n/i.test(text)) return 'flight';
    if (/autobus|autokar/i.test(text)) return 'bus';
    if (/^vlastn[íi]/i.test(text.trim())) return 'own';
  }
  return null;
}

/**
 * Hotel star category (Invia uses half-stars). Primary source is the GA4 item's `item_parameter_4`
 * — "s:_3.5_r:_4.1_o:_0_p:_0", where `s` is the category and `r` the (different) guest rating, so
 * reading the structured field avoids ever confusing the two. Falls back to the rendered
 * `<span class="stars">` label. 0 means "unknown" at Invia, not "zero stars" → null.
 */
function parseStars($: cheerio.CheerioAPI, card: ReturnType<cheerio.CheerioAPI>, ga4: Ga4Item | null): number | null {
  const fromGa4 = ga4?.item_parameter_4?.match(/(?:^|_)s:_(\d+(?:\.\d+)?)_/);
  const raw = fromGa4?.[1] ?? card.find('.stars .u-vhide').first().text().match(/(\d+(?:[.,]\d+)?)\s*\/\s*5/)?.[1];
  if (raw === undefined) return null;
  const stars = Number(raw.replace(',', '.'));
  return Number.isFinite(stars) && stars > 0 ? stars : null;
}

/**
 * Per-person and whole-group price. Every card renders both ("od 11 890 Kč za os." and
 * "od 23 780 Kč za všechny"), distinguished by the `.price__suffix` text; the group price is what
 * the site calls priceTotal and was previously hardcoded null. Falls back to the old
 * `[data-testid="price"]` selector for the per-person figure if the `.price` wrapper ever changes.
 */
function parsePrices(
  $: cheerio.CheerioAPI,
  card: ReturnType<cheerio.CheerioAPI>,
): { pricePerPerson: number | null; priceTotal: number | null } {
  let pricePerPerson: number | null = null;
  let priceTotal: number | null = null;

  card.find('.price').each((_, el) => {
    const $el = $(el);
    const value = parseCzk($el.text());
    if (value === null) return;
    if (/v[šs]echny/i.test($el.find('.price__suffix').text())) {
      priceTotal ??= value;
    } else {
      pricePerPerson ??= value;
    }
  });

  pricePerPerson ??= parseCzk(card.find('[data-testid="price"]').first().parent().text());
  return { pricePerPerson, priceTotal };
}

/**
 * A card may list several departure airports for the same term ("PRG|BRQ|BTS", rendered as
 * "Praha, Brno, Bratislava"). NormalizedOffer.departureAirport is a single airport, and the whole
 * point of the field downstream is "can I leave from home?", so prefer a Czech airport when one is
 * offered and otherwise keep the first listed rather than emitting an unusable pipe-joined string.
 */
function pickDepartureAirport(raw: string | undefined): string | null {
  const codes = (raw ?? '')
    .split('|')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (codes.length === 0) return null;
  return codes.find((c) => CZ_AIRPORTS.has(c)) ?? codes[0]!;
}

/**
 * Parses one page of Invia's `customData.boxes` server-rendered HTML fragment (as returned
 * by `POST /search-results/ajax-boxes`) into NormalizedOffer[].
 *
 * Country resolution priority (per spec §3 row 1 lesson: country must be a real country,
 * never a city/resort):
 *   1. `opts.country` — the authoritative country we asked for in the search query (e.g.
 *      "Řecko" when we queried nl_country_id=[28]). Always used when provided, since we know
 *      exactly which country we searched.
 *   2. JWT payload `countryId` — looked up in COUNTRY_BY_ID (ids verified off the site's own
 *      landing pages). Used for the country-agnostic last-minute query (opts.country unset),
 *      since it's a stronger signal than the GA4 slug.
 *   3. GA4 `item_category_local` (a Czech country slug, e.g. "italie", "madarsko") ONLY if
 *      isKnownCountry recognizes it as a real, canonical country — used when neither of the
 *      above apply.
 *   4. null — never fall back to locality/resort text, nor a non-canonical/raw slug, as country.
 */
export function parseInviaBoxes(
  json: { customData: { boxes: string } },
  opts: { country?: string } = {},
): NormalizedOffer[] {
  const $ = cheerio.load(json.customData.boxes);
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  $('article.b-product-list-2').each((_, el) => {
    const offer = parseCard($, $(el), opts.country);
    if (!offer) return;
    if (seen.has(offer.sourceOfferKey)) return;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  });

  return offers;
}

function parseCard(
  $: cheerio.CheerioAPI,
  card: ReturnType<cheerio.CheerioAPI>,
  queryCountry: string | undefined,
): NormalizedOffer | null {
  const titleEl = card.find('h2').first();
  const title = titleEl.text().trim();
  if (!title) return null;

  const detailLink = card.find('a[href*="s_offer_id="]').first();
  const href = detailLink.attr('href');
  if (!href) return null;
  const url = new URL(href, BASE_URL).toString();

  const sOfferId = new URL(url).searchParams.get('s_offer_id');
  const jwt = sOfferId ? decodeOfferJwt(sOfferId) : null;
  const payload = (jwt ?? {}) as OfferJwtPayload;

  const ga4 = parseGa4Item($, card);

  const { pricePerPerson, priceTotal } = parsePrices($, card);
  if (pricePerPerson === null) return null;

  // The card's own parameter strip: nights, route/transport, term, board, tour operator.
  const params: string[] = [];
  card.find('.tour-params__item').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) params.push(text);
  });

  const locationText = card.find('.b-product-list-2__location').first().text().trim();
  const locationParts = locationText.split('-').map((s) => s.trim()).filter(Boolean);
  const locality = locationParts.length > 1 ? locationParts[locationParts.length - 1]! : null;

  const countryFromJwt = typeof payload.countryId === 'number' ? COUNTRY_BY_ID[payload.countryId] ?? null : null;
  const country =
    queryCountry ??
    countryFromJwt ??
    (ga4?.item_category_local ? resolveCountryFromSlug(ga4.item_category_local) : null);

  // Term dates: Invia-native names, then the resold-inventory names, then the rendered term.
  // See OfferJwtPayload — reading only checkInDate/checkOutDate nulls ~60% of a live harvest.
  const termText = termDatesFromParams(params);
  const checkIn = payload.checkInDate ?? payload.dateFrom ?? termText?.from;
  const checkOut = payload.checkOutDate ?? payload.dateTo ?? termText?.to;

  const departureDate = yyyymmddToIso(checkIn);
  const nights =
    nightsFromParams(params) ?? daysBetween(checkIn, checkOut) ?? (payload.daysCount ? payload.daysCount - 1 : null);

  const board: Board =
    boardFromParams(params) ??
    (typeof payload.mealId === 'number' ? MEAL_ID_TO_BOARD[payload.mealId] ?? 'unknown' : 'unknown');
  const transport: Transport =
    (typeof payload.transportationId === 'number' ? TRANSPORT_ID_TO_TRANSPORT[payload.transportationId] : undefined) ??
    transportFromParams(params) ??
    'unknown';

  const departureAirport = pickDepartureAirport(ga4?.item_parameter_3);
  const tourOperator = ga4?.item_brand?.trim() || null;
  const stars = parseStars($, card, ga4);

  const discountText = card.find('.tag--discount-outline .tag__label').first().text().trim();
  const discountMatch = discountText.match(/(\d+)\s*%/);
  let claimedDiscountPct: number | null = null;
  let claimedOriginalPrice: number | null = null;
  if (discountMatch) {
    const pct = Number(discountMatch[1]);
    if (pct > 0 && pct < 100) {
      claimedDiscountPct = pct;
      claimedOriginalPrice = Math.round(pricePerPerson / (1 - pct / 100));
    }
  }

  // termId is Invia-native only; resold inventory calls the same thing offerId (and TUI sends an
  // explicit termId: null). Without this the key of a resold term degenerates to hotelId+nights,
  // so two different terms at the same hotel with the same length would collide and one would be
  // silently dropped by the dedup below.
  const termId = payload.termId ?? payload.offerId ?? null;
  const sourceOfferKey = offerKeyHash([payload.hotelId ?? title, termId, departureDate, nights]);

  return {
    source: 'invia',
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
    priceTotal,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator,
    url,
  };
}

/**
 * Resolves a GA4 `item_category_local` slug (e.g. "italie", "ceska_republika") to a canonical
 * country name, or null if the slug doesn't resolve to a country we recognize. Underscore
 * word-separators are normalized to spaces before the isKnownCountry/normalizeCountry lookup.
 * Unlike normalizeCountry alone, this never leaks a raw/non-canonical slug (e.g. "spanelsko
 * pevnina" or an unrecognized "polsko"-like token before Polsko was added) — per spec, country
 * must be canonical or null, never garbage/city text.
 */
function resolveCountryFromSlug(slug: string): string | null {
  const candidate = slug.replace(/_/g, ' ');
  return isKnownCountry(candidate) ? normalizeCountry(candidate) : null;
}

interface SearchProps {
  isNextPageAvailable?: boolean;
  offsets?: string;
}

interface AjaxBoxesResponse {
  customData: { boxes: string; searchProps?: SearchProps };
}

interface Query {
  label: string;
  body: Record<string, unknown>;
  country?: string;
  pages: number;
}

/**
 * The query plan, re-derived from live recon on 2026-07-29 (the v1 plan — two queries, first page
 * only, sorted cheapest-first — returned 31 offers with a 151-11 890 Kč/os band, i.e. structurally
 * the bottom of Invia's whole catalogue and nothing else):
 *
 *   1. One country-agnostic last-minute query (departures within 14 days), 2 pages.
 *   2. One query per verified country in COUNTRY_QUERIES, 1-2 pages each.
 *
 * The last-minute query runs FIRST on purpose: it is the only one feeding a profile with
 * notify_new_offers, so if DEADLINE_MS or MAX_REQUESTS ever truncates the run, what gets dropped is
 * the tail of the country list, not the notification-driving query.
 *
 * Three deliberate choices, each measured:
 *   - NO `sort` param. `sort:'c_price'` is ascending and the endpoint ignores `sort_order:'desc'`,
 *     so cheapest-first + no pagination deterministically harvested the cheapest ~15 rows on the
 *     site. Invia's default (relevance) ordering on the same Řecko body returns 9 590-22 390 Kč/os
 *     with 10 of 16 cards carrying a discount badge, versus 3 969-11 890 Kč/os and few discounts —
 *     dropping the sort is free coverage of exactly the packages this board is looking for.
 *   - `nl_length_from/to: 7/14` on the last-minute query too. Its absence, not `s_holiday_target`,
 *     is why that query used to degenerate into 1-night city hotel rooms (11 of 15 rows). With the
 *     length filter it returns 7 372-18 590 Kč/os, 14 of 15 flight packages.
 *   - `d_start_from: today`, matching the site's own landing-page search params, so we never
 *     harvest terms that have already departed.
 *
 * `itemsPerPage` is NOT a lever: the endpoint ignores it in the body and in the offsets string and
 * always returns 15-16 cards. Pagination therefore costs one request per page.
 */
function buildQueries(): Query[] {
  const today = new Date();
  const in14Days = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  const common = {
    nl_occupancy_adults: 2,
    nl_length_from: 7,
    nl_length_to: 14,
    s_holiday_target: 'tours',
    d_start_from: formatCzDate(today),
    base_url: `${BASE_URL}/dovolena/`,
  };

  return [
    {
      label: 'last-minute',
      pages: LAST_MINUTE_PAGES,
      body: { ...common, d_start_to: formatCzDate(in14Days) },
    },
    ...COUNTRY_QUERIES.map((spec) => ({
      label: `country:${spec.name}`,
      country: spec.name,
      pages: spec.pages,
      body: { ...common, nl_country_id: spec.ids },
    })),
  ];
}

function formatCzDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;
  let requestCount = 0;
  let blocked = false;
  const deadline = Date.now() + DEADLINE_MS;

  const queries = buildQueries();

  outer: for (const query of queries) {
    // Page 2+ replays the same body with the previous response's `offsets` cursor. A bare
    // `page: 2` does NOT work — the endpoint returns page 1 again (14/15 rows overlap).
    let offsets: string | undefined;

    for (let page = 1; page <= query.pages; page += 1) {
      if (requestCount >= MAX_REQUESTS) {
        ctx.log(`invia: request cap ${MAX_REQUESTS} reached, stopping`);
        break outer;
      }
      if (Date.now() > deadline) {
        ctx.log(`invia: wall-clock budget ${DEADLINE_MS}ms reached, stopping`);
        break outer;
      }
      if (page > 1 && !offsets) break; // no cursor -> nothing to page with

      const body = offsets ? { ...query.body, offsets } : query.body;
      const token = randomUUID().replace(/-/g, '');
      let json: AjaxBoxesResponse;
      requestCount += 1;
      try {
        json = await ctx.http.json<AjaxBoxesResponse>(AJAX_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
            Cookie: `__Host-csrf-token_${token}=csrf-token`,
          },
          body: JSON.stringify(body),
        });
        // A returned response means the endpoint answered us (not blocked/down) — count it as a
        // success for the "blocked before first success" guard regardless of how many cards parse.
        successCount += 1;
      } catch (err) {
        if (err instanceof SourceBlockedError) {
          // Politeness: the endpoint is a conscious robots deviation (spec §9) — if it starts
          // blocking us, stop immediately rather than hammering it with the rest of the plan.
          // Record the block as lastError so a block BEFORE the first success still trips the
          // rethrow below.
          lastError = err;
          blocked = true;
          ctx.log(`invia: query "${query.label}" p${page} blocked (${err.message}), stopping`);
          break outer;
        }
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`invia: query "${query.label}" p${page} failed (${message}), skipping`);
        // Without this page's response we have no cursor, so skip the rest of this country.
        break;
      }

      const searchProps = json.customData?.searchProps;
      offsets = searchProps?.offsets;

      let offers: NormalizedOffer[];
      try {
        offers = parseInviaBoxes(json, { country: query.country });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`invia: query "${query.label}" p${page} parse failed (${message}), skipping`);
        continue;
      }

      for (const offer of offers) {
        if (seen.has(offer.sourceOfferKey)) continue;
        seen.add(offer.sourceOfferKey);
        all.push(offer);
      }

      if (searchProps?.isNextPageAvailable !== true) break;
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every request failed: this is not "market empty" — rethrow (fischer pattern) so runScan
    // records this source 'failed' rather than degrading to [] (which would flip known offers
    // inactive and mute the health alert). A block on the first request lands here → BLOCKED
    // marker / 24h backoff engages.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`invia: all requests failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(
    `invia: fetched ${all.length} offers in ${requestCount} requests across ${queries.length} queries${blocked ? ' (stopped early: blocked)' : ''}`,
  );
  return all;
}

export const invia: SourceAdapter = {
  name: 'invia',
  fetchOffers,
};
