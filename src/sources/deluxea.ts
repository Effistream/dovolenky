import * as cheerio from 'cheerio';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, parseCzk, parseCzDate, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * Deluxea (deluxea.cz) — a Czech luxury/exotic specialist (Maldives, Mauritius, Seychelles,
 * Zanzibar…), spec §16.1 row 13. SSR Nette site. A hotel card that HAS an online price embeds it
 * in a `data-json` attribute on `<form class="offline-data hotel-comparator-form">`; the visible
 * price cells in the DOM are "-" placeholders hydrated client-side, so DOM price text is NEVER
 * parsed — `data-json` is the only honest price source.
 *
 * ── Live recon 2026-07-29 (curl, standard Chrome UA), which reshaped this adapter ───────────────
 *
 * PAGINATION IS STATELESS IF YOU DROP THE SIGNAL. The paginator renders
 * `/hotely/?num=N&view=grid&destination=<id>&do=changeSide`; that form 302s to page 1 unless the
 * request carries the PHPSESSID the country listing handed out (`do=changeSide` is a Nette signal
 * that stores the page in the session), and a self-invented PHPSESSID is rejected. But `num` is
 * ALSO a plain URL parameter: GET `/hotely/?destination=4&view=grid&num=2` with no cookie at all
 * returns page 2 (verified: 8 wholly different Maldives hotels vs page 1). So this adapter fetches
 * `/hotely/?destination=<id>&view=grid&num=<page>` — no cookie jar needed in src/core/http.ts.
 * `/hotely-<slug>/?num=2` does NOT work (redirects to page 1), hence the numeric destination ids.
 *
 * DESTINATION IDS come from the site's own filter multiselect (`select[name="destinationmulti[]"]`,
 * present on every listing page); the ids below were read off it live on 2026-07-29.
 *
 * PRICED INVENTORY IS SMALL AND CONCENTRATED. Per-page card audit over 50+ live pages: a card is
 * either "offline-data" (data-json with a baked price), "price on demand" (data-json with
 * `price {"7":"-"}` + `price_on_demand {"7":1}`), or `form.hotel-comparator-form.calculate-me`
 * with NO data-json at all — the last kind is priced only by an per-hotel AJAX POST, far outside
 * the request budget, so it is skipped (it is not a parse bug: the site itself shows those hotels
 * as "Cena na vyžádání"). Priced pages found: maledivy id 4 pages 1-8 (45 offers; 9-12 dead),
 * mauricius id 2 pages 1-3 (18), seychely id 5 pages 1-3 (17), zanzibar id 16 page 1 (8),
 * thajsko id 13 page 1 (2), kena id 67 page 1 (3). Zero priced cards anywhere on emiraty(18),
 * sri-lanka(12), bali(9), vietnam(8), tanzanie(30), dominikanska-republika(32), mexiko(31),
 * katar(69), jihoafricka-republika(25), oman(64), jordansko(75), polynesie(6), fidzi(11),
 * reunion(15), filipiny(33), madagaskar(44) — so ~95 priced offers is the whole online catalogue,
 * not a sampling choice. Those zero-yield destinations are still probed once per scan (1 GET each)
 * so the adapter picks them up by itself the day Deluxea bakes prices for them.
 *
 * WHY departureDate IS NULL (changed 2026-07-29). data-json's `date_from` is NOT the offer's term:
 * it is the default value of the price-calculator form next to the card (`<input name="date"
 * value="10.09.2026">`, `<select name="nights_from"><option value="7" selected>`), echoed back into
 * the JSON. Proof: the 2026-07-07 fixtures and every page fetched 2026-07-29 carry the identical
 * `date_from 10.09.2026 / date_to 19.09.2026` — 22 days apart, zero movement, and identical for
 * Zanzibar and the Maldives, which have opposite seasons. The site's own listing subtitle says it
 * plainly: "Odlet každý den z Prahy nebo Vídně. Pobyt může být libovolně dlouhý." — these are
 * tailor-made trips with no fixed departure. So the quoted figure is an indicative price for a
 * sample 7-night term, and the honest mapping for departureDate is null (a constant fake term made
 * the board's "Odlet" column, month filters and market.ts's date windows meaningless, and would
 * have swept the whole source off the board the day the default date went past). `nights` IS kept:
 * it is the term length the quoted price is calculated for (the nights key of the price dict).
 *
 * NO DISCOUNT SIGNAL EXISTS. `old_total` was 0 (or "-") on every card across ~50 pages / 30
 * destinations, both fixtures and today's live pages; the listing's "nejvyšší sleva" sort is a
 * client-side POST, not a URL parameter (`?order=3` is ignored). claimedOriginalPrice /
 * claimedDiscountPct therefore stay null in practice; the mapping below is exercised by a
 * synthetic test card so it works if the site ever bakes one.
 *
 * data-json shape (verified key inventory — every price-bearing field is a dict KEYED BY NIGHTS,
 * e.g. `{"7": …}` where "7" = 7 nights; a single card observed to carry exactly one nights key):
 *  - total            {"7":"44 090"} per-person ALL-INCLUSIVE price (hotel + flight + transfer/tax),
 *                     regular-space thousands → pricePerPerson. This is the honest per-person price
 *                     deluxea.cz displays. Proven per-person by `childs` (each child's total − price
 *                     == the adult `tickets`); observed total ≈ price + tickets + transfer across 24
 *                     cards / 3 destinations. priceTotal is left null (no honest party sum exposed).
 *  - price            {"7":"18 710"} HOTEL-only "od" per-person component — NOT the headline; using
 *                     it underpriced every flight package by the ticket+transfer cost. Used only to
 *                     detect a real priced term: "-" / unparsable ⇒ price on demand ⇒ SKIP the card.
 *  - price_on_demand  {"7":1} the site's own "Cena na vyžádání" flag (then `total` is an HTML
 *                     `<span>Cena na vyžádání</span>` blob) ⇒ SKIP.
 *  - old_total        {"7":…} crossed-out per-person all-in price → claimedOriginalPrice when
 *                     strictly above total; old_total 0 / "-" / == total (the default) ⇒ no discount.
 *  - old_price/diff_total/diff_total_abs — hotel-only / delta variants (not used for the headline).
 *  - meal             {"7":"Snídaně"|"All&nbsp;Inclusive"|"Polopenze"} → normalizeBoard.
 *  - date_from/date_to {"7":"10.09.2026"} — the CALCULATOR DEFAULT, see above; not mapped to
 *                     departureDate, only used to warn in the log if it has gone past.
 *  - days             {"7":10} (= hotel nights + 3 travel days; `tour_length` says "10 dní / 7 nocí
 *                     v hotelu"). nights comes from the price-dict KEY = hotel nights, matching the
 *                     site's own label.
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
 *    country, fall back to the country derived from the listing URL — either the legacy
 *    `/hotely-<slug>/` shape or `?destination=<id>` via DESTINATIONS below.
 *  - the "Lokalita:" row's `<strong>` = locality (e.g. "Maledivy, Baa atoll").
 *  - the card anchor `href` (e.g. "/maledivy/hotel-finolhu/") = detail URL (absolutized) and the
 *    stable component of sourceOfferKey = offerKeyHash([detailHref, nights]). The calculator's
 *    default date is deliberately NOT part of the key: it is site chrome, and keying on it would
 *    churn every offer into a "new" one the day Deluxea moves that default.
 *
 * departureAirport is null: the only airport in data-json ("Vídeň, 10.09.2026 v 11:55") belongs to
 * the same default calculation as the date, and the site sells departures from Prague OR Vienna on
 * any day. tourOperator is null (Deluxea sells its own curated inventory). omnibusLowestPrice is
 * null (no such field).
 */

const BASE_URL = 'https://www.deluxea.cz';

/**
 * REQUEST BUDGET. src/core/run.ts aborts an adapter after ADAPTER_FETCH_TIMEOUT_MS = 240 s and
 * HttpClient keeps a 3 s gap per host, so a request costs ~4 s wall clock. 34 requests ≈ 140 s,
 * leaving margin. A natural run stops itself around 30 (see the loop's exhaustion rule); this cap
 * exists so a site change — a paginator that suddenly reports 100 pages of priced cards — cannot
 * silently blow the timeout and turn a partial source into a 'failed' one (which would drop
 * Deluxea off the board entirely).
 */
const MAX_REQUESTS = 34;

/** Hard per-destination page cap, independent of what the paginator claims. Maledivy, the deepest
 *  destination, runs out of priced cards on page 9 of 12. */
const MAX_PAGES_PER_DESTINATION = 10;

interface Destination {
  /** Numeric id from the site's `destinationmulti[]` filter (read live 2026-07-29). */
  readonly id: number;
  /** The `/hotely-<slug>/` slug — only used as the country fallback for cards whose
   *  `span.destination-name` is a region rather than a country. */
  readonly slug: string;
}

// Exotic long-haul destinations. Ordered so that the ones that actually carry online prices are
// fetched first: the loop sweeps page 1 of every destination before it goes deeper, so a run that
// gets cut short still returns the productive countries. Europe is deliberately absent — Deluxea is
// this project's exotic specialist (spec §16.1 row 13) and Greece/Italy/Turkey/Croatia/Spain are
// already covered by nine other adapters.
const DESTINATIONS: readonly Destination[] = [
  { id: 4, slug: 'maledivy' },
  { id: 2, slug: 'mauricius' },
  { id: 5, slug: 'seychely' },
  { id: 16, slug: 'zanzibar' },
  { id: 13, slug: 'thajsko' },
  { id: 67, slug: 'kena' },
  // Probes: no priced card anywhere on these today, but one GET each per scan is what makes the
  // adapter notice by itself when that changes.
  { id: 18, slug: 'emiraty' },
  { id: 12, slug: 'sri-lanka' },
  { id: 9, slug: 'bali' },
  { id: 8, slug: 'vietnam' },
  { id: 30, slug: 'tanzanie' },
  { id: 32, slug: 'dominikanska-republika' },
  { id: 31, slug: 'mexiko' },
];

const DESTINATION_BY_ID = new Map(DESTINATIONS.map((d) => [d.id, d]));

/** Stateless listing URL for one destination page — see the PAGINATION note in the header. */
function listingUrl(destinationId: number, page: number): string {
  return `${BASE_URL}/hotely/?destination=${destinationId}&view=grid&num=${page}`;
}

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

/**
 * Derives a canonical country from the listing URL, or null. Handles both listing shapes: the
 * `/hotely-<slug>/` country page (still what the saved fixtures use) and the paginated
 * `/hotely/?destination=<id>` form this adapter fetches, whose id maps back to a slug.
 */
function countryFromListingUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, BASE_URL);
  } catch {
    return null;
  }

  let slug: string | null = null;
  const m = parsed.pathname.match(/\/hotely-([a-z0-9-]+)\/?/i);
  if (m?.[1]) {
    slug = m[1];
  } else {
    const id = Number(parsed.searchParams.get('destination'));
    slug = Number.isFinite(id) ? (DESTINATION_BY_ID.get(id)?.slug ?? null) : null;
  }
  if (slug === null) return null;

  const name = slug.replace(/-/g, ' '); // sri-lanka -> "sri lanka", dominikanska-republika -> "…"
  return isKnownCountry(name) ? normalizeCountry(name) : null;
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

  // Pick the term (nights key) and the honest per-person price. That price is `total` — the
  // ALL-INCLUSIVE figure (hotel + flight + transfer/tax), which is what deluxea.cz shows as the
  // per-person price. `price` is only the HOTEL-only "od" component and must NOT be the headline:
  // using it underprices every flight package by the ticket+transfer cost (e.g. Mauricius Telfair
  // 18 710 `price` vs the real 44 090 `total`). Proven per-person by the `childs` dict, where each
  // child's (total − price) equals the adult `tickets`. We iterate `price` to find a real, priced
  // term (a "-" placeholder = price on demand → skip), then take that term's `total`.
  const priceDict = j.price;
  let nightsKey: string | null = null;
  let pricePerPerson: number | null = null;
  if (priceDict !== null && typeof priceDict === 'object' && !Array.isArray(priceDict)) {
    for (const [k, v] of Object.entries(priceDict as Record<string, unknown>)) {
      if (atKey(j.price_on_demand, k) === 1) continue; // the site's own "Cena na vyžádání" flag
      if (toCzk(v) === null) continue; // no hotel price for this term → "-" on demand, skip
      const allIn = toCzk(atKey(j.total, k)); // all-in per-person price = the honest headline
      if (allIn === null) continue; // no total → can't price this term honestly
      nightsKey = k;
      pricePerPerson = allIn;
      break;
    }
  }
  if (nightsKey === null || pricePerPerson === null) return null;

  const nights = Number.isFinite(Number(nightsKey)) ? Number(nightsKey) : null;
  // No honest whole-party total is exposed (`total` is per-person all-in, not a party sum), so
  // leave priceTotal null rather than mislabel a per-person figure as the booking total.
  const priceTotal: number | null = null;

  // Discount from the ALL-IN figures (old_total vs total), matching pricePerPerson's basis. An
  // old_total strictly above the current all-in price is an honest crossed-out price; the ubiquitous
  // no-discount default (old_total 0 / == total) → both claimed fields null.
  const oldAllIn = toCzk(atKey(j.old_total, nightsKey));
  let claimedOriginalPrice: number | null = null;
  let claimedDiscountPct: number | null = null;
  if (oldAllIn !== null && oldAllIn > pricePerPerson) {
    const pct = Math.round(((oldAllIn - pricePerPerson) / oldAllIn) * 100);
    if (pct > 0 && pct < 100) {
      claimedOriginalPrice = oldAllIn;
      claimedDiscountPct = pct;
    }
  }

  const board: Board = normalizeBoard(strAtKey(j.meal, nightsKey)?.replace(/&nbsp;| /g, ' ') ?? null);

  // NO departureDate. `date_from` is the price-calculator form's default value echoed back into the
  // JSON (see the header): identical on every card of every destination and unchanged for weeks,
  // while the site advertises daily departures. Emitting it as a term made 100% of this source
  // carry one fake date, which the board sorted on and profile filters matched against.

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

  // Keyed on the hotel detail path + term length only. The calculator's default date used to be in
  // here; it is site chrome, so keying on it would have re-created every offer as "new" (and fired
  // a fresh alert for each) the day Deluxea nudges that default forward.
  const sourceOfferKey = offerKeyHash([href, nights]);

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
    departureDate: null, // see the header: date_from is the calculator's default, not a real term
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
 * Parses one Deluxea listing HTML page to NormalizedOffer[]. Pure function: no I/O.
 * Iterates `.single-item` cards, reads each card's `form.hotel-comparator-form` data-json for
 * prices and the static card HTML for name/stars/country/locality/URL. Dedupes by
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

/**
 * Highest page number the listing's own paginator offers, or null when the page has no paginator
 * (single-page destination). Used to stop before requesting pages the site does not have. The
 * links are the session-bound `do=changeSide` form; only their `num` is read, never followed.
 */
export function parseDeluxeaMaxPage(html: string): number | null {
  const $ = cheerio.load(html);
  let max = 0;
  $('#snippet--paginator a[href*="num="]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const m = href.match(/[?&]num=(\d+)/);
    const n = m?.[1] !== undefined ? Number(m[1]) : NaN;
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max > 0 ? max : null;
}

/**
 * The term (ISO date) the listing's price calculator is defaulted to, read off the first card's
 * data-json. Not an offer field — fetchOffers only logs it, so that a default date drifting into
 * the past (which would silently make every quoted price fiction) shows up in the scan log.
 */
export function parseDeluxeaQuotedTerm(html: string): string | null {
  const $ = cheerio.load(html);
  const raw = $('form.hotel-comparator-form[data-json]').first().attr('data-json');
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const dict = j.date_from;
    if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return null;
    const first = Object.values(dict as Record<string, unknown>)[0];
    return parseCzDate(typeof first === 'string' ? first : null);
  } catch {
    return null;
  }
}

/** Per-destination cursor for the breadth-first paging loop below. */
interface DestinationState {
  readonly dest: Destination;
  page: number;
  maxPage: number;
  done: boolean;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let requests = 0;
  let successCount = 0;
  let quotedTerm: string | null = null;

  const states: DestinationState[] = DESTINATIONS.map((dest) => ({
    dest,
    page: 1,
    maxPage: MAX_PAGES_PER_DESTINATION,
    done: false,
  }));

  // Breadth first: one page of every destination, then page 2 of the ones that still yield, and so
  // on. A budget that runs out therefore costs depth in the deepest destination, never a whole
  // country — and destinations that publish nothing cost exactly one probe GET each.
  outer: while (requests < MAX_REQUESTS && states.some((s) => !s.done)) {
    for (const state of states) {
      if (state.done) continue;
      if (requests >= MAX_REQUESTS) break outer;

      const url = listingUrl(state.dest.id, state.page);
      let html: string;
      requests += 1;
      try {
        html = await ctx.http.text(url);
        successCount += 1;
      } catch (err) {
        if (err instanceof SourceBlockedError) {
          // Site is actively blocking us: stop issuing further GETs (politeness) but keep whatever
          // earlier pages already yielded. Record the block as lastError so a block BEFORE the
          // first success still trips the successCount===0 rethrow below (→ BLOCKED marker → 24h
          // backoff) instead of silently degrading to [].
          lastError = err;
          ctx.log(`deluxea: ${url} blocked (${err.message}), stopping`);
          break outer;
        }
        lastError = err;
        state.done = true; // drop this destination, keep the others
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`deluxea: ${url} failed (${message}), skipping`);
        continue;
      }

      const paginatorMax = parseDeluxeaMaxPage(html);
      if (paginatorMax !== null) state.maxPage = Math.min(paginatorMax, MAX_PAGES_PER_DESTINATION);
      if (quotedTerm === null) quotedTerm = parseDeluxeaQuotedTerm(html);

      let added = 0;
      for (const offer of parseDeluxeaListing(html, url)) {
        // The same hotel can surface on more than one page (the site repeats a few as "related") →
        // dedupe globally.
        if (seen.has(offer.sourceOfferKey)) continue;
        seen.add(offer.sourceOfferKey);
        all.push(offer);
        added += 1;
      }

      // Stop paging a destination as soon as a page adds nothing new: on every destination measured
      // live, the priced cards sit on the first pages and the tail is pure "price on demand" /
      // client-calculated cards, so paging on would burn budget another destination can use.
      if (added === 0 || state.page >= state.maxPage) state.done = true;
      state.page += 1;
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every GET failed: this is not "market empty", we simply saw nothing because every request
    // failed. Rethrow (fischer/alexandria pattern) so runScan records this source 'failed' rather
    // than degrading to [] and flipping known offers inactive / muting the health alert.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`deluxea: all ${requests} requests failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  if (quotedTerm !== null && quotedTerm < new Date().toISOString().slice(0, 10)) {
    // The whole source is priced for the calculator's default term; once that goes past, the prices
    // stop being bookable. Nothing to do about it here, but it must not fail silently.
    ctx.log(`deluxea: WARNING site's quoted term ${quotedTerm} is in the past — prices may be stale`);
  }

  ctx.log(`deluxea: fetched ${all.length} offers in ${requests} requests (${successCount} ok)`);
  return all;
}

export const deluxea: SourceAdapter = {
  name: 'deluxea',
  fetchOffers,
};
