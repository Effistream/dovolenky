import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, parseCzk, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.cedok.cz';

/**
 * Hard ceiling on HTTP requests per run. `HttpClient` enforces a 3 s gap per host and
 * `runScan` aborts an adapter after ADAPTER_FETCH_TIMEOUT_MS (240 s), recording the source
 * 'failed' and dropping it from the board entirely — strictly worse than partial coverage.
 * Each URL therefore costs ~4 s (gap + fetch); the table below builds 24 URLs ≈ 100 s, which
 * leaves room for HttpClient's own retries. The cap exists so a future edit to
 * DESTINATION_QUERIES cannot silently blow the timeout.
 */
const MAX_REQUESTS = 30;

/**
 * Recon 2026-07-29 (Chrome/126 UA, own fetches + this file's parser):
 *
 * `/last-minute/` reports 3 294 offers and pages 25 at a time. There is no page-size lever —
 * `?take=100` and `?perPage=100` are both ignored (server-side query is pinned at take=25), so
 * coverage is bought one request at a time and the destination mix has to be chosen by hand.
 *
 * ORDERING. The listing's DEFAULT order is `popularity`, and that is where the inventory this
 * board exists for lives: 7-night All-inclusive flight packages at 6 000–85 000 CZK/person with a
 * strike-through `base-price` on 64–100 % of cards. `&order=priceAsc` returns the SAME inventory
 * sorted cheapest-first, i.e. the bottom tail: 1–2 night domestic stays under ~2 700 CZK with a
 * base-price on ~2 % of cards. Until 2026-07-29 this adapter fetched ONLY `order=priceAsc` pages
 * 1–4, i.e. the 100 cheapest of 3 294 offers (3 %), and never saw a single flight package.
 * `order=priceDesc` is silently ignored by the site, so flipping the direction is not an option.
 *
 * WHAT WE FETCH NOW (24 URLs):
 *  - `/last-minute/?page=1..2` — default order, the popularity head across all destinations.
 *  - `/last-minute/<country>/?page=…` — default order per destination. Measured 2026-07-29
 *    (inventory / discounted cards on page 1): italie 362/18, recko 305/23, chorvatsko 227/8,
 *    turecko 203/22, spanelsko 199/22, kanarske-ostrovy 136/25, egypt 114/24, portugalsko 110/22,
 *    thajsko 71/12, bulharsko 68/10, albanie 37/16, kypr 26/0, tunisko 22/22. Breadth beats depth
 *    here: page 1 of each country is a different set of hotels, whereas paging one destination
 *    deep just walks down its own popularity tail. `/last-minute/exotika/` exists but returned
 *    0 offers, so it is not queried.
 *  - `/last-minute/?page=1..4&order=priceAsc` — kept deliberately. This is the exact slice the
 *    adapter used to return; it is the only source of cheap domestic 1–2 night stays on the board
 *    and it is what the `last-minute` profile (≤14 days, ≤20 000 CZK) matches most often. Dropping
 *    it would have traded one coverage hole for another.
 *
 * PARSING. Cedok's SSR listing renders every offer card TWICE in the raw HTML: once inside a
 * mobile-width `[data-testid="offer-list-item"]` wrapper and once inside a desktop "enlarged"
 * wrapper further down the page (confirmed by diffing hotel codes across all matched cards in the
 * fixture — the second half is byte-for-byte the same 25 offers). Both renderings expose the
 * identical `data-testid` selectors, so we parse every card node the same way and dedupe by
 * `sourceOfferKey` at the end.
 *
 * `sourceOfferKey` is a hash of `[hotelCode ?? title, departureDate, nights, board]`, NOT the
 * hotel code alone: the mobile/desktop duplicate of a given card always carries identical term
 * data, so the hash still collapses that pair down to one offer, but two genuinely different
 * terms for the SAME hotel (different dates, length of stay, or board) hash to different keys
 * and both survive as distinct offers. The same hash also dedupes across URLs, which matters
 * because the per-country pages and the overview pages overlap by construction.
 */
export function parseCedokListing(html: string): NormalizedOffer[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  $('[data-testid="offer-list-item"]').each((_, el) => {
    const offer = parseCard($, $(el));
    if (!offer) return;
    if (seen.has(offer.sourceOfferKey)) return;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  });

  return offers;
}

/** Destination sub-listings, default (popularity) order. See the header docblock for the measured
 *  inventory behind each slug and why the big ones get a second page and the rest do not. */
const DESTINATION_QUERIES: { slug: string; pages: number }[] = [
  { slug: 'recko', pages: 2 },
  { slug: 'italie', pages: 2 },
  { slug: 'chorvatsko', pages: 2 },
  { slug: 'turecko', pages: 2 },
  { slug: 'spanelsko', pages: 2 },
  { slug: 'kanarske-ostrovy', pages: 1 },
  { slug: 'egypt', pages: 1 },
  { slug: 'portugalsko', pages: 1 },
  { slug: 'thajsko', pages: 1 },
  { slug: 'bulharsko', pages: 1 },
  { slug: 'albanie', pages: 1 },
  { slug: 'kypr', pages: 1 },
  { slug: 'tunisko', pages: 1 },
];

const OVERVIEW_PAGES = 2;
const CHEAP_TAIL_PAGES = 4;

/**
 * The exact URL list a run fetches, in fetch order. Highest-value first (flight packages with a
 * strike-through price), cheap domestic tail last, so a mid-run block still leaves us the
 * inventory the board cares about. Hard-capped at MAX_REQUESTS.
 */
export function buildCedokUrls(): string[] {
  const urls: string[] = [];
  for (let page = 1; page <= OVERVIEW_PAGES; page += 1) {
    urls.push(`${BASE_URL}/last-minute/?page=${page}`);
  }
  for (const { slug, pages } of DESTINATION_QUERIES) {
    for (let page = 1; page <= pages; page += 1) {
      urls.push(`${BASE_URL}/last-minute/${slug}/?page=${page}`);
    }
  }
  for (let page = 1; page <= CHEAP_TAIL_PAGES; page += 1) {
    urls.push(`${BASE_URL}/last-minute/?page=${page}&order=priceAsc`);
  }
  return urls.slice(0, MAX_REQUESTS);
}

/**
 * "Praha (letiště) 18:40" -> "Praha". The flight label packs the airport city, a "(letiště)"
 * qualifier and the departure time into one string; only the city is kept, because that is what
 * `normalizeAirport` maps to an IATA code (praha -> PRG, ostrava -> OSR, …).
 */
function parseDepartureAirport(label: string): string | null {
  const city = label
    .replace(/\(\s*leti[šs]t[ěe]\s*\)/gi, ' ')
    .replace(/\d{1,2}:\d{2}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return city || null;
}

function parseCard($: cheerio.CheerioAPI, card: ReturnType<cheerio.CheerioAPI>): NormalizedOffer | null {
  const detailLink = card.find('a[href*="/dovolena/"], a[href*="/zajezdy/"]').first();
  const href = detailLink.attr('href');
  if (!href) return null;
  const url = new URL(href, BASE_URL).toString();

  const titleEl = card.find('h3 a').first();
  const title = titleEl.text().trim() || card.find('img[data-testid="gallery-img"]').first().attr('alt')?.trim() || '';
  if (!title) return null;

  const destinationText = card.find('[data-testid="offer-list-item-destination"]').first().text().trim();
  const [countryRaw, localityRaw] = destinationText.split(',').map((s) => s.trim());
  const country = normalizeCountry(countryRaw ?? null);
  const locality = localityRaw || null;

  const currentPriceRaw = card.find('[data-testid="current-price"]').first().text();
  const pricePerPerson = parseCzk(currentPriceRaw);
  if (pricePerPerson === null) return null;

  const basePriceRaw = card.find('[data-testid="base-price"]').first().text();
  const claimedOriginalPrice = basePriceRaw ? parseCzk(basePriceRaw) : null;
  const claimedDiscountPct =
    claimedOriginalPrice !== null && claimedOriginalPrice > pricePerPerson
      ? Math.round(((claimedOriginalPrice - pricePerPerson) / claimedOriginalPrice) * 100)
      : null;

  const stars = card.find('[data-testid="rating-stars"] .icon-shape-star').length || null;

  const cardText = card.text();
  // Captures both the start day/month AND the end month, because the source text carries a
  // year only on the END date (e.g. "28.12 - 04.01.2027 (8 dní)"). When the trip spans a
  // year boundary the start month (numerically) is greater than the end month, so the start
  // date actually belongs to the PRECEDING year (2026-12-28, not 2027-12-28).
  const dateMatch = cardText.match(/(\d{2})\.(\d{2})\s*-\s*\d{2}\.(\d{2})\.(\d{4})\s*\((\d+)\s*dn[yí]\)/);
  let departureDate: string | null = null;
  if (dateMatch) {
    const [, startDay, startMonth, endMonth, endYearRaw] = dateMatch;
    const endYear = Number(endYearRaw);
    const departureYear = Number(startMonth) > Number(endMonth) ? endYear - 1 : endYear;
    departureDate = `${departureYear}-${startMonth}-${startDay}`;
  }
  const nights = dateMatch ? Number(dateMatch[5]) - 1 : null;

  // Transport is decided by the ICON class, not by the label text. A flight card's label reads
  // "Praha (letiště) 04:50" — no "letec"/"flight" token anywhere — so normalizeTransport on the
  // text resolved every single flight offer to 'unknown'. The icon is unambiguous:
  // `icon-airplane` (note: NOT "icon-plane", the old `[class*="icon-plane"]` selector never
  // matched it) for flights, `icon-car-2` for own transport. Text is only the last resort.
  const transportIcon = card
    .find('[class*="icon-airplane"], [class*="icon-plane"], [class*="icon-car-2"], [class*="icon-bus"]')
    .first();
  const transportIconClass = transportIcon.attr('class') ?? '';
  const transportLabel = transportIcon.parent().text().trim();
  let transport: Transport;
  let departureAirport: string | null = null;
  if (/icon-(airplane|plane)/.test(transportIconClass)) {
    transport = 'flight';
    // Same node the transport comes from also carries the departure airport, so PRG/OSR
    // filtering on the board finally works for cedok.
    departureAirport = parseDepartureAirport(transportLabel);
  } else if (/icon-car/.test(transportIconClass)) {
    transport = 'own';
  } else if (/icon-bus/.test(transportIconClass)) {
    transport = 'bus';
  } else {
    transport = normalizeTransport(transportLabel || cardText);
  }

  const boardText = card.find('.icon-cutlery-77').parent().text();
  const board = normalizeBoard(boardText || cardText);

  // Keyed on hotel/title + the specific term (dates/nights/board), not the hotel alone: the
  // same hotel can appear multiple times in a listing with different date ranges or board
  // types, and those are genuinely different offers that must not collapse into one.
  const hotelCodeMatch = href.match(/,([A-Za-z0-9]+)\//);
  const sourceOfferKey = offerKeyHash([hotelCodeMatch?.[1] ?? title, departureDate, nights, board]);

  return {
    source: 'cedok',
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
    tourOperator: null,
    url,
  };
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  const urls = buildCedokUrls();
  let lastError: unknown;
  let successCount = 0;

  for (const url of urls) {
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(url);
      offers = parseCedokListing(html);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // The site is actively blocking us: stop paging immediately (politeness) but keep
        // whatever offers earlier pages already yielded. Record the block as lastError so a block
        // BEFORE the first success still trips the successCount===0 rethrow below.
        lastError = err;
        ctx.log(`cedok: ${url} blocked (${err.message}), stopping pagination`);
        break;
      }
      // Any other per-URL failure (network error, parse error, transient 5xx exhausted) should
      // not sink the whole fetch — log and move on to the next URL.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`cedok: ${url} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every URL failed: this is not "market empty" — rethrow (fischer pattern) so runScan records
    // this source 'failed' rather than degrading to [] (which would flip known offers inactive and
    // mute the health alert). A block on the first URL lands here → BLOCKED marker / 24h backoff.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`cedok: all ${urls.length} URLs failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`cedok: fetched ${all.length} offers across ${successCount}/${urls.length} URLs`);
  return all;
}

export const cedok: SourceAdapter = {
  name: 'cedok',
  fetchOffers,
};
