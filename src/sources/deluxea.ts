import * as cheerio from 'cheerio';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, parseCzk, parseCzDate, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * Deluxea (deluxea.cz) — a Czech luxury/exotic specialist (Maldives, Emirates, Mauritius,
 * Zanzibar…), spec §16.1 row 13. SSR Nette site. Every hotel card embeds a COMPLETE offer JSON in
 * a `data-json` attribute on `<form class="offline-data hotel-comparator-form">`; the visible price
 * cells in the DOM are "-" placeholders hydrated client-side, so DOM price text is NEVER parsed —
 * `data-json` is the only honest price source.
 *
 * Live verification 2026-07-07 (curl, standard Chrome UA; see .superpowers/sdd/task-37-report.md):
 *  - GET /sitemap.xml (181 KB, 200) → listing pages are `/hotely-<slug>/`; the exotic slugs used
 *    here are the ACTUAL sitemap shapes: `emiraty` (NOT `spojene-arabske-emiraty`), `bali`,
 *    `dominikanska-republika`, `sri-lanka`, etc.
 *  - GET /hotely-maledivy/ (200) → 9 `.single-item` cards, 8 carry a `form.hotel-comparator-form`
 *    with data-json (the 9th is an empty template). cheerio's `attr('data-json')` returns the
 *    once-HTML-decoded JSON string that `JSON.parse` consumes directly (0 parse failures across
 *    both saved fixtures).
 *  - GET /hotely-emiraty/ (200) → 7 cards whose data-json `price` is literally `{"7":"-"}` (price
 *    on demand) and `hotel` empty → ALL skipped. Real evidence that a "-" price is a valid,
 *    expected skip, not a bug.
 *  - GET /hotely-mauricius/, /hotely-zanzibar/ (200) → fully-baked prices but, like Maledivy, every
 *    card has `old_price == price` and `diff_total == "0"`. IMPORTANT observed reality: the default
 *    listing view never surfaces a discount (`diff_total > 0`) — the discount/`claimedOriginalPrice`
 *    path is real per the data schema but is exercised in tests by a synthetic card, because no
 *    default listing page within the live budget showed one.
 *
 * data-json shape (verified key inventory — every price-bearing field is a dict KEYED BY NIGHTS,
 * e.g. `{"7": …}` where "7" = 7 nights; a single card observed to carry exactly one nights key):
 *  - price            {"7":"37 690"} per-person "od" price, regular-space thousands → pricePerPerson
 *                     (parseCzk strips the 0x20 space). "-" / unparsable → SKIP the card.
 *  - total            {"7":"71 130"} → priceTotal (party total; not necessarily price*persons).
 *  - old_price        {"7":"37 690"} crossed-out per-person price; == price when no discount.
 *  - old_total/diff_total/diff_total_abs — discount deltas; diff_total "0" ⇒ no discount.
 *  - meal             {"7":"Snídaně"|"All&nbsp;Inclusive"|"Polopenze"} → normalizeBoard.
 *  - date_from/date_to {"7":"10.09.2026"} DD.MM.YYYY → parseCzDate → ISO departureDate.
 *  - full_date        {"7":"10. 09. - 19. 09. 2026"} (unused; date_from is the clean source).
 *  - days             {"7":10} (= nights + 3; nights come from the price-dict KEY, not this).
 *  - tickets          {"7":"16 800"} flight-ticket price; tickets_company_name {"7":"Etihad Airways"}.
 *                     Non-empty tickets or a company name ⇒ transport 'flight', else 'unknown'.
 *  - hotel/hotel_id/hotel_url — hotel_url is null; the offer URL comes from the static card anchor.
 *
 * Static card HTML (the honest source for name/stars/country/locality/URL, per the brief):
 *  - `h2 > a` text (minus the `span.beutystar` child) = hotel name (nicely-cased, e.g. "Seaside
 *    Finolhu Baa Atoll Maldives"; the data-json `hotel` is UPPERCASED + star glyphs).
 *  - `h2 span.beutystar` text is a run of literal `*` (NOT `★`) → star count. (A SECOND
 *    `span.beutystar` lives in the rating widget `9.8*` in line2 — scoping to `h2` avoids it.)
 *  - `span.destination-name` = country, gated by isKnownCountry; when it isn't a recognized
 *    country, fall back to the country derived from the listing-URL `/hotely-<slug>/` (hyphens →
 *    spaces so e.g. `sri-lanka` → "Srí Lanka", `dominikanska-republika` resolves).
 *  - the "Lokalita:" row's `<strong>` = locality (e.g. "Maledivy, Baa atoll").
 *  - the card anchor `href` (e.g. "/maledivy/hotel-finolhu/") = detail URL (absolutized) and the
 *    stable component of sourceOfferKey = offerKeyHash([detailHref, date_from, nights]).
 *
 * departureAirport is null (no single-airport field; departures are multi-city). tourOperator is
 * null (Deluxea sells its own curated inventory; no per-offer operator in data-json).
 * omnibusLowestPrice is null (no such field).
 */

const BASE_URL = 'https://www.deluxea.cz';

// Exotic long-haul listing slugs, taken verbatim from the live sitemap 2026-07-07 (all confirmed
// present). 12 pages/scan → 12 GETs, within the spec's ~10-12 Deluxea budget. `emiraty`/`bali` are
// the site's real slugs (not the canonical country names).
const LISTING_SLUGS = [
  'maledivy',
  'emiraty',
  'mauricius',
  'seychely',
  'zanzibar',
  'thajsko',
  'bali',
  'sri-lanka',
  'dominikanska-republika',
  'vietnam',
  'mexiko',
  'tanzanie',
];

const LISTING_URLS = LISTING_SLUGS.map((slug) => `${BASE_URL}/hotely-${slug}/`);

/** Reads the value at `key` from a nights-keyed data-json dict, or undefined if absent/not a dict. */
function atKey(dict: unknown, key: string): unknown {
  if (dict !== null && typeof dict === 'object' && !Array.isArray(dict)) {
    return (dict as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Same, but only returns a string value (else null). */
function strAtKey(dict: unknown, key: string): string | null {
  const v = atKey(dict, key);
  return typeof v === 'string' ? v : null;
}

/**
 * Coerces a data-json money value to a positive integer CZK, or null. Values are either strings
 * with regular-space thousands ("37 690") — parseCzk handles the 0x20 space; we also normalize any
 * NBSP/narrow-NBSP and the literal "&nbsp;" entity that survives one HTML-decode into a space — or,
 * for a few fields (old_total), a bare number.
 */
function toCzk(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v === 'string') {
    return parseCzk(v.replace(/&nbsp;| | /g, ' '));
  }
  return null;
}

/** Strips zero-width chars and collapses whitespace in a static-HTML title. */
function cleanText(s: string): string {
  return s.replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/** Derives a canonical country from the listing URL's `/hotely-<slug>/` path, or null. */
function countryFromListingUrl(listingUrl: string): string | null {
  let path: string;
  try {
    path = new URL(listingUrl, BASE_URL).pathname;
  } catch {
    return null;
  }
  const m = path.match(/\/hotely-([a-z0-9-]+)\/?/i);
  if (!m?.[1]) return null;
  const slug = m[1].replace(/-/g, ' '); // sri-lanka -> "sri lanka", dominikanska-republika -> "…"
  return isKnownCountry(slug) ? normalizeCountry(slug) : null;
}

function mapCard($: cheerio.CheerioAPI, card: ReturnType<cheerio.CheerioAPI>, listingUrl: string): NormalizedOffer | null {
  const form = card.find('form.hotel-comparator-form[data-json]').first();
  const dataJson = form.attr('data-json');
  if (!dataJson) return null; // empty template / no offer data

  let j: Record<string, unknown>;
  try {
    j = JSON.parse(dataJson) as Record<string, unknown>;
  } catch {
    return null; // malformed data-json → skip, never throw
  }

  // nights + pricePerPerson come from the price dict: first key whose value parses to a positive
  // CZK. A "-" placeholder (price on demand) yields no parsable value → skip the card.
  const priceDict = j.price;
  let nightsKey: string | null = null;
  let pricePerPerson: number | null = null;
  if (priceDict !== null && typeof priceDict === 'object' && !Array.isArray(priceDict)) {
    for (const [k, v] of Object.entries(priceDict as Record<string, unknown>)) {
      const p = toCzk(v);
      if (p !== null) {
        nightsKey = k;
        pricePerPerson = p;
        break;
      }
    }
  }
  if (nightsKey === null || pricePerPerson === null) return null;

  const nights = Number.isFinite(Number(nightsKey)) ? Number(nightsKey) : null;
  const priceTotal = toCzk(atKey(j.total, nightsKey));

  // Discount: an old_price strictly above the current per-person price is an honest crossed-out
  // price (equivalently diff_total > 0). old_price == price (the ubiquitous no-discount default) →
  // both claimed fields null.
  const oldPerPerson = toCzk(atKey(j.old_price, nightsKey));
  let claimedOriginalPrice: number | null = null;
  let claimedDiscountPct: number | null = null;
  if (oldPerPerson !== null && oldPerPerson > pricePerPerson) {
    const pct = Math.round(((oldPerPerson - pricePerPerson) / oldPerPerson) * 100);
    if (pct > 0 && pct < 100) {
      claimedOriginalPrice = oldPerPerson;
      claimedDiscountPct = pct;
    }
  }

  const board: Board = normalizeBoard(strAtKey(j.meal, nightsKey)?.replace(/&nbsp;| /g, ' ') ?? null);

  const dateFromRaw = strAtKey(j.date_from, nightsKey);
  const departureDate = parseCzDate(dateFromRaw);

  // transport: a flight ticket price or airline name on the card ⇒ 'flight'; otherwise 'unknown'.
  const ticketsRaw = strAtKey(j.tickets, nightsKey);
  const ticketsCompany = strAtKey(j.tickets_company_name, nightsKey);
  const hasFlight =
    (ticketsRaw !== null && ticketsRaw.trim() !== '' && ticketsRaw.trim() !== '-') ||
    (ticketsCompany !== null && ticketsCompany.trim() !== '');
  const transport = hasFlight ? 'flight' : 'unknown';

  // Static-HTML card fields (the honest source for name/stars/country/locality/URL).
  const nameAnchor = card.find('h2 a').first();
  const title = cleanText(nameAnchor.clone().children().remove().end().text());
  if (!title) return null;

  const href = nameAnchor.attr('href') ?? nameAnchor.attr('data-href');
  if (!href) return null;
  let url: string;
  try {
    url = new URL(href, BASE_URL).toString();
  } catch {
    return null;
  }

  const starsText = card.find('h2 span.beutystar').first().text();
  const starCount = (starsText.match(/[*★]/g) ?? []).length;
  const stars = starCount > 0 ? starCount : null;

  const destName = card.find('span.destination-name').first().text().trim();
  const country = isKnownCountry(destName) ? normalizeCountry(destName) : countryFromListingUrl(listingUrl);

  let locality: string | null = null;
  card.find('p').each((_, p) => {
    if (locality !== null) return;
    const loc = $(p).find('span.loc').first().text();
    if (/Lokalita/i.test(loc)) {
      const strong = cleanText($(p).find('strong').first().text());
      if (strong) locality = strong;
    }
  });

  const sourceOfferKey = offerKeyHash([href, dateFromRaw, nights]);

  return {
    source: 'deluxea',
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
    priceTotal,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator: null,
    url,
  };
}

/**
 * Parses one Deluxea country-listing HTML page to NormalizedOffer[]. Pure function: no I/O.
 * Iterates `.single-item` cards, reads each card's `form.hotel-comparator-form` data-json for
 * prices/dates and the static card HTML for name/stars/country/locality/URL. Dedupes by
 * sourceOfferKey (first wins). `listingUrl` supplies the country fallback when a card's
 * `span.destination-name` is not a recognized country.
 */
export function parseDeluxeaListing(html: string, listingUrl: string): NormalizedOffer[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  $('.single-item').each((_, el) => {
    const offer = mapCard($, $(el), listingUrl);
    if (!offer) return;
    if (seen.has(offer.sourceOfferKey)) return;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  });

  return offers;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  for (const url of LISTING_URLS) {
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(url);
      offers = parseDeluxeaListing(html, url);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further listing GETs (politeness) but keep
        // whatever offers earlier pages already yielded.
        ctx.log(`deluxea: ${url} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`deluxea: ${url} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      // The same hotel term can appear on more than one listing page → dedupe globally.
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every listing GET failed: this is not "market empty", we simply saw nothing because every
    // request failed. Rethrow (fischer/alexandria pattern) so runScan records this source 'failed'
    // rather than degrading to [] and flipping known offers inactive / muting the health alert.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`deluxea: all ${LISTING_URLS.length} listing URLs failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`deluxea: fetched ${all.length} offers across ${successCount} listing pages`);
  return all;
}

export const deluxea: SourceAdapter = {
  name: 'deluxea',
  fetchOffers,
};
