import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, parseCzk, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.eximtours.cz';
// Destination names must match the site's OWN GroupSearch2 `locations[].name` labels exactly, or
// `seedByName.get(name)` misses and the destination is gracefully skipped ("no seed found for X").
// Exotic names (spec §16.2) live-verified 2026-07-07 (Chrome UA) against the real /last-minute
// GroupSearch2 payload (20 locations): present with these exact labels → Spojené arabské emiráty,
// Zanzibar, Maledivy, Thajsko, Dominikánská republika, Mauricius, Mexiko, and 'Kapverdské ostrovy'
// (NOT 'Kapverdy' — the site's label carries " ostrovy", the brief's bare 'Kapverdy' would skip).
// 'Kuba' was NOT in the live last-minute inventory this run; kept optimistically since the seed set
// is dynamic last-minute stock and the graceful skip costs nothing when it is absent.
const TARGET_DESTINATIONS = [
  'Řecko',
  'Egypt',
  'Turecko',
  'Spojené arabské emiráty',
  'Zanzibar',
  'Maledivy',
  'Thajsko',
  'Dominikánská republika',
  'Mauricius',
  'Kuba',
  'Mexiko',
  'Kapverdské ostrovy',
];

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
 * Card parsing (from tests/fixtures/eximtours/getsearch.json's `HTML` field), confirmed live:
 * - Card root: `#divHotelCard` (cheerio/css-select returns every match even though the id repeats
 *   20 times per page — unlike a real DOM's getElementById, this is safe and intentional here).
 * - Hotel name + detail URL: the SECOND `<a>` in the card (index 1; index 0 is a "Zobrazit na
 *   mapě" map-anchor with `href="#"`). Detail hrefs are root-relative with a full query string.
 * - Country/resort/locality: the 3rd/4th/5th `<a>` tags (indices 2-4), e.g. "Egypt" / "Hurghada" /
 *   "Hurghada" or "Řecko" / "Thassos a Kavala" / "Skala Rachoni". Index 2 = country (canonicalized
 *   via normalizeCountry + isKnownCountry guard per the binding country-or-null lesson), index 4
 *   = locality (used as-is, raw).
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
 *   star count. Board: free-text search for the known Czech/English board strings in the card's
 *   full text (e.g. "All inclusive", "Polopenze", "Bez stravování") via normalizeBoard.
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

function parseCard($: cheerio.CheerioAPI, card: ReturnType<cheerio.CheerioAPI>): NormalizedOffer | null {
  const links = card.find('a');
  const nameLink = links.eq(1);
  const title = nameLink.text().trim();
  const href = nameLink.attr('href');
  if (!title || !href) return null;
  const url = new URL(href, BASE_URL).toString();

  const countryRaw = links.eq(2).text().trim() || null;
  const locality = links.eq(4).text().trim() || null;
  const country = isKnownCountry(countryRaw) ? normalizeCountry(countryRaw) : null;

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

  const boardMatch = cardText.match(/All inclusive|Polopenze|Plná penze|Snídaně|Bez stravování/i);
  const board = normalizeBoard(boardMatch?.[0] ?? null);

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

  const seedByName = new Map(seeds.map((s) => [s.name, s]));
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();

  for (const name of TARGET_DESTINATIONS) {
    const seed = seedByName.get(name);
    if (!seed) {
      ctx.log(`eximtours: no seed found for ${name}, skipping`);
      continue;
    }

    let offers: NormalizedOffer[];
    try {
      const query = seed.searchUrl.split('?')[1] ?? '';
      const url = `${BASE_URL}/searchresult/getsearch?${query}`;
      const res = await ctx.http.json<EximSearchResponse>(url);
      offers = parseEximSearch(res);
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further destination requests
        // (politeness) but keep whatever offers earlier destinations already yielded.
        ctx.log(`eximtours: ${name} blocked (${err.message}), stopping`);
        break;
      }
      // Any other per-destination failure (network error, parse error, transient 5xx
      // exhausted) must not sink the whole fetch — log and move on to the next destination.
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`eximtours: ${name} query failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  ctx.log(`eximtours: fetched ${all.length} offers across ${TARGET_DESTINATIONS.length} destinations`);
  return all;
}

export const eximtours: SourceAdapter = {
  name: 'eximtours',
  fetchOffers,
};
