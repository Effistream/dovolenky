/**
 * Zajezdy.cz "last minute" SSR listings. Every listing page embeds the whole result set as
 * `window.searchData`, so one GET yields a page of tours × their departures with no API call
 * (robots disallows `/api/`).
 *
 * LIVE RECON 2026-07-29 (generic Chrome 126 UA, ≥5 s apart, inside the 08–24 Prague window):
 *  - robots.txt (User-agent: *): Crawl-delay 5, Request-rate 1/5s 0800-2400, Disallow /api/,
 *    `?page=`, `?index=`, `?cena.min/max=`, `?stars=`, `?delka=`, `?strava=`, `?doprava=`,
 *    `?dospelych=`. `?max=` and `?sort=` are NOT disallowed.
 *  - `?max=` is the site's own page-size param (round-trips into params.max, default 10):
 *    /recko/ → 10 tours/30 departures, ?max=30 → 30/89, ?max=100 → 100/298 (1.9 MB, 5.1 s).
 *  - `?sort=cena` answers `301 → /nejlevnejsi-<slug>/`, i.e. the site publishes a cheapest-first
 *    canonical PATH. That matters because the bare slug is "Řadit podle: Doporučení":
 *    /recko/?max=100 returned 100 tours of which 100 were Kréta, floor 16 990 CZK, while
 *    /nejlevnejsi-recko/?max=50 returned 50 tours over 10 Greek destinations, floor 2 948 CZK,
 *    102/145 departures carrying a poSleve discount label.
 *  - `window.searchData` publishes NO night count (all keys dumped); `delka` is days and is
 *    always span+1. Hotel nights therefore come from the transport mode — see resolveNights.
 *  - Measured full run (20 pages × ?max=15, 5 s host gap): 762 offers / 263 tours / 11 countries
 *    / 50 localities in 127 s, prices 882–161 060 CZK, 429 with a claimed discount, 0 stale
 *    departure dates, 0 requests failed.
 */
import type { NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { normalizeBoard, normalizeCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://last-minute.zajezdy.cz';
const SEARCH_DATA_MARKER = 'window.searchData = ';

/**
 * Page size, passed as `?max=`. This is the site's OWN paging parameter — it round-trips into
 * `window.searchData.params.max` (default 10) — and it is NOT in robots.txt's Disallow list,
 * which blocks `?page=`, `?index=`, `?cena.min/max=`, `?stars=`, `?delka=`, `?strava=`,
 * `?doprava=`, `?dospelych=` (re-read live 2026-07-29 under `User-agent: *`). Live probes the
 * same day: /recko/ → 10 tours / 30 departures / 0.5 MB; /recko/?max=30 → 30 / 89 / 0.8 MB;
 * /recko/?max=100 → 100 / 298 / 1.9 MB in 5.1 s. It multiplies coverage per REQUEST instead of
 * per page, which is exactly what the 5 s crawl-delay makes expensive — one ?max=15 page costs
 * ~2 s / 0.45 MB and returns ~44 departures where the bare slug returned 30.
 */
const PAGE_SIZE = 15;

/**
 * Hard ceiling on HTTP requests per run. Budget: src/core/run.ts aborts an adapter whose
 * fetchOffers exceeds ADAPTER_FETCH_TIMEOUT_MS = 240 s and records the source 'failed' (which
 * empties it from the board entirely — strictly worse than partial coverage), and scan.ts pins
 * a 5 s host gap for last-minute.zajezdy.cz to honour robots' `Crawl-delay: 5`. At ~5 s gap +
 * ~2 s fetch each, 20 requests ≈ 140 s, leaving ~100 s of headroom for retries/slow pages.
 * PAGES is truncated to this length, so a future edit to PAGES cannot silently blow the budget.
 */
const MAX_REQUESTS = 20;

/**
 * Listing paths, fetched one request each with `?max=PAGE_SIZE`.
 *
 * Two orderings on purpose. `/nejlevnejsi-<slug>/` is the site's own cheapest-first canonical —
 * discovered, not guessed: `GET /recko/?max=30&sort=cena` answers `301 → /nejlevnejsi-recko/
 * ?max=30`. It matters because the bare slug renders "Řadit podle: Doporučení" and that
 * promoted order is both price-blind and locality-blind: /recko/?max=100 returned 100 tours of
 * which 100 were Kréta, floor 16 990 CZK, while /nejlevnejsi-recko/?max=50 returned 50 tours
 * spread over 10 Greek destinations (Thassos, Olympská riviéra, Chalkidiki, Korfu, Skiathos,
 * Rhodos, Kréta, Attika, Santorini, Evia), floor 2 948 CZK, 102 of 145 departures carrying a
 * poSleve discount label (vs 23 of 30 on the bare slug). For a discount board that tail is the
 * product. The bare slugs are kept for the top of the range, which the cheap sort truncates
 * (/maledivy/ tops out at 173 070 CZK, /nejlevnejsi-maledivy/ at 124 275).
 *
 * `rhodos`/`korfu` replace a bare `recko` for the same reason: /recko/ does not sample Řecko,
 * it samples Kréta (100/100 tours above), so a bare Greek slug spent on Rhodos (625 last-minute
 * tours) or Korfu buys inventory that is otherwise 100 % invisible. Country footprint is
 * deliberately unchanged from the pre-2026-07-29 slug set — the "seven uncovered countries"
 * finding was refuted in the audit and is not addressed here.
 */
const PAGES = [
  // cheapest-first: the cheap / high-discount tail, plus locality spread inside each country.
  // Only on COUNTRY-scoped slugs — a cheapest sort on the generic category slugs sorts globally
  // and its tail is 1-3 night self-drive spa hotels in Rakousko/Německo/Polsko (live
  // 2026-07-29: /nejlevnejsi-all-inclusive/ opens at 2 180 CZK for "2 dny, autem"), which is
  // not the holiday inventory this board is for.
  'nejlevnejsi-recko',
  'nejlevnejsi-turecko',
  'nejlevnejsi-egypt',
  'nejlevnejsi-chorvatsko',
  'nejlevnejsi-bulharsko',
  'nejlevnejsi-thajsko',
  'nejlevnejsi-maledivy',
  'nejlevnejsi-mauricius',
  'nejlevnejsi-spojene-arabske-emiraty',
  'nejlevnejsi-dominikanska-republika',
  // site default ("Doporučení") order: the promoted / premium band the cheap sort cuts off
  'all-inclusive',
  'letecky-praha',
  'rhodos',
  'korfu',
  'turecko',
  'egypt',
  'chorvatsko',
  'maledivy',
  'thajsko',
  'dominikanska-republika',
].slice(0, MAX_REQUESTS);

/**
 * Countries whose packages fly (or drive) on day schedules, so the trip's calendar span equals
 * the hotel-night count. Verified against the site's own per-departure detail pages (which carry
 * `window.tourDetail.term.nights`) on 2026-07-29: Egypt 8 dní→7 / 4 dny→3 / 15 dní→14 nocí,
 * Řecko 8→7, Turecko 8→7, Chorvatsko-autem 8→7 — 6/6 exact. Anything NOT in this set is treated
 * as long-haul, where the span is provably not the night count (see resolveNights). Membership
 * is deliberately conservative: an unrecognised country falls to the long-haul branch and yields
 * `nights: null` rather than a confident wrong number.
 */
const SHORT_HAUL_COUNTRIES = new Set([
  'Řecko',
  'Turecko',
  'Egypt',
  'Chorvatsko',
  'Bulharsko',
  'Španělsko',
  'Itálie',
  'Kypr',
  'Tunisko',
  'Malta',
  'Portugalsko',
  'Albánie',
  'Černá Hora',
  'Maroko',
  'Madeira',
  'Kanárské ostrovy',
  'Slovinsko',
  'Francie',
  'Rakousko',
  'Maďarsko',
  'Slovensko',
  'Česká republika',
  'Polsko',
  'Izrael',
  'Jordánsko',
]);

interface RawMoney {
  amount?: number;
  currency?: string;
}

interface RawTourUrl {
  title?: string;
  text?: string;
  url?: string;
}

interface RawTour {
  id?: number;
  name?: string;
  countryName?: string;
  dest?: string;
  place?: string;
  classification?: number;
  ckName?: string;
  baseUrl?: string;
}

interface RawDeparture {
  odjezdPrijezd?: string;
  letiste?: string;
  strava?: string;
  totalAdultPrice?: RawMoney;
  poSleve?: string;
  url?: RawTourUrl;
  delka?: string;
  /** Transport mode code: 1 = autobusem, 2 = letecky, 5 = autem, 99 = ostatní (options.doprava). */
  doprava?: number;
}

interface RawTourResult {
  tour?: RawTour;
  startingPrice?: RawMoney;
  departures?: RawDeparture[];
}

interface RawSearchData {
  tourResults?: RawTourResult[];
}

/**
 * Extracts the `window.searchData = {...};` JSON blob embedded in Zajezdy.cz's SSR listing
 * pages. Uses a balanced-brace scan (tracking string literals so braces inside JSON string
 * values, e.g. HTML fragments in `icons`/`transportSymbol`, don't throw off the depth count)
 * rather than a DOTALL regex: a naive `};`-terminated regex could truncate early on payloads
 * where a string value itself contains the literal sequence `};`, so we track string state
 * explicitly instead of relying on that terminator.
 */
function extractSearchData(html: string): RawSearchData | null {
  const idx = html.indexOf(SEARCH_DATA_MARKER);
  if (idx === -1) return null;
  const start = idx + SEARCH_DATA_MARKER.length;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end === -1) return null;

  try {
    return JSON.parse(html.slice(start, end)) as RawSearchData;
  } catch {
    return null;
  }
}

// Matches Czech weekday-prefixed short dates like "St 15. 7." or "Ne 2. 8." (day/month, no
// year — the year is inferred separately since Zajezdy never prints it on these labels).
const DATE_RE = /(\d{1,2})\.\s*(\d{1,2})\./g;

/**
 * Parses `odjezdPrijezd` (e.g. "St 15. 7. – St 22. 7.") into a departure ISO date + the trip's
 * CALENDAR SPAN in days (leave-home → arrive-home). The span is NOT the hotel-night count on
 * every transport mode — see resolveNights, which turns it into `nights`.
 *
 * The label carries no year: if the departure month is earlier than the current month, the
 * trip is assumed to fall in the next calendar year (mirrors the `zajezdyAllowedNow`/other
 * adapters' "last minute" framing where listings are near-term but can roll into January).
 */
function parseOdjezdPrijezd(
  raw: string | undefined,
  now: Date,
): { departureDate: string | null; spanDays: number | null } {
  if (!raw) return { departureDate: null, spanDays: null };
  const matches = [...raw.matchAll(DATE_RE)];
  if (matches.length < 2) return { departureDate: null, spanDays: null };

  const [, startDayRaw, startMonthRaw] = matches[0]!;
  const [, endDayRaw, endMonthRaw] = matches[1]!;
  const startDay = Number(startDayRaw);
  const startMonth = Number(startMonthRaw);
  const endDay = Number(endDayRaw);
  const endMonth = Number(endMonthRaw);

  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const departureYear = startMonth < currentMonth ? currentYear + 1 : currentYear;

  const startMs = Date.UTC(departureYear, startMonth - 1, startDay);
  // The arrival date can cross a year boundary relative to the departure (e.g. departs late
  // December, returns early January); if the end month is numerically before the start
  // month, it belongs to the following year.
  const endYear = endMonth < startMonth ? departureYear + 1 : departureYear;
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);

  const spanDays = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
  const departureDate = `${departureYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;

  return { departureDate, spanDays: spanDays > 0 ? spanDays : null };
}

/**
 * Transport mode from the departure's numeric `doprava` code. The code is authoritative and
 * always present; the human label (`transportLabel: "autem"`) is not usable — normalizeTransport
 * only recognises "vlastni"/"own" and returns 'unknown' for "autem", which is how 30/294 Croatian
 * offers used to land on 'unknown' despite the source labelling them explicitly.
 */
function mapTransport(departure: RawDeparture): Transport {
  switch (departure.doprava) {
    case 1:
      return 'bus';
    case 2:
      return 'flight';
    case 5:
      return 'own';
    case 13:
      // "bez dopravy" — accommodation-only package, so the traveller arranges their own way
      // there, same as doprava 5. Seen live on /nejlevnejsi-recko/ (Řecko, 3-day stay).
      return 'own';
    default:
      // doprava 99 ("ostatní") or a future code: an airport still proves it flies.
      return departure.letiste ? 'flight' : 'unknown';
  }
}

/**
 * Turns the trip's calendar span into HOTEL NIGHTS — the unit every other adapter emits and the
 * unit discount.ts (`current / nights`), market.ts (`nightsBand`, ±2 hotel matching) and
 * format.ts ("N nocí") all assume. `window.searchData` publishes no night count anywhere (every
 * key of the top level / tourResult / tour / departure objects was dumped; `delka` is days and
 * is always span+1), so the count has to be derived from the transport mode:
 *
 *  - autem (5) → span. Verified: Penzion BARTULOVIĆ 24. 8.–31. 8. → detail "8 dní, 7 nocí".
 *  - autobusem (1) → span − 2. The coach travels overnight in both directions. Verified on
 *    Pokoje LJUBA and Vila Juroš (both "10 dní, 7 nocí" against span 9), and structurally: in
 *    the live /chorvatsko/ payload every bus term is (10 dní) while the SAME hotels' car terms
 *    are (8 dní) for the same 7 nights. NOT Croatia-only — /nejlevnejsi-recko/ carries ~21 Greek
 *    coach terms (Turancar / Eurocar tour, Thassos / Olympská riviéra / Chalkidiki) and the same
 *    pairing re-verifies the rule there at a different length: Ilion (Thassos) sells bus
 *    "St 19. 8. – Ne 30. 8." (12 dní, span 11 → 9) beside its own car term "Ne 2. 8. – Út 11. 8."
 *    (10 dní, span 9 → 9) — one 9-night stay, two spans, the −2 absorbing the two coach nights.
 *    A span too short to absorb them (the live one-day "Jednodenní koupání - ISTRIE") yields
 *    null, never 0: 0 hotel nights is not a stay and would divide into discount.ts's per-night.
 *  - letecky (2) to a SHORT_HAUL_COUNTRIES destination → span. Verified 6/6 (see that set).
 *  - letecky (2) long-haul → null. NOT derivable, and this was measured rather than assumed:
 *    18 long-haul departure detail pages (Maledivy, Thajsko, Dominikánská, SAE) give span→nights
 *    of 7→7, 8→7, 9→7, 10→8, 10→7, 12→12, 13→12, 14→12, 15→12 — the travel-night loss runs 0…3
 *    and is not a function of span, transport, `cas`, `primyLet` or the operator. A span-based
 *    rule fitted to the first 10 pairs scored 15/16 and then collapsed to 3/6 on the held-out
 *    six, so it was rejected. Emitting null keeps the offer (price, dates, claimed poSleve
 *    discount all stay) but withholds it from the per-night rungs, instead of shipping a count
 *    inflated by 1–3 nights that understates price-per-night by up to 30 % and manufactures a
 *    "real discount" that digest.ts would then promote to the Telegram top-10.
 */
function resolveNights(spanDays: number | null, transport: Transport, country: string | null): number | null {
  if (spanDays === null) return null;
  if (transport === 'bus') {
    const nights = spanDays - 2;
    return nights > 0 ? nights : null;
  }
  if (transport === 'own') return spanDays;
  // flight / unknown: trustworthy only where day schedules make span === nights.
  return country !== null && SHORT_HAUL_COUNTRIES.has(country) ? spanDays : null;
}

/**
 * Parses `poSleve` (e.g. "po slevě 36&nbsp;%", possibly empty) into a discount percentage,
 * decoding the literal `&nbsp;` HTML entity that appears raw inside the JSON string value.
 */
function parsePoSleve(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/&nbsp;/g, ' ');
  const match = cleaned.match(/(\d+)\s*%/);
  if (!match) return null;
  const pct = Number(match[1]);
  return pct > 0 && pct < 100 ? pct : null;
}

/** Extracts the tour id from a detail URL like `.../dovolena-...-z3117506/2851209183/?...`. */
function extractTourId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/-z(\d+)\//);
  return match?.[1] ?? null;
}

function buildOffer(tourResult: RawTourResult, departure: RawDeparture, now: Date): NormalizedOffer | null {
  const tour = tourResult.tour;
  if (!tour) return null;

  const title = tour.name?.trim();
  if (!title) return null;

  const url = departure.url?.url;
  if (!url) return null;

  const pricePerPerson = departure.totalAdultPrice?.amount;
  if (pricePerPerson === undefined || pricePerPerson === null || !(pricePerPerson > 0)) return null;

  const { departureDate, spanDays } = parseOdjezdPrijezd(departure.odjezdPrijezd, now);
  const country = normalizeCountry(tour.countryName ?? null);
  const transport = mapTransport(departure);
  const nights = resolveNights(spanDays, transport, country);

  const claimedDiscountPct = parsePoSleve(departure.poSleve);
  const claimedOriginalPrice =
    claimedDiscountPct !== null ? Math.round(pricePerPerson / (1 - claimedDiscountPct / 100)) : null;

  const tourId = extractTourId(url) ?? extractTourId(tour.baseUrl);
  const board = normalizeBoard(departure.strava);
  // Keyed on the raw calendar SPAN, not on the derived `nights`: span is the same value this
  // adapter has always hashed here, so correcting/nulling `nights` does not re-key every live
  // zajezdy offer (which would orphan its price history and re-alert it as new). It is also the
  // better discriminator — two terms of one hotel can share a departure date and board but not a
  // span, and unlike `nights` it is never null when the date parsed.
  const sourceOfferKey = offerKeyHash([tourId ?? title, departureDate, spanDays, board]);

  return {
    source: 'zajezdy',
    sourceOfferKey,
    title,
    country,
    locality: tour.dest?.trim() || null,
    stars: typeof tour.classification === 'number' && tour.classification > 0 ? tour.classification : null,
    board,
    transport,
    departureAirport: departure.letiste?.trim() || null,
    departureDate,
    nights,
    pricePerPerson,
    priceTotal: null,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator: tour.ckName?.trim() || null,
    url,
  };
}

/**
 * Parses one Zajezdy.cz listing page's `window.searchData` JSON into normalized offers.
 * Each `tourResults[]` entry is a hotel; each of its `departures[]` is a distinct
 * hotel+term combination (dates/nights/price differ), so every departure becomes its own
 * `NormalizedOffer` — a tour with 3 departures yields 3 offers, not 1.
 */
export function parseZajezdy(html: string, now: Date = new Date()): NormalizedOffer[] {
  const data = extractSearchData(html);
  if (!data?.tourResults) return [];

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const tourResult of data.tourResults) {
    for (const departure of tourResult.departures ?? []) {
      const offer = buildOffer(tourResult, departure, now);
      if (!offer) continue;
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      offers.push(offer);
    }
  }

  return offers;
}

/** Listing URL for one path: the site's own page-size parameter, nothing robots disallows. */
export function zajezdyPageUrl(path: string): string {
  return `${BASE_URL}/${path}/?max=${PAGE_SIZE}`;
}

/** The exact URL list one run will fetch, in order. Exported so tests can assert the cap. */
export function zajezdyPageUrls(): string[] {
  return PAGES.map(zajezdyPageUrl);
}

const PRAGUE_HOUR_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  hour: 'numeric',
  hour12: false,
});

/**
 * Robots.txt / politeness for Zajezdy.cz restricts crawling to 08:00-24:00 Europe/Prague
 * (`Request-rate: 1/5s 0800-2400`, re-read live 2026-07-29). Returns true only within that
 * window; used by `fetchOffers` to skip fetching entirely outside it.
 */
export function zajezdyAllowedNow(now: Date = new Date()): boolean {
  const hourStr = PRAGUE_HOUR_FORMATTER.format(now);
  // Intl can format midnight as "24" instead of "0" depending on locale/runtime; normalize.
  const hour = Number(hourStr) % 24;
  return hour >= 8;
}

/**
 * Core fetch implementation, parameterized by `now` for testability (time-window gating and
 * date-inference both depend on it). `zajezdy.fetchOffers` (the `SourceAdapter`-conforming
 * export) is a thin wrapper that always passes the real current time; tests call this
 * function directly to exercise specific points in the crawl window.
 */
export async function fetchZajezdyOffers(ctx: SourceContext, now: Date = new Date()): Promise<NormalizedOffer[]> {
  if (!zajezdyAllowedNow(now)) {
    ctx.log('zajezdy: skipping fetch, outside allowed crawl window (08:00-24:00 Europe/Prague)');
    return [];
  }

  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  for (const path of PAGES) {
    const url = zajezdyPageUrl(path);
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(url);
      offers = parseZajezdy(html, now);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // The site is actively blocking us: stop fetching remaining pages immediately
        // (politeness) but keep whatever offers earlier pages already yielded. Record the block as
        // lastError so a block BEFORE the first success still trips the successCount===0 rethrow.
        lastError = err;
        ctx.log(`zajezdy: page ${path} blocked (${err.message}), stopping`);
        break;
      }
      // Any other per-page failure (network error, parse error, transient 5xx exhausted)
      // should not sink the whole fetch — log and move on to the next page.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`zajezdy: page ${path} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every page failed: this is not "market empty" — rethrow (fischer pattern) so runScan records
    // this source 'failed' rather than degrading to [] (which would flip known offers inactive and
    // mute the health alert). A block on the first page lands here → BLOCKED marker / 24h backoff.
    // NB: the outside-crawl-window early return above still returns [] (intentional skip, not a
    // failure) — this guard only fires once we've actually attempted (and lost) every page.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`zajezdy: all ${PAGES.length} pages failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`zajezdy: fetched ${all.length} offers across ${successCount}/${PAGES.length} pages`);
  return all;
}

export const zajezdy: SourceAdapter = {
  name: 'zajezdy',
  fetchOffers: (ctx: SourceContext) => fetchZajezdyOffers(ctx),
};
