import * as cheerio from 'cheerio';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, parseCzk, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.eximtours.cz';

// ---------------------------------------------------------------------------
// Request budget. src/core/run.ts aborts any adapter whose fetchOffers exceeds
// ADAPTER_FETCH_TIMEOUT_MS (240 s) — and an aborted adapter is recorded 'failed', which drops the
// whole source from the board, strictly worse than partial coverage. HttpClient serializes per host
// with a 3 s gap, so every request costs ~3.5-4 s wall clock. These four constants bound a run at
// 1 + MAX_SEARCH_REQUESTS requests (~2 min measured) no matter how the site's seed list changes.
// ---------------------------------------------------------------------------

// `pITG` = page size, `pSTG` = rows to skip (both read off the site's own results-page JS).
// Measured live 2026-07-29 against the Řecko seed: pITG=40 returns 40 parsed cards in ONE request,
// pITG=50 / 60 / 100 return an HTML error page (34 kB, zero `divHotelCard`) instead of the JSON
// envelope. 40 is therefore the hard server-side ceiling and doubles coverage for free — the
// `paging` object the endpoint echoes back still claims PageSize 20, so trust the measurement, not
// the echo.
export const PAGE_SIZE = 40;
// Live seed list is 20 destinations (2026-07-29). The cap only exists so a site change that
// suddenly lists 200 locations cannot silently explode the request count.
const MAX_DESTINATIONS = 24;
// Hard ceiling on /searchresult/getsearch calls per run (the /last-minute seed GET is one more).
// 26 x ~4 s = ~105 s, comfortably inside the 240 s adapter timeout.
export const MAX_SEARCH_REQUESTS = 26;
// Depth cap per destination: Řecko (Count 1355) and Španělsko (1487) would otherwise eat the whole
// spare budget between them. Breadth beats depth — every destination gets its first PAGE_SIZE rows
// before anything gets a second page.
const MAX_ROWS_PER_DESTINATION = 120;

// Ordering hint, NOT a filter: every live seed is queried (see fetchOffers). These are the
// destinations config/watch.yaml's enabled profiles name explicitly (leto-more + exotika), so if a
// future seed list ever outgrows MAX_DESTINATIONS / MAX_SEARCH_REQUESTS the profiles we actually
// watch are the ones that survive the truncation. Names must match the site's own
// GroupSearch2 `locations[].name` labels exactly (that is where the strings come from).
const PREFERRED_DESTINATIONS = new Set([
  'Řecko',
  'Španělsko',
  'Egypt',
  'Spojené arabské emiráty',
  'Thajsko',
  'Maledivy',
  'Dominikánská republika',
  'Mauricius',
  'Mexiko',
  'Kapverdské ostrovy',
  'Zanzibar',
  'Srí Lanka',
  'Seychely',
  'Keňa',
]);

// The site's own country label vs. normalize.ts's canonical country set. Every Cape Verde card is
// labelled 'Kapverdské ostrovy', but COUNTRY_BY_KEY only knows the bare 'Kapverdy', so the
// isKnownCountry guard used to null the country on 17/17 Kapverdy offers — and a null country is
// silently excluded from the `exotika` profile (which names Kapverdy), from computeMatchKey and
// from the hotel reference rung of discount v2. Keys are lowercased raw labels.
// Still null after this map, and deliberately so: 'Malajsie' and 'Velká Británie' (15 offers on
// 2026-07-29) are genuinely absent from normalize.ts's COUNTRY_BY_KEY, and inventing a
// non-canonical country here would break the country-or-null contract. No enabled watch profile
// names either country, and `last-minute` (countries: []) accepts a null country anyway, so they
// still reach the board — fixing them belongs in normalize.ts, not here.
const COUNTRY_LABEL_ALIASES = new Map<string, string>([['kapverdské ostrovy', 'Kapverdy']]);

/**
 * Exim tours runs on the DER Touristik/Kentico platform (like eTravel/Fischer, see der.ts), but
 * its listing endpoint is fundamentally different from both: `/searchresult/getsearch` returns a
 * JSON envelope whose `HTML` field is fully server-rendered offer cards (`#divHotelCard`), not a
 * structured `tours[]`/`hotels[]` array. That HTML payload is uniquely valuable for this project
 * because it exposes the CROSSED-OUT ORIGINAL PRICE (`js-roomPrice-originalPrice`) plus an
 * explicit discount amount (`js-totalDiscount--amount`), which most other sources lack. Nothing
 * from der.ts's `DerTour`/`mapDerTours` fits here — that assumes a JSON tour/hotel shape, not an
 * HTML-in-JSON payload — so this adapter parses the HTML with cheerio directly.
 *
 * Seeds: GET `/last-minute` embeds a `GroupSearch2` widget with a `groupSearchResult.locations[]`
 * JSON array (confirmed live, tests/fixtures/eximtours/last-minute.html): each entry has
 * `{ id, name, adultPriceFrom: { amount }, searchUrl }`. `searchUrl` targets the SSR results page
 * `/vysledky-vyhledavani?...` (NOT `/searchresult/getsearch` directly) but carries the exact same
 * querystring (`ds`/`tt`/`d`/`dd`/`rd`/`er`/`isss`/`nn`/`ac1`/`kc1`/`ic1`) that `getsearch` expects,
 * so `fetchOffers` just re-targets that querystring at `/searchresult/getsearch`.
 *
 * WHAT IS QUERIED AND WHY (rewritten 2026-07-29 after the coverage audit): every seed the site
 * itself publishes is queried — there is no hardcoded destination allow-list any more. The old
 * 12-name list resolved to only 10 of the 20 live seeds and wasted two entries ('Turecko', 'Kuba')
 * that no longer exist in last-minute stock, so >50% of the source's inventory (including
 * Španělsko, its LARGEST destination at Count 1487 and a country `leto-more` names explicitly, plus
 * the exotika-named Srí Lanka / Seychely / Keňa) was never fetched. Each destination is read with
 * `&pSTG=<skip>&pITG=40`, then any leftover request budget goes to the next 40 rows of the largest
 * destinations, round-robin (see the budget constants above). The 40-row first page matters beyond
 * raw volume: rows 0-19 are the site's "Recommendation-Ascending" regional spread (verified
 * unsorted: 15990, 35390, 25250, 22990, …, spanning 13690-41990) while rows 20+ are the
 * price-ascending CHEAP tail (Řecko rows 20-39 climb 13190 → 16190, so the whole second half of
 * the page sits at or below page 1's THIRD-cheapest card and its floor undercuts page 1's). One
 * request per destination now returns both the spread and the bargain tail this discount board
 * exists for. Measured live 2026-07-29, whole run: 833 offers from 27 requests in 90 s wall clock
 * (was 197 offers from 11 requests), 11 490 - 119 440 Kč/person (was 12 790 - 84 910), 442 offers
 * carrying a claimed discount (was 130), 19 countries (was 9 + 17 nulls).
 *
 * Card parsing (from tests/fixtures/eximtours/getsearch.json's `HTML` field), confirmed live:
 * - Card root: `#divHotelCard` (cheerio/css-select returns every match even though the id repeats
 *   per page — unlike a real DOM's getElementById, this is safe and intentional here).
 * - Hotel name + detail URL: the SECOND `<a>` in the card (index 1; index 0 is a "Zobrazit na
 *   mapě" map-anchor with `href="#"`). Detail hrefs are root-relative with a full query string.
 * - Country/resort/locality: the 3rd/4th/5th `<a>` tags (indices 2-4), e.g. "Egypt" / "Hurghada" /
 *   "Hurghada" or "Řecko" / "Thassos a Kavala" / "Skala Rachoni". Index 2 = country (canonicalized
 *   via normalizeCountry + isKnownCountry guard per the binding country-or-null lesson, after the
 *   COUNTRY_LABEL_ALIASES rewrite above), index 4 = locality (used as-is, raw).
 * - Every card also carries the site's own structured analytics payload in a `data-gtm-impression`
 *   attribute (`dimension2` = country, `dimension15` = board, `dimension14` = "Flight-<city>").
 *   It is used as the PRIMARY board source because the free-text fallback below is positional
 *   (leftmost match wins) and therefore fragile; presence verified on 72/72 live cards across four
 *   destinations (Thajsko, Kapverdy, Velká Británie, Malajsie) plus 20/20 cards of the committed
 *   Egypt fixture, with zero disagreements against the text regex. departureAirport stays null despite `dimension14` being available and genuinely
 *   varied (Praha/Brno/Pardubice/Budapest/Wroclaw/Kolín): 11 of 13 sibling adapters hardcode null,
 *   and computeMatchKey buckets a null airport under '*', so populating it HERE ONLY would move
 *   these offers into a BRQ/PRG bucket that no other source writes into and lose cross-source
 *   merges. That is a project-wide decision, not an eximtours one.
 * - Dates: unlike Cedok, BOTH the start and end date carry a full 4-digit year in this source
 *   (e.g. "09.07.2026 - 16.07.2026"), confirmed across 40 sampled cards (Egypt + Řecko fixtures)
 *   — no cross-year inference is needed, the start date is parsed directly.
 * - Prices: `.js-roomPrice-adult0` -> pricePerPerson, `.js-roomPrice-total` -> priceTotal,
 *   `.js-roomPrice-originalPrice` -> the crossed-out original, `.js-totalDiscount--amount` (text
 *   like "- 23 920 Kč") -> absolute discount. `parseCzk` handles the NBSP/regular-space thousands
 *   separators uniformly.
 *   IMPORTANT empirical finding: originalPrice and the discount amount are TOTAL-based (for all
 *   travellers combined), NOT per-person — verified against every one of the 40 sampled cards
 *   across both fixtures with zero mismatches: `originalPrice - discount === total` exactly every
 *   time (e.g. 51100 - 23920 = 27180 = 2 * adult0's 13590). This mirrors eTravel/Fischer's DER
 *   platform convention (see der.ts's computeClaimedPrice comment) even though Exim's own
 *   per-adult breakdown (`adult0`/`adult1`) is visible in the same card. Unlike der.ts (which
 *   never sees a raw total-based original price and must reconstruct one from adultPrice +
 *   discountPerPerson), Exim exposes the TOTAL original price directly, so it's converted to
 *   per-person to stay consistent with every sibling adapter's `claimedOriginalPrice` contract:
 *   `adults = Math.max(1, Math.round(priceTotal / pricePerPerson))` (same derivation as der.ts's
 *   computeClaimedPrice), then `claimedOriginalPrice = Math.round(originalPrice / adults)` (e.g.
 *   51100 / 2 = 25550 for the fixture's first card, alongside adult0's 13590 per-person price).
 *   claimedDiscountPct = round(discount / originalPrice * 100) stays ratio-based (unaffected by
 *   the per-person conversion), guarded to (0, 100) exclusive; guard also requires
 *   originalPrice > total and both priceTotal/pricePerPerson > 0 (needed to derive `adults`),
 *   else both claimed fields are null.
 * - Stars: `.js-stars` text is a run of literal `*` characters (e.g. "*****"); its length is the
 *   star count. Board: `data-gtm-impression`'s `dimension15`, falling back to a free-text search of
 *   the card for the known Czech/English board strings. The fallback pattern deliberately ends in
 *   `Bez strav\w*` rather than the literal `Bez stravování`: the DS=2 (dynamic-packaging /
 *   Hotelbeds) cards spell room-only as "bez stravy", which the old pattern missed — 18/40 Thajsko
 *   and 12/14 Velká Británie cards — leaving board 'unknown', which in turn makes computeMatchKey
 *   return null and drops the offer out of cross-source matching entirely.
 * - No explicit transport marker on the card; `/last-minute`'s seeds are all fly-package
 *   destinations (matching der.ts's TT=1 flight-tour-type convention), so transport is hardcoded
 *   to 'flight' per the task brief, same reasoning as fischer.ts.
 */
interface EximSeed {
  name: string;
  searchUrl: string;
}

interface EximSearchResponse {
  HTML: string;
  // Echoed back by /searchresult/getsearch. `Count` is the true size of the result set and is what
  // the paging loop budgets against; `PageSize` lies (always 20, even for a 40-row pITG) and is
  // deliberately ignored.
  paging?: { Count?: number } | null;
}

/**
 * Parses the `/last-minute` page's `GroupSearch2` widget for its `groupSearchResult.locations[]`
 * seed list. Pure function: no I/O. Returns an empty array (not a throw) if the widget/array is
 * missing or malformed, so callers can decide how to react.
 */
export function parseEximSeeds(html: string): EximSeed[] {
  const marker = '"locations":[';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];

  const start = idx + marker.length - 1; // position of the opening '['
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return [];

  let locations: unknown;
  try {
    locations = JSON.parse(html.slice(start, end));
  } catch {
    return [];
  }
  if (!Array.isArray(locations)) return [];

  const seeds: EximSeed[] = [];
  for (const loc of locations as Array<{ name?: string; searchUrl?: string }>) {
    if (typeof loc?.name === 'string' && typeof loc?.searchUrl === 'string') {
      seeds.push({ name: loc.name, searchUrl: loc.searchUrl });
    }
  }
  return seeds;
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Builds a `/searchresult/getsearch` URL for one page of one destination. Exported for tests:
 * the paging params are the entire coverage fix, so they are worth asserting on directly.
 */
export function buildSearchUrl(searchUrl: string, skip: number): string {
  const query = searchUrl.split('?')[1] ?? '';
  return `${BASE_URL}/searchresult/getsearch?${query}&pSTG=${skip}&pITG=${PAGE_SIZE}`;
}

/**
 * Maps the `HTML` field of a `/searchresult/getsearch` response to NormalizedOffer[] by parsing
 * every `#divHotelCard` node with cheerio. Pure function: no I/O. Dedupes by `sourceOfferKey`,
 * keeping the first occurrence.
 */
export function parseEximSearch(json: EximSearchResponse): NormalizedOffer[] {
  const $ = cheerio.load(json.HTML ?? '');
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  $('#divHotelCard').each((_, el) => {
    const offer = parseCard($, $(el));
    if (!offer) return;
    if (seen.has(offer.sourceOfferKey)) return;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  });

  return offers;
}

// Free-text board fallback. `Bez strav\w*` (not the literal 'Bez stravování') so the DS=2
// dynamic-packaging cards' "bez stravy" is caught too — see the module doc comment.
const BOARD_TEXT_RE = /All inclusive|Polopenze|Plná penze|Snídaně|Bez strav\w*/i;

/** The site's own analytics payload for a card, or null if the attribute is missing/malformed. */
function parseGtmImpression(card: ReturnType<cheerio.CheerioAPI>): Record<string, unknown> | null {
  const raw = card.find('[data-gtm-impression]').first().attr('data-gtm-impression');
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractBoard(cardText: string, gtm: Record<string, unknown> | null): Board {
  const structured = typeof gtm?.dimension15 === 'string' ? gtm.dimension15 : null;
  const fromGtm = normalizeBoard(structured);
  // Only fall through when the structured label is missing or unrecognized, so a future
  // board wording the site invents still has the text pattern as a second chance.
  if (fromGtm !== 'unknown') return fromGtm;
  return normalizeBoard(cardText.match(BOARD_TEXT_RE)?.[0] ?? null);
}

function parseCard($: cheerio.CheerioAPI, card: ReturnType<cheerio.CheerioAPI>): NormalizedOffer | null {
  const links = card.find('a');
  const nameLink = links.eq(1);
  const title = nameLink.text().trim();
  const href = nameLink.attr('href');
  if (!title || !href) return null;
  const url = new URL(href, BASE_URL).toString();

  const gtm = parseGtmImpression(card);

  const breadcrumbCountry = links.eq(2).text().trim();
  const gtmCountry = typeof gtm?.dimension2 === 'string' ? gtm.dimension2.trim() : '';
  const countryRaw = breadcrumbCountry || gtmCountry || null;
  const countryLabel = countryRaw === null ? null : (COUNTRY_LABEL_ALIASES.get(countryRaw.toLowerCase()) ?? countryRaw);
  const locality = links.eq(4).text().trim() || null;
  const country = isKnownCountry(countryLabel) ? normalizeCountry(countryLabel) : null;

  const pricePerPerson = parseCzk(card.find('.js-roomPrice-adult0').first().text());
  if (pricePerPerson === null) return null;

  const priceTotal = parseCzk(card.find('.js-roomPrice-total').first().text());
  const originalPrice = parseCzk(card.find('.js-roomPrice-originalPrice').first().text());
  const discount = parseCzk(card.find('.js-totalDiscount--amount').first().text());

  // Empirical finding (see module doc comment): originalPrice/discount are TOTAL-based, not
  // per-person, so originalPrice is converted to per-person (mirroring der.ts's
  // computeClaimedPrice) to stay consistent with every sibling adapter's claimedOriginalPrice
  // contract. Guard requires a real positive originalPrice/discount/priceTotal/pricePerPerson and
  // originalPrice strictly greater than the total, else both claimed fields fall back to null
  // rather than guessing.
  let claimedOriginalPrice: number | null = null;
  let claimedDiscountPct: number | null = null;
  if (
    originalPrice !== null &&
    discount !== null &&
    priceTotal !== null &&
    priceTotal > 0 &&
    pricePerPerson > 0 &&
    originalPrice > priceTotal
  ) {
    const pct = round((discount / originalPrice) * 100);
    if (pct > 0 && pct < 100) {
      const adults = Math.max(1, round(priceTotal / pricePerPerson));
      claimedOriginalPrice = round(originalPrice / adults);
      claimedDiscountPct = pct;
    }
  }

  const cardText = card.text();
  // Unlike Cedok, both dates carry a full 4-digit year here — parsed directly, no cross-year
  // inference needed (verified across 40 sampled cards, see module doc comment).
  const dateMatch = cardText.match(/(\d{2})\.(\d{2})\.(\d{4})\s*-\s*\d{2}\.\d{2}\.\d{4}(\d+)\s*noc[ií]/);
  const departureDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
  const nights = dateMatch ? Number(dateMatch[4]) : null;

  const starsText = card.find('.js-stars').first().text().trim();
  const stars = starsText.length > 0 ? starsText.length : null;

  const board = extractBoard(cardText, gtm);

  // Deliberately unchanged (no country/locality component) even though coverage grew 4x: this hash
  // IS the offer's DB identity, so widening it would re-key every stored eximtours offer, reset
  // their price history and re-announce them as new. The collision it could cause (two same-named
  // hotels in different countries sharing a date/nights/board) was measured at 0 across all 833
  // offers of the 2026-07-29 live run, and fetchOffers now LOGS any collision it does hit instead
  // of dropping it silently — so the risk is observable rather than paid for up front.
  const sourceOfferKey = offerKeyHash([title, departureDate, nights, board]);

  return {
    source: 'eximtours',
    sourceOfferKey,
    title,
    country,
    locality,
    stars,
    board,
    transport: 'flight',
    departureAirport: null,
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

interface DestinationTarget {
  seed: EximSeed;
  /** Rows already requested (skip offset for the next page). */
  fetched: number;
  /** `paging.Count` from the first response; null until the destination has answered once. */
  total: number | null;
}

/**
 * Site order, but with the destinations our enabled watch profiles name pulled to the front.
 * Pure ordering — nothing is dropped here; MAX_DESTINATIONS does the (defensive) truncating.
 */
function orderSeeds(seeds: EximSeed[]): EximSeed[] {
  const preferred = seeds.filter((s) => PREFERRED_DESTINATIONS.has(s.name));
  const rest = seeds.filter((s) => !PREFERRED_DESTINATIONS.has(s.name));
  return [...preferred, ...rest];
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  let seeds: EximSeed[];
  try {
    const html = await ctx.http.text(`${BASE_URL}/last-minute`);
    seeds = parseEximSeeds(html);
  } catch (err) {
    // Total failure of the seed/listing fetch is NOT "market empty" — it means the request
    // itself failed. Rethrow so runScan records this source 'failed' (and skips
    // markMissedOffers) rather than swallowing to [] and flipping inventory inactive.
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`eximtours: last-minute page fetch failed (${message}), aborting`);
    throw err;
  }

  if (seeds.length === 0) {
    ctx.log('eximtours: no seeds found on last-minute page, aborting');
    return [];
  }

  const targets: DestinationTarget[] = orderSeeds(seeds)
    .slice(0, MAX_DESTINATIONS)
    .map((seed) => ({ seed, fetched: 0, total: null }));

  const all: NormalizedOffer[] = [];
  // sourceOfferKey -> detail-page path of the offer we kept. The path is the collision witness:
  // the same path re-appearing is a harmless re-listing (the site can shift rows between paged
  // requests), a DIFFERENT path under the same key is a real identity collision worth logging.
  const seen = new Map<string, string>();
  let lastError: unknown;
  let successCount = 0;
  let requests = 0;
  let collisions = 0;
  let blocked = false;

  const fetchPage = async (target: DestinationTarget): Promise<void> => {
    const { name } = target.seed;
    let res: EximSearchResponse;
    try {
      res = await ctx.http.json<EximSearchResponse>(buildSearchUrl(target.seed.searchUrl, target.fetched));
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further requests (politeness) but keep
        // whatever offers earlier destinations already yielded. Record the block as lastError so a
        // block BEFORE the first success still trips the rethrow below.
        lastError = err;
        blocked = true;
        ctx.log(`eximtours: ${name} blocked (${err.message}), stopping`);
        return;
      }
      // Any other per-page failure (network error, parse error, transient 5xx exhausted) must not
      // sink the whole fetch — log and move on. The failed page is marked as consumed so the
      // budget cannot be burned retrying the same offset forever.
      lastError = err;
      target.fetched += PAGE_SIZE;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`eximtours: ${name} rows ${target.fetched - PAGE_SIZE}+ failed (${message}), skipping`);
      return;
    }

    const count = res.paging?.Count;
    if (target.total === null) target.total = typeof count === 'number' ? count : 0;
    target.fetched += PAGE_SIZE;

    let added = 0;
    for (const offer of parseEximSearch(res)) {
      const path = new URL(offer.url).pathname;
      const keptPath = seen.get(offer.sourceOfferKey);
      if (keptPath !== undefined) {
        if (keptPath !== path) {
          collisions += 1;
          ctx.log(`eximtours: sourceOfferKey collision, dropped ${path} (kept ${keptPath})`);
        }
        continue;
      }
      seen.set(offer.sourceOfferKey, path);
      all.push(offer);
      added += 1;
    }
    ctx.log(`eximtours: ${name} rows ${target.fetched - PAGE_SIZE}-${target.fetched - 1} → +${added} (Count ${target.total})`);
  };

  // Pass 0 = breadth: the first PAGE_SIZE rows of every destination (spread + cheap tail, see the
  // module doc). Later passes spend whatever budget is left on the next page of the destinations
  // with the most unread rows, one page each per pass, so depth never starves breadth.
  for (let pass = 0; !blocked && requests < MAX_SEARCH_REQUESTS; pass += 1) {
    const due =
      pass === 0
        ? targets
        : targets
            .filter((t) => t.total !== null && t.fetched < Math.min(t.total, MAX_ROWS_PER_DESTINATION))
            .sort((a, b) => (b.total ?? 0) - b.fetched - ((a.total ?? 0) - a.fetched));
    if (due.length === 0) break;

    for (const target of due) {
      if (blocked || requests >= MAX_SEARCH_REQUESTS) break;
      requests += 1;
      await fetchPage(target);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every request failed (seeds were fine): this is not "market empty" — rethrow (fischer
    // pattern) so runScan records this source 'failed' rather than degrading to [] (which would
    // flip known offers inactive and mute the health alert). A block on the first queried
    // destination lands here → BLOCKED marker / 24h backoff engages.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`eximtours: all queried destinations failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(
    `eximtours: fetched ${all.length} offers across ${targets.length} destinations in ${requests} search requests` +
      (collisions > 0 ? ` (${collisions} key collisions dropped)` : ''),
  );
  return all;
}

export const eximtours: SourceAdapter = {
  name: 'eximtours',
  fetchOffers,
};
