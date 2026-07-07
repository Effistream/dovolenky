import * as cheerio from 'cheerio';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, parseCzk, parseCzDate, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * ESO travel (esotravel.cz; exotika.cz is a 301 alias) — an established Czech exotic/long-haul
 * specialist (Thailand, Maldives, Zanzibar, Mexico, Cuba…), spec §16.1 row 14. Classic PHP SSR:
 * offer cards are fully server-rendered in the listing HTML; the "Načíst další" button only
 * reveals already-embedded cards (no extra request), so a single GET per listing sees everything.
 *
 * IMPORTANT SOURCE PECULIARITY: ESO publishes NO crossed-out prices and NO discount percentages
 * anywhere (it positions on absolute "od X Kč" pricing) → claimedOriginalPrice/claimedDiscountPct
 * are ALWAYS null here, and price-drop detection for this source comes purely from our own
 * price snapshots keyed by sourceOfferKey. For that to work the key MUST be price-independent —
 * see the key strategy below.
 *
 * Live verification 2026-07-07 (curl, standard Chrome UA, ≥3 s host gap; robots.txt is fully
 * permissive — `Disallow:` empty; see .superpowers/sdd/task-38-report.md):
 *  - GET /sitemap.xml (200, 166 KB) → country listing pages are actually
 *    `/dovolena/{slug}/zajezdy/zajezdy/` (DOUBLE `zajezdy`, not the single-`zajezdy` shape in the
 *    brief), 147 country slugs. ESO's slug for Mauritius is `mauritius` (NOT `mauricius`).
 *  - GET /last-minute/zajezdy/ → 307 redirect to /last-minute/ → we GET /last-minute/ directly.
 *  - GET /dovolena/maledivy/zajezdy/zajezdy/ (200) → 15 pobytové cards (`div.listview.primary
 *    .pobyt-box`), links `?ha={hotelId}&zj={categoryId}` (no `?termin=`), board present (see below).
 *  - GET /dovolena/thajsko/zajezdy/zajezdy/ (200) → 23 mixed cards: 8 poznávací (`?termin={id}`)
 *    + 15 pobytové (`?ha=`); 1 card ("Perly Jihočínského moře") has an EMPTY `?termin=`, no price,
 *    no date → real skip case.
 *  - GET /last-minute/ (200) → 15 poznávací cards (`.list-box`), all `?termin={id}`; the
 *    `.tour-type span` there holds the COUNTRY (USA, Gruzie, Egypt…), whereas on country listings
 *    it holds the LOCALITY (Raa Atol, Pattaya…).
 *
 * Card anatomy (shared by all three page kinds): each `div.listview.primary` holds TWO alternate
 * layouts of the SAME offer — a `.visible` block (image + .tour-type + h2 + .detail-date +
 * a.term-price with span.days + div.price strong) and a `.hidden` block (list layout, adds
 * `.place` and `.popis`). One card = ONE offer (parse the `.visible` block; never both). Cards
 * with "+ další období (N)" still map to one offer — the displayed nearest term.
 *
 * Field mapping (all selectors observed live):
 *  - title      `.visible h2` minus its `<sup>` star icons; `<br>` inside h2 → space
 *               ("Reethi Faru<br>Resort" → "Reethi Faru Resort").
 *  - stars      count of `h2 sup i.fa-star` (pobytové only; poznávací tours have none → null).
 *  - country    country listings: the `country` param derived from the listing slug (hardcoded
 *               per LISTINGS entry — slugs like `mauritius` don't round-trip via normalizeCountry).
 *               last-minute (country param null): `.tour-type span` gated by isKnownCountry
 *               (unrecognized ones like "USA" stay null rather than guessing).
 *  - locality   country listings: `.tour-type span` when it is NOT a recognized country (it holds
 *               an atoll/resort area there). last-minute: null (the span is a country slot).
 *  - departureDate  first day.month in the `.detail-date` first anchor + the FIRST year found in
 *               that text ("01. 05. - 31. 10. 2026" → 2026-05-01; a cross-year range prints the
 *               year with each date, so the first year still belongs to the first date).
 *  - nights     `span.days` "15 dní / 12 nocí" → 12.
 *  - pricePerPerson  `div.price strong`, e.g. "54 990" — the thousands separator is a REAL
 *               U+00A0. ⚠️ parseCzk's whitespace-strip class contains only regular 0x20 spaces
 *               (verified by hexdump + failing probe), so NBSP variants are normalized to a plain
 *               space here BEFORE parseCzk (same pattern as deluxea). No parsable price
 *               ("na vyžádání" / empty) → SKIP the card.
 *  - board      brief said 'unknown' (no board on the listing), but the REAL pobytové markup does
 *               carry it: `.hidden .popis i.fa-utensils` is immediately followed by a text node
 *               ("snídaně" / "polopenze" / "plná penze" / "all inclusive" / "bez stravy" — full
 *               live mix on the Maledivy page) → normalizeBoard. Poznávací cards have no .popis →
 *               'unknown'. Secondary selector added per the follow-the-real-markup instruction.
 *  - transport  'flight' only when the card's `.tour-type` text clearly says "letecky"/"letecký";
 *               otherwise 'unknown'. (No current listing page shows it — kept as a guarded path.)
 *  - url        first `.visible a[href]`, absolutized against baseUrl, `#panel-terminy` hash
 *               stripped.
 *
 * sourceOfferKey strategy (price-independent BY DESIGN — a price change must keep the key stable
 * or our snapshot history, ESO's only price-drop signal, would reset on every drop; this
 * deliberately deviates from the brief's literal `[slug/url, date, price]` fallback):
 *  - poznávací:  `?termin={id}` — numeric term ids are site-global (verified unique across pages)
 *                → offerKeyHash([termin]). The same term surfacing on two listings dedupes.
 *  - pobytové:   no termin; `?ha={hotelId}` + URL path identify the hotel offer
 *                → offerKeyHash([pathname, ha, departureDate, nights]).
 *  - neither:    offerKeyHash([pathname, departureDate, nights]).
 *
 * priceTotal is null (listing shows only the per-person "od" price). departureAirport null.
 * tourOperator null (ESO sells its own tours; no per-offer operator on the card).
 */

const BASE_URL = 'https://www.esotravel.cz';

// 10 exotic country listings + last-minute = 11 GETs/scan (within the spec's ~10-15 ESO budget).
// Slugs verbatim from the live sitemap 2026-07-07 (all present as /dovolena/{slug}/zajezdy/zajezdy/).
// The country is hardcoded per slug because ESO's slug spelling doesn't always round-trip through
// normalizeCountry (`mauritius` is not a recognized key; canonical name is "Mauricius").
const LISTINGS: ReadonlyArray<{ readonly url: string; readonly country: string | null }> = [
  { url: `${BASE_URL}/dovolena/thajsko/zajezdy/zajezdy/`, country: 'Thajsko' },
  { url: `${BASE_URL}/dovolena/maledivy/zajezdy/zajezdy/`, country: 'Maledivy' },
  { url: `${BASE_URL}/dovolena/mauritius/zajezdy/zajezdy/`, country: 'Mauricius' },
  { url: `${BASE_URL}/dovolena/zanzibar/zajezdy/zajezdy/`, country: 'Zanzibar' },
  { url: `${BASE_URL}/dovolena/dominikanska-republika/zajezdy/zajezdy/`, country: 'Dominikánská republika' },
  { url: `${BASE_URL}/dovolena/sri-lanka/zajezdy/zajezdy/`, country: 'Srí Lanka' },
  { url: `${BASE_URL}/dovolena/vietnam/zajezdy/zajezdy/`, country: 'Vietnam' },
  { url: `${BASE_URL}/dovolena/kuba/zajezdy/zajezdy/`, country: 'Kuba' },
  { url: `${BASE_URL}/dovolena/mexiko/zajezdy/zajezdy/`, country: 'Mexiko' },
  { url: `${BASE_URL}/dovolena/seychely/zajezdy/zajezdy/`, country: 'Seychely' },
  // /last-minute/zajezdy/ 307-redirects here; country comes from each card's .tour-type span.
  { url: `${BASE_URL}/last-minute/`, country: null },
];

/** Strips zero-width chars and collapses whitespace (incl. NBSP) in card text. */
function cleanText(s: string): string {
  return s.replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parses a card price like "54 990" to integer CZK. parseCzk's own whitespace strip only
 * covers regular spaces, so NBSP/narrow-NBSP (and a defensive literal "&nbsp;") are normalized
 * to plain spaces first — verified against the live fixtures where the separator is U+00A0.
 */
function parsePrice(raw: string): number | null {
  return parseCzk(raw.replace(/&nbsp;|[  ]/g, ' '));
}

/**
 * Extracts the FIRST date of a `.detail-date` range as ISO. The visible text is
 * "01. 05. - 31. 10. 2026" (year only at the end for same-year ranges; printed with each date
 * when the range crosses years), so: first `d. m.` pair + first year found anywhere in the text.
 */
function parseFirstDate(text: string): string | null {
  const dm = text.match(/(\d{1,2})\.\s*(\d{1,2})\./);
  const year = text.match(/(\d{4})/);
  if (!dm || !year) return null;
  return parseCzDate(`${dm[1]}.${dm[2]}.${year[1]}`);
}

/** Board from the hidden list layout: the text node right after `.popis i.fa-utensils`. */
function extractBoard(card: ReturnType<cheerio.CheerioAPI>): Board {
  const utensils = card.find('.popis i.fa-utensils').first();
  const el = utensils.get(0);
  if (el && 'nextSibling' in el && el.nextSibling && el.nextSibling.type === 'text') {
    const raw = (el.nextSibling as { data?: string }).data?.trim();
    if (raw) return normalizeBoard(raw);
  }
  return 'unknown';
}

function mapCard(
  card: ReturnType<cheerio.CheerioAPI>,
  country: string | null,
  baseUrl: string,
): NormalizedOffer | null {
  // Each card carries the SAME offer twice (.visible grid layout + .hidden list layout);
  // scope field extraction to .visible so nothing double-counts, with a defensive fallback.
  const visible = card.children('.visible').first();
  const scope = visible.length > 0 ? visible : card;

  // Price gate first: no parsable "od X Kč" (price on request / empty template) → skip.
  const priceRaw = scope.find('.price strong').first().text();
  const pricePerPerson = parsePrice(priceRaw);
  if (pricePerPerson === null) return null;

  // Title: h2 minus its <sup> star icons; <br> becomes a space.
  const h2 = scope.find('h2').first();
  if (h2.length === 0) return null;
  const h2Clone = h2.clone();
  h2Clone.find('sup').remove();
  h2Clone.find('br').replaceWith(' ');
  const title = cleanText(h2Clone.text());
  if (!title) return null;

  const href = scope.find('a[href]').first().attr('href');
  if (!href) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(href, baseUrl);
  } catch {
    return null;
  }
  parsedUrl.hash = '';
  const url = parsedUrl.toString();

  // .tour-type span: LOCALITY on country listings (Raa Atol, Pattaya…), COUNTRY on last-minute.
  const span = scope.find('.tour-type span').first().text().trim();
  let offerCountry: string | null;
  let locality: string | null;
  if (country !== null) {
    offerCountry = country;
    // When the span just repeats a recognized country (poznávací cards), it is not a locality.
    locality = span !== '' && !isKnownCountry(span) ? span : null;
  } else {
    offerCountry = isKnownCountry(span) ? normalizeCountry(span) : null;
    locality = null; // on last-minute the span is a country slot, never a locality
  }

  const departureDate = parseFirstDate(scope.find('.detail-date a').first().text());

  const nightsMatch = scope.find('.days').first().text().match(/(\d+)\s*noc/i);
  const nights = nightsMatch?.[1] !== undefined ? Number(nightsMatch[1]) : null;

  const starCount = scope.find('h2 i.fa-star').length;
  const stars = starCount > 0 ? starCount : null;

  const board = extractBoard(card);

  // 'flight' only on a clear "letecky/letecký" marker in the card's tour-type; never guessed.
  const transport: Transport = /letec/i.test(scope.find('.tour-type').first().text()) ? 'flight' : 'unknown';

  // Price-independent key (see module doc): termin id > pathname+ha+date+nights > pathname+date+nights.
  const termin = parsedUrl.searchParams.get('termin');
  const ha = parsedUrl.searchParams.get('ha');
  let sourceOfferKey: string;
  if (termin !== null && termin.trim() !== '') {
    sourceOfferKey = offerKeyHash([termin.trim()]);
  } else if (ha !== null && ha.trim() !== '') {
    sourceOfferKey = offerKeyHash([parsedUrl.pathname, ha.trim(), departureDate, nights]);
  } else {
    sourceOfferKey = offerKeyHash([parsedUrl.pathname, departureDate, nights]);
  }

  return {
    source: 'esotravel',
    sourceOfferKey,
    title,
    country: offerCountry,
    locality,
    stars,
    board,
    transport,
    departureAirport: null,
    departureDate,
    nights,
    pricePerPerson,
    priceTotal: null,
    claimedOriginalPrice: null, // ESO publishes no crossed-out prices — always null by design
    claimedDiscountPct: null, // ESO publishes no discount percentages — always null by design
    omnibusLowestPrice: null,
    tourOperator: null,
    url,
  };
}

/**
 * Parses one ESO travel listing page (country listing or last-minute) to NormalizedOffer[].
 * Pure function: no I/O. `country` is the canonical country for a `/dovolena/{slug}/…` listing
 * (every card inherits it), or null for /last-minute/ (country then comes from each card's
 * `.tour-type span`, gated by isKnownCountry). Iterates `div.listview.primary` cards — both the
 * initially visible ones and the ones behind "Načíst další" are present in the HTML. A card with
 * "+ další období (N)" yields ONE offer (the displayed nearest term). Dedupes by sourceOfferKey
 * (first wins).
 */
export function parseEsoListing(html: string, country: string | null, baseUrl: string): NormalizedOffer[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  $('.listview.primary').each((_, el) => {
    const offer = mapCard($(el), country, baseUrl);
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

  for (const listing of LISTINGS) {
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(listing.url);
      offers = parseEsoListing(html, listing.country, BASE_URL);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further listing GETs (politeness) but keep
        // whatever offers earlier pages already yielded.
        ctx.log(`esotravel: ${listing.url} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`esotravel: ${listing.url} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      // The same term can surface on more than one listing (e.g. a country page AND last-minute)
      // → dedupe globally by sourceOfferKey.
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every listing GET failed: this is not "market empty" — rethrow (fischer/deluxea pattern) so
    // runScan records this source 'failed' rather than degrading to [] and flipping known offers
    // inactive / muting the health alert.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`esotravel: all ${LISTINGS.length} listing URLs failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`esotravel: fetched ${all.length} offers across ${successCount} listing pages`);
  return all;
}

export const esotravel: SourceAdapter = {
  name: 'esotravel',
  fetchOffers,
};
