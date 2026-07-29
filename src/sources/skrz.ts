import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://skrz.cz';

// Coverage model (re-measured live 2026-07-29, Chrome UA, 3s gap — counts below are that day's
// site-reported `totalItems`, i.e. inventory size, NOT what we take):
//
// Every skrz listing page is server-capped at `"dealsListing":{"limit":24,"offset":0}` and the
// server IGNORES ?offset=/?limit=/?perPage=/?page= (all four re-verified 2026-07-29: byte-identical
// page 1, still limit 24 / offset 0). Deeper pages exist only behind a client-side RSC call. So the
// ONLY coverage lever is breadth of listing URLs — as the design spec anticipated (§ source row 9:
// "24 nabídek/URL, offset nefunguje → pokrytí šířkou URL").
//
// Two axes of breadth, both single-facet paths (robots.txt disallows `*,` i.e. combined facets,
// `*/cena:`, `*/vyber:`, `*/platnost:`, `*/pocet-dni:`, `/*?dt=`, `/koupit/` and 4+ path segments —
// none of which we touch; alternate orderings /nejlevnejsi/ + /nejvetsi-slevy/ are disallowed too,
// so we always take the site's default `ord=aktualni-slevy`):
//   1. destinace:<country> — every country slug skrz's own facet enumerates that HAD inventory.
//      Slugs measured empty on 2026-07-29 are omitted, they would burn a request for nothing:
//      kuba 0, keňa 0, srí lanka 0, dominikánská republika 0 (0 under /exoticka-dovolena too),
//      maroko 0, zanzibar 1, tanzanie 1, francie 1. Those are winter/long-haul destinations that
//      may refill — when they do, the /exoticka-dovolena root below is where they surface.
//   2. destinace:<country>:<region> — region facets are a REAL depth lever: a different slice of
//      the same catalogue, not a re-sort of page 1 (…destinace:recko:kreta shares only 2 of its 24
//      deals with …destinace:recko). Regions listed here are the highest-`count` ones inside the
//      countries the watch profiles actually target.
// Domestic/city-break roots are deliberately NOT here: the old '/pobyty' catch-all returned 24
// one- and two-night domestic wellness stays, every one with departureDate null, i.e. zero profile
// matches (audit finding #3) — its slot buys far more as a destination page.
const LISTING_PATHS = [
  // Mixed-country roots: the only place a country without its own slug can still surface.
  '/exoticka-dovolena', // totalItems 305 — Maledivy/Mauricius/Mexiko/Kapverdy/Omán/SAE mix
  '/last-minute', // totalItems 3167 — near-term departures across countries (last-minute profile)

  // Countries — leto-more profile targets (Řecko, Turecko, Egypt, Španělsko, Kypr, Bulharsko,
  // Chorvatsko, Itálie) first, then the rest of the Mediterranean that only last-minute watches.
  '/dovolena-more/destinace:recko', // 655
  '/dovolena-more/destinace:turecko', // 644
  '/dovolena-more/destinace:italie', // 403
  '/dovolena-more/destinace:spanelsko', // 383
  '/dovolena-more/destinace:egypt', // 261
  '/dovolena-more/destinace:bulharsko', // 217
  '/dovolena-more/destinace:chorvatsko', // 180
  '/dovolena-more/destinace:tunisko', // 142
  '/dovolena-more/destinace:portugalsko', // 76
  '/dovolena-more/destinace:malta', // 47
  '/dovolena-more/destinace:kypr', // 27
  '/dovolena-more/destinace:albanie', // 26
  '/dovolena-more/destinace:cerna-hora', // 11
  '/dovolena-more/destinace:slovinsko', // 9

  // Countries — exotika profile targets.
  '/dovolena-more/destinace:maledivy', // 154
  '/dovolena-more/destinace:spojene-arabske-emiraty', // 85
  '/dovolena-more/destinace:mauricius', // 54
  '/dovolena-more/destinace:mexiko', // 37
  '/dovolena-more/destinace:kapverdy', // 35
  '/dovolena-more/destinace:oman', // 15
  '/dovolena-more/destinace:thajsko', // 13

  // Regions — extra 24-deal slices inside the biggest watched countries (count on 2026-07-29).
  '/dovolena-more/destinace:turecko:turecka-riviera', // 467
  '/dovolena-more/destinace:recko:kreta', // 170
  '/dovolena-more/destinace:egypt:hurghada', // 143
  '/dovolena-more/destinace:turecko:egejska-riviera', // 131
  '/dovolena-more/destinace:spanelsko:canarias', // 122
  '/dovolena-more/destinace:italie:emilia-romagna', // 104
  '/dovolena-more/destinace:bulharsko:slunecne-pobrezi', // 97
  '/dovolena-more/destinace:spanelsko:baleary', // 95
  '/dovolena-more/destinace:egypt:marsa-alam', // 88
  '/dovolena-more/destinace:recko:korfu', // 85
  '/dovolena-more/destinace:recko:rhodos', // 79
  '/dovolena-more/destinace:spanelsko:catalunya', // 73
  '/dovolena-more/destinace:italie:benatska-riviera', // 66
  '/dovolena-more/destinace:spojene-arabske-emiraty:dubai', // 57
  '/dovolena-more/destinace:tunisko:djerba', // 55
  '/dovolena-more/destinace:chorvatsko:istria', // 54
  '/dovolena-more/destinace:recko:zakynthos', // 51
];

// Hard request budget. src/core/run.ts aborts an adapter whose fetchOffers exceeds
// ADAPTER_FETCH_TIMEOUT_MS = 240 s, and an aborted adapter is recorded 'failed' — the whole source
// then vanishes from the board, which is strictly worse than partial coverage. HttpClient serializes
// same-host requests with a 3 s gap, and a skrz listing page costs ~1 s to fetch+parse, so the wall
// clock is ≈ 3.9 s × requests: the full 40-URL list measured 154 s live, ~36 % under the timeout.
// fetchOffers slices LISTING_PATHS to this cap so a future edit to the list above cannot silently
// blow the timeout — the cap, not the list length, is what the scan's safety depends on.
const MAX_LISTING_URLS = 40;
// …and a wall-clock stop, because the URL cap only bounds request COUNT: a slow/hung skrz would
// still overrun (HttpClient allows 25 s per request × 3 attempts). Enforced in TWO places, and it
// needs both: the loop refuses to START a request past the deadline, AND each request carries an
// AbortSignal for the remaining budget. Without the signal the deadline bounds only start times —
// one hung URL begun at 194 s returns at ~275 s and run.ts aborts the adapter at 240 s, which is
// the 'failed' outcome this budget exists to prevent. With both, the loop returns by ~198 s
// (deadline + HttpClient's 2.5 s of retry backoff on the aborted request), leaving ≥ 40 s spare
// so the partial result is written instead of the run being aborted.
const FETCH_BUDGET_MS = 195_000;

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

// skrz's breadcrumbs label Czechia "Česko", which is NOT a key in normalize.ts's COUNTRY_BY_KEY
// (the canonical entry is "Česká republika"), so normalizeCountry would fall through to its raw
// passthrough. Consequences: a profile written as `countries: ["Česká republika"]` would silently
// never match a skrz domestic offer, and computeMatchKey/computeHotelKey would not align skrz's
// "Česko" with the same hotel coming from another source. Rewritten here rather than in
// normalize.ts because that file is shared by every adapter and this spelling is skrz's.
const COUNTRY_LABEL_ALIASES: Record<string, string> = {
  Česko: 'Česká republika',
};

function canonicalCountryLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return COUNTRY_LABEL_ALIASES[trimmed] ?? trimmed;
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
  const country = normalizeCountry(canonicalCountryLabel(links[0]?.title ?? null));
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
  let lastError: unknown;
  let successCount = 0;
  let fetched = 0;

  const deadline = Date.now() + FETCH_BUDGET_MS;
  const paths = LISTING_PATHS.slice(0, MAX_LISTING_URLS);

  for (const path of paths) {
    // Second half of the budget guard: the URL cap assumes ~3.9 s/request, but a hung host (25 s
    // request timeout + two retries) can cost 20× that on a single URL. Stop issuing requests once
    // the wall-clock budget is spent and return what we have — a partial source beats an aborted
    // one, which runScan records 'failed' and drops from the board entirely. LISTING_PATHS is
    // ordered value-first (mixed roots, then countries, then regions), so a trim loses the least.
    if (Date.now() >= deadline) {
      ctx.log(`skrz: request budget spent after ${fetched}/${paths.length} listing URLs, stopping`);
      break;
    }
    const url = `${BASE_URL}${path}`;
    fetched += 1;
    let offers: NormalizedOffer[];
    // The pre-request deadline check alone does NOT bound the wall clock, it only bounds when a
    // request may START. HttpClient spends up to 3 s host gap + 25 s × 3 attempts + 2.5 s backoff
    // ≈ 80 s on a single hung URL, so a request begun at 194 s would return at ~275 s — past
    // run.ts's 240 s abort, i.e. exactly the 'failed' outcome this budget exists to prevent (and
    // reachable whenever the runner is slow enough that 39 URLs cost ~5 s each). Cap each request
    // at the budget that is actually left, so the loop can never run past the deadline.
    const budgetAbort = new AbortController();
    const budgetTimer = setTimeout(() => budgetAbort.abort(), Math.max(1, deadline - Date.now()));
    budgetTimer.unref?.();
    try {
      const html = await ctx.http.text(url, { signal: budgetAbort.signal });
      offers = parseSkrz(html);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // The site is actively blocking us: stop working through the remaining listing URLs
        // (politeness) but keep whatever offers earlier pages already yielded. Record the block as
        // lastError so a block BEFORE the first success still trips the successCount===0 rethrow.
        lastError = err;
        ctx.log(`skrz: ${path} blocked (${err.message}), stopping`);
        break;
      }
      // Any other per-page failure (network error, parse error, transient 5xx exhausted) should
      // not sink the whole fetch — log and move on to the next listing URL.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`skrz: ${path} failed (${message}), skipping`);
      continue;
    } finally {
      clearTimeout(budgetTimer);
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every listing URL failed: this is not "market empty" — rethrow (fischer pattern) so runScan
    // records this source 'failed' rather than degrading to [] (which would flip known offers
    // inactive and mute the health alert). A block on the first URL lands here → BLOCKED / backoff.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`skrz: all ${fetched} attempted listing URLs failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`skrz: fetched ${all.length} offers across ${successCount}/${fetched} listing URLs`);
  return all;
}

export const skrz: SourceAdapter = {
  name: 'skrz',
  fetchOffers,
};
