import * as cheerio from 'cheerio';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { normalizeBoard, normalizeCountry, normalizeTransport, isKnownCountry, parseCzk, parseCzDate, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * Adventura (adventura.cz), spec §16.1 row 15 — a Czech adventure/expedition operator with genuine
 * long-haul exotic tours (Nepál, Vietnam, Zanzibar, Réunion/Mauricius, Galápagy, Peru…). Classic
 * PHP SSR (AngularJS is only progressive enhancement): the terms table on each tour detail page is
 * fully server-rendered, so a plain GET sees every departure.
 *
 * Crawl model (sitemap-bounded, spec §16.1): GET /sitemap.xml (~2570 URLs) →
 * filterExoticTourUrls keeps only clean /zajezdy/{id}-{slug}/ detail pages whose slug matches an
 * EXOTIC_SLUG_TOKENS token (deterministically sorted) → the caller takes the first MAX_DETAILS
 * (25) → GET each → parse table.date-list rows (one row = one departure term = one offer).
 *
 * ⚠️ NEVER hit the ?druh=/?destinace=/?kontinenty= filter URLs (also present under /zajezdy/ in
 * the sitemap): they are client-side-only AND partly robots-blocked (`Disallow: /zajezdy/?*&*`).
 * filterExoticTourUrls structurally rejects anything with a query string or an extra path segment.
 *
 * Compliance (spec §16.4): robots.txt name-blocks ClaudeBot + sets Content-Signal ai-train=no.
 * The project deliberately proceeds with the standard Chrome UA (HttpClient's default) at low
 * cadence (1×/2 h) — the same §9 deviation accepted for FIRO (row 10) / Datour, for personal use.
 * Cloudflare is passive (200 on the Chrome UA; verified live 2026-07-07).
 *
 * Live verification 2026-07-07 (curl, standard Chrome UA, ≥3 s host gap):
 *  - GET /sitemap.xml (200, 366 KB) → 2570 <loc>; 972 clean /zajezdy/{id}-{slug}/ detail pages,
 *    64 exotic after the `jar` word-boundary rule (see below). The sitemap also carries filter
 *    URLs (/zajezdy/?druh=…), detail sub-pages (/zajezdy/{id}-{slug}/galerie/, /dalsi-fotky/),
 *    theme pages (/zajezdy/dle-tematu/{id}-{slug}/) and other sections (/zeme/, /cestopisy/) —
 *    all rejected structurally.
 *  - GET /zajezdy/11836-nepal-treking-udolim-serpu-az-k-everestu/ (200) → single term
 *    "29. 10. – 18. 11. 2026", First-minute -1% (74 800 → 74 052 Kč), code 25243601, letenka in
 *    "V ceně zahrnuto" (flight), breakfast only "k zakoupení" (NOT included → board unknown).
 *  - GET /zajezdy/12666-reunion-a-mauricius-turistika-a-koupani/ (200) → single term matching the
 *    spec example verbatim ("11. 11. – 23. 11. 2026", "13 dní", "-2%", 79 800 → 78 204 Kč, code
 *    26591601); multi-country title → first known country Réunion; "10x hotel se snídaní" in
 *    "V ceně zahrnuto" → board BB.
 *
 * Detail markup (verified, matches the spec's selector list):
 *  table.date-list has one <tbody class="date"> per departure term. The offer-bearing row is
 *  <tr class="heading">; it (uniquely) carries `td.range span.term`, `td.length`,
 *  `td.value span.price-value strong` (+ optional `span.discount-percentage` and
 *  `small.line-through.original-price`) and `td.code`. Each tbody also has collapsable duplicate
 *  sub-rows (Základní cena…) that lack `span.term`/`td.code` — we key off `span.term` presence so
 *  they never double-count. The `<thead>` also has a `td.code` ("Obj. číslo") but no `span.term`.
 *
 * Field mapping:
 *  - title      the visible tour <h1> (h1.top.upper). The page also has a no-class
 *               "Váš prohlížeč není podporován" browser-warning h1 → we scope to h1.top.
 *  - country    scanned from the title (then p.sub) as left-to-right n-grams gated by
 *               isKnownCountry; the FIRST recognized canonical country wins. Multi-country okruhy
 *               like "Réunion a Mauricius …" → Réunion; titles with no recognized country
 *               (Kostarika, Ekvádor, JAR acronym, declined "Nepálu"…) → null (conservative, spec).
 *  - departureDate  first date of the `span.term` range via parseFirstDate. The year prints once,
 *               at the END; a Dec→Jan wrap (start month > end month) puts the departure in year-1.
 *  - nights     `td.length` "13 dní" → 12 (days − 1). Unparseable → null.
 *  - pricePerPerson  `span.price-value strong`; the "74 052 Kč" thousands separator is U+00A0, so
 *               it is normalized to a plain space before parseCzk (parseCzk's own strip only
 *               covers regular spaces). Rows with no parsable price are SKIPPED.
 *  - claimedOriginalPrice  `small.line-through.original-price` when it parses AND exceeds the
 *               current price, else null.
 *  - claimedDiscountPct  `span.discount-percentage` "-2%" → 2, guarded to 0 < pct < 100 else null.
 *  - transport/board  keyword scan of the "V ceně zahrnuto" (price-included) prose inside
 *               div.graybox.terms — the only reliable board/transport signal. Scoping to the
 *               included segment avoids false positives like Nepal's "snídaně lze zakoupit"
 *               (breakfast purchasable, NOT board). transport: letenka/letecky → flight, else
 *               autobus → bus, else unknown. board via normalizeBoard on the matched phrase.
 *  - sourceOfferKey  offerKeyHash([td.code]) — the order number is unique per term.
 *  - url        the detail page URL passed in.
 *
 * stars/locality/departureAirport/priceTotal/omnibusLowestPrice/tourOperator are null (Adventura
 * sells its own guided expeditions; the detail term table exposes none of them).
 */

const BASE_URL = 'https://www.adventura.cz';
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;

/** Max tour detail pages fetched per scan (spec §16.1: 1 sitemap + ≤25 details ≈ 26 requests). */
export const MAX_DETAILS = 25;

/**
 * Country-slug fragments that mark a /zajezdy/{id}-{slug}/ tour as exotic. Matched as a substring
 * of the slug (so declined/compound forms are caught: "nepalu", "reunionu", "kambodza",
 * "dominikanska", "sri-lanka"). The lone exception is `jar` (Jihoafrická republika, an acronym)
 * which is matched at hyphen/word boundaries — a plain substring would wrongly fire on "jarní"
 * (spring), e.g. the Andalusia cycling tour "…-jarni-andalusie".
 */
export const EXOTIC_SLUG_TOKENS = [
  'nepal', 'vietnam', 'sri-lanka', 'srilanka', 'tanzanie', 'zanzibar', 'kambodz', 'kuba',
  'filipiny', 'peru', 'kena', 'keni', 'thajsko', 'seychely', 'reunion', 'mexiko', 'galapagy',
  'dominik', 'indonesie', 'bali', 'mauricius', 'maledivy', 'kapverdy', 'japonsko', 'madagaskar',
  'namibie', 'jar', 'ekvador', 'havaj', 'kostarika', 'panama',
] as const;

// Tokens that must match at a hyphen/word boundary rather than as a bare substring (see doc above).
const WORD_BOUNDARY_TOKENS = new Set<string>(['jar']);

/** Only a clean tour detail: /zajezdy/{digits}-{slug}/ with no query and no extra path segment. */
const DETAIL_URL_RE = /^https:\/\/www\.adventura\.cz\/zajezdy\/\d+-([a-z0-9-]+)\/?$/;

function slugIsExotic(slug: string): boolean {
  for (const token of EXOTIC_SLUG_TOKENS) {
    if (WORD_BOUNDARY_TOKENS.has(token)) {
      if (new RegExp(`(?:^|-)${token}(?:-|$)`).test(slug)) return true;
    } else if (slug.includes(token)) {
      return true;
    }
  }
  return false;
}

/**
 * From a sitemap.xml body, returns the deduplicated, lexicographically-sorted list of exotic tour
 * detail URLs (/zajezdy/{id}-{slug}/ whose slug matches an EXOTIC_SLUG_TOKENS token). Pure; the
 * MAX_DETAILS cap is applied by the caller (fetchOffers). Filter URLs (query strings), detail
 * sub-pages and category/other-section pages are all rejected by DETAIL_URL_RE.
 */
export function filterExoticTourUrls(sitemapXml: string): string[] {
  const seen = new Set<string>();
  for (const m of sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = m[1];
    if (!url) continue;
    const detail = DETAIL_URL_RE.exec(url);
    if (!detail) continue;
    const slug = detail[1]!;
    if (slugIsExotic(slug)) seen.add(url);
  }
  return [...seen].sort();
}

/** Collapses whitespace (incl. U+00A0/U+202F/U+2009) and trims. */
function cleanText(s: string): string {
  return s.replace(/[   ​]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parses an Adventura price like "74 052 Kč" (U+00A0 separator) to integer CZK. */
function parsePrice(raw: string): number | null {
  return parseCzk(raw.replace(/[   ]/g, ' '));
}

/**
 * First (departure) date of a `span.term` range as ISO. Observed form "29. 10. – 18. 11. 2026":
 * the year prints once, at the END of the range. A Dec→Jan wrap (start month > end month, e.g.
 * "27. 12. – 05. 01. 2027") means the departure is the year before the printed one. Defensive:
 * if a year is ever printed per date, the first year found belongs to the start date.
 */
function parseFirstDate(text: string): string | null {
  const start = text.match(/(\d{1,2})\.\s*(\d{1,2})\./);
  const years = text.match(/\d{4}/g);
  if (!start || !years || years.length === 0) return null;
  if (years.length >= 2) {
    return parseCzDate(`${start[1]}.${start[2]}.${years[0]}`);
  }
  let year = Number(years[0]);
  const rest = text.slice((start.index ?? 0) + start[0].length);
  const end = rest.match(/(\d{1,2})\.\s*(\d{1,2})\./);
  if (end && Number(start[2]) > Number(end[2])) {
    year -= 1;
  }
  return parseCzDate(`${start[1]}.${start[2]}.${year}`);
}

/**
 * Country from the tour title (then p.sub) via a left-to-right n-gram scan gated by
 * isKnownCountry: the first recognized canonical country wins. n-grams (up to 3 words) let
 * multi-word canonical names ("Srí Lanka") resolve; the scan naturally yields the first country
 * of a multi-country title ("Réunion a Mauricius" → Réunion). No recognized country → null.
 */
function countryFromText(text: string): string | null {
  const words = text.split(/[^\p{L}]+/u).filter((w) => w.length > 0);
  for (let i = 0; i < words.length; i += 1) {
    for (let n = Math.min(3, words.length - i); n >= 1; n -= 1) {
      const phrase = words.slice(i, i + n).join(' ');
      if (isKnownCountry(phrase)) return normalizeCountry(phrase);
    }
  }
  return null;
}

/** Transport + board keywords from the "V ceně zahrnuto" (price-included) prose of graybox.terms. */
function transportAndBoard(includedText: string): { transport: Transport; board: Board } {
  const t = includedText.toLowerCase();
  let transport: Transport = 'unknown';
  if (/leten|letec|letadl/.test(t)) transport = normalizeTransport('letecky');
  else if (/autobus/.test(t)) transport = normalizeTransport('autobus');

  let board: Board = 'unknown';
  if (/all\s*inclusive/.test(t)) board = normalizeBoard('all inclusive');
  else if (/pln[áou]\s*penz/.test(t)) board = normalizeBoard('plna penze');
  else if (/polopenz/.test(t)) board = normalizeBoard('polopenze');
  else if (/sníd|snid/.test(t)) board = normalizeBoard('snidane');
  else if (/bez\s*strav/.test(t)) board = normalizeBoard('bez stravovani');
  return { transport, board };
}

/**
 * Parses one Adventura tour detail page to NormalizedOffer[] (one per departure term). Pure: no
 * I/O. Rows without a parsable price are skipped; duplicate order codes on the same page dedupe.
 */
export function parseAdventuraDetail(html: string, url: string): NormalizedOffer[] {
  const $ = cheerio.load(html);

  const title = cleanText($('h1.top').first().text());
  if (!title) return [];

  const sub = cleanText($('p.sub').first().text());
  const country = countryFromText(title) ?? (sub ? countryFromText(sub) : null);

  // Transport/board are page-level (shared by every term); read from the price-included prose.
  const includedText = extractIncludedText($);
  const { transport, board } = transportAndBoard(includedText);

  const offers: NormalizedOffer[] = [];
  const seen = new Set<string>();

  $('table.date-list tr').each((_, el) => {
    const row = $(el);
    const termText = cleanText(row.find('span.term').first().text());
    if (!termText) return; // not a term-heading row (thead / collapsable sub-row)

    const pricePerPerson = parsePrice(row.find('.price-value strong').first().text());
    if (pricePerPerson === null) return; // skip rows with no parsable price

    const code = cleanText(row.find('td.code').first().text());
    if (!code) return;

    const departureDate = parseFirstDate(termText);

    const lengthMatch = row.find('td.length').first().text().match(/(\d+)\s*dn/i);
    const nights = lengthMatch?.[1] !== undefined ? Number(lengthMatch[1]) - 1 : null;

    const originalRaw = row.find('small.line-through.original-price').first().text();
    const original = originalRaw ? parsePrice(originalRaw) : null;
    const claimedOriginalPrice = original !== null && original > pricePerPerson ? original : null;

    const pctMatch = row.find('.discount-percentage').first().text().match(/(\d+)/);
    const pct = pctMatch?.[1] !== undefined ? Number(pctMatch[1]) : null;
    const claimedDiscountPct = pct !== null && pct > 0 && pct < 100 ? pct : null;

    const sourceOfferKey = offerKeyHash([code]);
    if (seen.has(sourceOfferKey)) return;
    seen.add(sourceOfferKey);

    offers.push({
      source: 'adventura',
      sourceOfferKey,
      title,
      country,
      locality: null,
      stars: null,
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
    });
  });

  return offers;
}

/**
 * Text of the "V ceně zahrnuto" (price-included) block inside div.graybox.terms — the reliable
 * board/transport source. Adventura repeats it in a print-hide `.row` (fourth/three-fourths
 * columns) and a print-show `<li>`; we take the first `.three-fourths` following the
 * "V ceně zahrnuto:" label. Falls back to the whole terms text (transport only stays reliable
 * there) if the labelled block is not found.
 */
function extractIncludedText($: cheerio.CheerioAPI): string {
  let included = '';
  $('div.graybox.terms .row').each((_, el) => {
    const row = $(el);
    const label = cleanText(row.find('.fourth, .headline').first().text()).toLowerCase();
    if (label.includes('v ceně zahrnuto') || label.includes('v cene zahrnuto')) {
      included = cleanText(row.find('.three-fourths, .content').first().text());
      return false; // stop at the first match
    }
    return undefined;
  });
  if (included) return included;
  // Fallback: whole terms prose (board detection may be less precise, transport still ok).
  return cleanText($('div.graybox.terms').first().text());
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  // Without the sitemap there is nothing to scan → let a sitemap failure propagate (runScan then
  // records this source 'failed' rather than degrading to [] and flipping known offers inactive).
  const sitemapXml = await ctx.http.text(SITEMAP_URL);

  const exoticUrls = filterExoticTourUrls(sitemapXml);
  const targets = exoticUrls.slice(0, MAX_DETAILS);
  const skipped = exoticUrls.length - targets.length;
  if (skipped > 0) {
    ctx.log(`adventura: ${exoticUrls.length} exotic tour URLs, capped at ${MAX_DETAILS} (${skipped} skipped this run)`);
  }

  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let pageCount = 0;
  let lastError: unknown;

  for (const url of targets) {
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(url);
      offers = parseAdventuraDetail(html, url);
      pageCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Actively blocked: stop issuing further detail GETs (politeness) but keep what we have.
        // Record the block so a block BEFORE the first success still trips the rethrow below.
        lastError = err;
        ctx.log(`adventura: ${url} blocked (${err.message}), stopping`);
        break;
      }
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`adventura: ${url} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (pageCount === 0 && lastError !== undefined) {
    // Every detail GET failed (the sitemap itself was fine): this is NOT "market empty" — rethrow
    // the last error (sibling convention) so runScan records this source 'failed' rather than
    // degrading to [] (which would flip known offers inactive and mute the health alert). A block
    // on the very first detail lands here too, so the BLOCKED marker / 24h backoff engages.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`adventura: all ${targets.length} detail pages failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`adventura: fetched ${all.length} offers across ${pageCount} tour pages`);
  return all;
}

export const adventura: SourceAdapter = {
  name: 'adventura',
  fetchOffers,
};
