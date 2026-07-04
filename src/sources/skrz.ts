import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://skrz.cz';

const LISTING_PATHS = [
  '/dovolena-more/destinace:recko',
  '/dovolena-more/destinace:turecko',
  '/dovolena-more/destinace:egypt',
  '/dovolena-more/destinace:bulharsko',
  '/pobyty/destinace:chorvatsko',
  '/pobyty',
];

const NEXT_F_PUSH_RE = /self\.__next_f\.push\(\[1,(".*?")\]\)/gs;
const LD_JSON_RE = /<script type="application\/ld\+json">(.*?)<\/script>/gs;

interface RawBreadcrumbLink {
  title?: string;
}

interface RawDeal {
  id?: number;
  hash?: string;
  title?: string;
  serverTitle?: string;
  priceFinal?: number;
  discountInPercent?: number | null;
  detailUrl?: string;
  breadcrumbs?: { links?: RawBreadcrumbLink[] };
  board?: string;
  days?: number;
  nights?: number;
  persons?: number;
  transport?: string;
  deptPlace?: { title?: string } | null;
  merchant?: { title?: string; stars?: number | null } | null;
}

/**
 * Skrz's listing pages are Next.js App Router pages: the deal data isn't in the static HTML
 * DOM at all, it's embedded as a serialized React Server Components ("flight") payload inside
 * a series of `self.__next_f.push([1, "<chunk>"])` calls. Each chunk's second array element is
 * itself a JS string literal (double-escaped: quotes inside it are `\"`, etc.), and the actual
 * `deals` array is often split across multiple chunks. The robust extraction is therefore:
 *   1. Collect every `push([1, "..."])` chunk's raw string literal.
 *   2. Unescape each one via `JSON.parse` (treating the chunk itself as a JSON string), then
 *      concatenate all of them back into one big text blob in document order.
 *   3. Find `"deals":[` in that blob and extract the array with a string-aware balanced-bracket
 *      scan (can't just regex to the next `]` because deal objects nest arrays/objects
 *      internally, and a lone `[`/`]` inside a deal title's free-text marketing copy must not
 *      affect bracket depth or the slice truncates and the whole array fails to parse).
 *   4. `JSON.parse` the extracted array text.
 *
 * Falls back to per-deal `<script type="application/ld+json">` Product blocks when no `deals`
 * array is found (e.g. markup changes) — that fallback recovers far fewer fields (no
 * breadcrumbs/board/transport/persons/merchant), but keeps title/price/url alive.
 */
export function parseSkrz(html: string): NormalizedOffer[] {
  const deals = extractDeals(html);
  const source: RawDeal[] = deals.length > 0 ? deals : extractDealsFromLdJson(html);

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const deal of source) {
    const offer = mapDeal(deal);
    if (!offer) continue;
    if (seen.has(offer.sourceOfferKey)) continue;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  }

  return offers;
}

function extractDeals(html: string): RawDeal[] {
  let combined = '';
  for (const match of html.matchAll(NEXT_F_PUSH_RE)) {
    const literal = match[1];
    if (!literal) continue;
    try {
      combined += JSON.parse(literal) as string;
    } catch {
      // Malformed/truncated chunk: skip it, the rest of the blob may still parse.
    }
  }

  const dealsIdx = combined.indexOf('"deals":[');
  if (dealsIdx < 0) return [];

  const arrayStart = combined.indexOf('[', dealsIdx);
  if (arrayStart < 0) return [];

  // String-aware scan: `[`/`]` inside a JSON string (e.g. a deal title containing free-text
  // marketing copy like "Last chance ]:) don't miss it") must NOT affect bracket depth, or the
  // slice truncates mid-array, JSON.parse fails, and every deal on the page is silently dropped.
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = arrayStart; i < combined.length; i += 1) {
    const ch = combined[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return [];

  try {
    const parsed = JSON.parse(combined.slice(arrayStart, end));
    return Array.isArray(parsed) ? (parsed as RawDeal[]) : [];
  } catch {
    return [];
  }
}

interface RawLdProduct {
  name?: string;
  url?: string;
  offers?: { price?: string };
}

function extractDealsFromLdJson(html: string): RawDeal[] {
  const out: RawDeal[] = [];
  for (const match of html.matchAll(LD_JSON_RE)) {
    const raw = match[1];
    if (!raw) continue;
    let parsed: RawLdProduct;
    try {
      parsed = JSON.parse(raw) as RawLdProduct;
    } catch {
      continue;
    }
    if (!parsed.name || !parsed.url || !parsed.offers?.price) continue;
    const price = Number(parsed.offers.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    // ld+json only exposes the /koupit/ purchase URL, not the /zajezd|voucher|nabidka detail
    // URL — reuse it as detailUrl since we never fetch it, only read the `?dt=` param from it.
    // Decision: robots.txt Disallow governs crawling; we never FETCH /koupit/ — storing it as
    // the user-facing purchase link is intentional (it is the only link ld+json provides).
    out.push({
      title: parsed.name,
      priceFinal: price,
      detailUrl: parsed.url,
      persons: 1,
    });
  }
  return out;
}

function mapDeal(deal: RawDeal): NormalizedOffer | null {
  const relativeDetailUrl = deal.detailUrl;
  if (!relativeDetailUrl) return null;

  const title = (deal.merchant?.title || deal.title || '').trim();
  if (!title) return null;

  const priceFinal = deal.priceFinal;
  if (typeof priceFinal !== 'number' || !Number.isFinite(priceFinal) || priceFinal <= 0) return null;

  const url = new URL(relativeDetailUrl, BASE_URL).toString();

  const persons = typeof deal.persons === 'number' && deal.persons >= 1 ? deal.persons : null;
  const pricePerPerson = persons !== null ? Math.round(priceFinal / persons) : Math.round(priceFinal);

  const pct = deal.discountInPercent;
  const claimedDiscountPct = typeof pct === 'number' && pct > 0 && pct < 100 ? pct : null;
  const claimedOriginalPrice =
    claimedDiscountPct !== null ? Math.round(pricePerPerson / (1 - claimedDiscountPct / 100)) : null;

  const links = deal.breadcrumbs?.links ?? [];
  const country = normalizeCountry(links[0]?.title ?? null);
  const locality = links[links.length - 1]?.title && links.length > 1 ? links[links.length - 1]!.title!.trim() : null;

  // Skrz encodes board/transport as hyphenated slugs (e.g. "all-inclusive", "bez-stravy",
  // "vlastni-doprava"); normalizeBoard/normalizeTransport match on space-separated Czech
  // phrases, so swap hyphens for spaces before delegating to the shared normalizers.
  const board = normalizeBoard(deal.board?.replace(/-/g, ' ') ?? null);
  const transport = normalizeTransport(deal.transport?.replace(/-/g, ' ') ?? null);
  const departureAirport = deal.deptPlace?.title?.trim() || null;
  const nights = typeof deal.nights === 'number' ? deal.nights : null;
  const stars = typeof deal.merchant?.stars === 'number' ? deal.merchant.stars : null;
  const tourOperator = deal.serverTitle?.trim() || null;

  const dtMatch = relativeDetailUrl.match(/[?&]dt=(\d{4}-\d{2}-\d{2})/);
  const departureDate = dtMatch?.[1] ?? null;

  const sourceOfferKey = offerKeyHash([deal.hash ?? deal.id ?? title, departureDate, nights]);

  return {
    source: 'skrz',
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
    priceTotal: null,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator,
    url,
  };
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();

  for (const path of LISTING_PATHS) {
    const url = `${BASE_URL}${path}`;
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(url);
      offers = parseSkrz(html);
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // The site is actively blocking us: stop working through the remaining listing URLs
        // (politeness) but keep whatever offers earlier pages already yielded.
        ctx.log(`skrz: ${path} blocked (${err.message}), stopping`);
        break;
      }
      // Any other per-page failure (network error, parse error, transient 5xx exhausted) should
      // not sink the whole fetch — log and move on to the next listing URL.
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`skrz: ${path} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  ctx.log(`skrz: fetched ${all.length} offers across ${LISTING_PATHS.length} listing URLs`);
  return all;
}

export const skrz: SourceAdapter = {
  name: 'skrz',
  fetchOffers,
};
