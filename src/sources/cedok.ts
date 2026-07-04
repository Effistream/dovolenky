import * as cheerio from 'cheerio';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeTransport, normalizeCountry, parseCzk, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.cedok.cz';
const LAST_MINUTE_PAGES = 4;

/**
 * Cedok's SSR listing renders every offer card TWICE in the raw HTML: once inside a
 * mobile-width `[data-testid="offer-list-item"]` wrapper and once inside a desktop
 * "enlarged" wrapper further down the page (confirmed by diffing hotel codes across all
 * matched cards in the fixture — the second half is byte-for-byte the same 25 offers).
 * Both renderings expose the identical `data-testid` selectors, so we parse every card
 * node the same way and dedupe by `sourceOfferKey` at the end.
 *
 * `sourceOfferKey` is a hash of `[hotelCode ?? title, departureDate, nights, board]`, NOT the
 * hotel code alone: the mobile/desktop duplicate of a given card always carries identical term
 * data, so the hash still collapses that pair down to one offer, but two genuinely different
 * terms for the SAME hotel (different dates, length of stay, or board) hash to different keys
 * and both survive as distinct offers.
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

  const transportText = card.find('.icon-car-2, .icon-plane, [class*="icon-plane"]').parent().text();
  const transport = normalizeTransport(transportText || cardText);

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

  for (let page = 1; page <= LAST_MINUTE_PAGES; page += 1) {
    const url = `${BASE_URL}/last-minute/?page=${page}&order=priceAsc`;
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(url);
      offers = parseCedokListing(html);
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // The site is actively blocking us: stop paging immediately (politeness) but keep
        // whatever offers earlier pages already yielded.
        ctx.log(`cedok: page ${page} blocked (${err.message}), stopping pagination`);
        break;
      }
      // Any other per-page failure (network error, parse error, transient 5xx exhausted) should
      // not sink the whole fetch — log and move on to the next page.
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`cedok: page ${page} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  ctx.log(`cedok: fetched ${all.length} offers across ${LAST_MINUTE_PAGES} pages`);
  return all;
}

export const cedok: SourceAdapter = {
  name: 'cedok',
  fetchOffers,
};
