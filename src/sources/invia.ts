import * as cheerio from 'cheerio';
import { randomUUID } from 'node:crypto';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { normalizeCountry, offerKeyHash, parseCzk } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.invia.cz';
const AJAX_URL = `${BASE_URL}/search-results/ajax-boxes`;

/**
 * Verified country ids (recon-confirmed against the live ajax-boxes endpoint): only Řecko
 * (28) has been captured and checked end-to-end against a fixture. We deliberately do NOT
 * guess ids for Turecko/Egypt etc. — shipping an unverified id risks silently querying the
 * wrong country. See "queries" below for how this dict is used.
 */
const VERIFIED_COUNTRY_IDS: Record<number, string> = {
  28: 'Řecko',
};

/**
 * mealId -> Board, built from every distinct mealId observed across both captured fixtures
 * (ajax-boxes.json: 4, 5, 6; ajax-boxes-lastminute.json: same range). Falls back to
 * 'unknown' for any id not seen during recon rather than guessing.
 */
const MEAL_ID_TO_BOARD: Record<number, Board> = {
  4: 'none', // self_catering
  5: 'AI', // all_inclusive
  6: 'BB', // breakfast
};

/** transportationId -> Transport, from the same fixtures (3=airplane, 4=self_arranged, 2=bus). */
const TRANSPORT_ID_TO_TRANSPORT: Record<number, Transport> = {
  2: 'bus',
  3: 'flight',
  4: 'own',
};

interface OfferJwtPayload {
  hotelId?: number;
  termId?: string;
  tourOperatorId?: number;
  checkInDate?: string; // YYYYMMDD
  checkOutDate?: string; // YYYYMMDD
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
  item_parameter_3?: string; // departure airport IATA code
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
 * Parses one page of Invia's `customData.boxes` server-rendered HTML fragment (as returned
 * by `POST /search-results/ajax-boxes`) into NormalizedOffer[].
 *
 * Country resolution priority (per spec §3 row 1 lesson: country must be a real country,
 * never a city/resort):
 *   1. `opts.country` — the authoritative country we asked for in the search query (e.g.
 *      "Řecko" when we queried nl_country_id=[28]). Always used when provided, since we know
 *      exactly which country we searched.
 *   2. GA4 `item_category_local` (a Czech country slug, e.g. "italie", "madarsko") ONLY if
 *      normalizeCountry recognizes it as a real country — used for the country-agnostic
 *      last-minute query where we don't have a single authoritative country.
 *   3. null — never fall back to locality/resort text as country.
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

  const priceRaw = card.find('[data-testid="price"]').first().parent().text();
  const pricePerPerson = parseCzk(priceRaw);
  if (pricePerPerson === null) return null;

  const locationText = card.find('.b-product-list-2__location').first().text().trim();
  const locationParts = locationText.split('-').map((s) => s.trim()).filter(Boolean);
  const locality = locationParts.length > 1 ? locationParts[locationParts.length - 1]! : null;

  const country =
    queryCountry ?? (ga4?.item_category_local ? resolveCountryFromSlug(ga4.item_category_local) : null);

  const departureDate = yyyymmddToIso(payload.checkInDate);
  const nights =
    daysBetween(payload.checkInDate, payload.checkOutDate) ?? (payload.daysCount ? payload.daysCount - 1 : null);

  const board: Board = typeof payload.mealId === 'number' ? MEAL_ID_TO_BOARD[payload.mealId] ?? 'unknown' : 'unknown';
  const transport: Transport =
    typeof payload.transportationId === 'number' ? TRANSPORT_ID_TO_TRANSPORT[payload.transportationId] ?? 'unknown' : 'unknown';

  const departureAirport = ga4?.item_parameter_3?.trim() || null;
  const tourOperator = ga4?.item_brand?.trim() || null;

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

  const sourceOfferKey = offerKeyHash([payload.hotelId ?? title, payload.termId ?? null, departureDate, nights]);

  return {
    source: 'invia',
    sourceOfferKey,
    title,
    country,
    locality,
    stars: null,
    board,
    transport,
    departureAirport,
    departureDate,
    nights,
    pricePerPerson,
    priceTotal: null,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator,
    url,
  };
}

function resolveCountryFromSlug(slug: string): string | null {
  return normalizeCountry(slug.replace(/_/g, ' '));
}

interface AjaxBoxesResponse {
  customData: { boxes: string };
}

/**
 * v1 ships exactly 2 queries, first page only (no pagination), to keep the ajax-boxes
 * deviation (spec §9) minimal:
 *   1. "léto-moře" query restricted to nl_country_id we have VERIFIED (currently only Řecko
 *      28 — see VERIFIED_COUNTRY_IDS). Adding more countries requires confirming their ids
 *      against a live response first; we do not guess.
 *   2. "last-minute" query with no country filter (sort=c_price, d_start_from=today,
 *      d_start_to=+14 days), so country is resolved per-card from GA4 item_category_local.
 */
function buildQueries(): Array<{ label: string; body: Record<string, unknown>; country?: string }> {
  const queries: Array<{ label: string; body: Record<string, unknown>; country?: string }> = [];

  for (const [idStr, countryName] of Object.entries(VERIFIED_COUNTRY_IDS)) {
    queries.push({
      label: `leto-more:${countryName}`,
      country: countryName,
      body: {
        nl_country_id: [Number(idStr)],
        nl_occupancy_adults: 2,
        sort: 'c_price',
        nl_length_from: 7,
        nl_length_to: 14,
        s_holiday_target: 'tours',
        base_url: `${BASE_URL}/dovolena/`,
      },
    });
  }

  const today = new Date();
  const in14Days = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  queries.push({
    label: 'last-minute',
    body: {
      sort: 'c_price',
      d_start_from: formatCzDate(today),
      d_start_to: formatCzDate(in14Days),
      nl_occupancy_adults: 2,
      s_holiday_target: 'tours',
      base_url: `${BASE_URL}/dovolena/`,
    },
  });

  return queries;
}

function formatCzDate(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();

  for (const query of buildQueries()) {
    const token = randomUUID().replace(/-/g, '');
    let json: AjaxBoxesResponse;
    try {
      json = await ctx.http.json<AjaxBoxesResponse>(AJAX_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          Cookie: `__Host-csrf-token_${token}=csrf-token`,
        },
        body: JSON.stringify(query.body),
      });
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Politeness: the endpoint is a conscious robots deviation (spec §9) — if it starts
        // blocking us, stop immediately rather than hammering it with a second query.
        ctx.log(`invia: query "${query.label}" blocked (${err.message}), stopping`);
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`invia: query "${query.label}" failed (${message}), skipping`);
      continue;
    }

    let offers: NormalizedOffer[];
    try {
      offers = parseInviaBoxes(json, { country: query.country });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`invia: query "${query.label}" parse failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  ctx.log(`invia: fetched ${all.length} offers across ${buildQueries().length} queries`);
  return all;
}

export const invia: SourceAdapter = {
  name: 'invia',
  fetchOffers,
};
