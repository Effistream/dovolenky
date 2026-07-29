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
 * Crawl model (sitemap-bounded, spec §16.1): GET /sitemap.xml (~2580 URLs) →
 * filterExoticTourUrls keeps only clean /zajezdy/{id}-{slug}/ detail pages whose slug carries an
 * EXOTIC_SLUG_TOKENS stem (deterministically sorted) → selectDetailWindow takes a ROTATING slice of
 * MAX_DETAILS (39) → GET each → parse table.date-list rows (one row = one departure term = one
 * offer). Per-run footprint stays at MAX_REQUESTS_PER_RUN (40) = 160 s wall clock (measured).
 *
 * ⚠️ Why the window ROTATES (audit 2026-07-29): it used to be `urls.slice(0, 25)`. Every tour id is
 * 5 digits, so the lexicographic sort equals ascending id and the slice always returned the same 25
 * OLDEST tour records; the other 39 were fetched on NO run, ever — 10 watched exotic countries
 * (Kuba, Zanzibar, Keňa, Madagaskar, Mauricius, Kapverdy, Maledivy, Indonésie, JAR, Filipíny) could
 * not reach the DB at all. Ids are monotonic, so every newly published tour landed in the dead tail.
 * A rotating window keeps the per-run request budget identical while covering the whole catalogue.
 * ⚠️ The rotation MUST stay a 2-run cycle: ingest.ts deactivates an offer after MAX_MISSES = 2
 * consecutive scans without it, so an offer may miss at most ONE scan in a row. 74 exotic URLs /
 * 39 per run = 2 windows today (headroom: 78); fetchOffers logs a WARNING if it ever outgrows that.
 * The rotation index is derived from wall clock (ROTATION_PERIOD_MS = the 2 h scan cadence in
 * .github/workflows/scan.yml), because an adapter has no run counter or DB access.
 *
 * ⚠️ KNOWN RESIDUAL RISK — do NOT read the 2-run cycle as a guarantee. The index is
 * `floor(now / 2 h) % 2`, so two consecutive scans land in different windows only if they fall in
 * different 2 h buckets. .github/workflows/scan.yml documents its own measurement of the real cron
 * (2026-07-29): starts at 16:03, 19:16, 21:03, 22:54, 02:09, 06:27 — gaps of 1.8–4.5 h AND dropped
 * slots, not the "few minutes of jitter" this scheme would need. Those six starts give bucket
 * parities 0,1,0,1,1,1: the last three repeat window 2, so window-1 offers would have missed three
 * scans in a row and ingest.ts would have flipped them inactive. Expect roughly half the Adventura
 * board to flap active/inactive some cycles. It is still strictly better than the pre-fix state
 * (those tours were never fetched at all, so they could not exist in the DB), and it does NOT
 * re-notify: run.ts gates Telegram on ingest's one-shot `isNew` plus notify.ts's at-most-once sent
 * log, and a reactivated row is not new. Removing the flap needs a change OUTSIDE this adapter —
 * either MAX_MISSES = 3 in src/core/ingest.ts, or a run counter on SourceContext (which would let
 * the window advance once per RUN instead of once per wall-clock period, killing the problem
 * outright). A sliding-window variant was evaluated and rejected: it trades the current ~50 % odds
 * of ZERO damage for near-certain partial damage on every delayed run.
 *
 * ⚠️ NEVER hit the ?druh=/?destinace=/?kontinenty= filter URLs (also present under /zajezdy/ in
 * the sitemap): they are client-side-only AND partly robots-blocked (`Disallow: /zajezdy/?*&*`).
 * filterExoticTourUrls structurally rejects anything with a query string or an extra path segment.
 * Re-verified 2026-07-29: GET /zajezdy/?druh=first-minute renders 0 term rows and 0 prices, and the
 * /zeme/{country}/ landing pages list tour links but no price/date/nights either — there is no
 * page-size or listing lever on this site, the term table only exists on the detail page.
 *
 * Compliance (spec §16.4): robots.txt name-blocks ClaudeBot + sets Content-Signal ai-train=no.
 * The project deliberately proceeds with the standard Chrome UA (HttpClient's default) at low
 * cadence (1×/2 h) — the same §9 deviation accepted for FIRO (row 10) / Datour, for personal use.
 * Cloudflare is passive (200 on the Chrome UA; re-verified live 2026-07-29).
 *
 * Live verification 2026-07-29 (curl + full adapter run, standard Chrome UA, ≥3 s host gap):
 *  - GET /sitemap.xml (200, 367 972 B) → 2580 <loc>; 326 clean /zajezdy/{id}-{slug}/ detail pages,
 *    74 exotic after the stem rules below (72 + the `jizni-afric` spelling added at review). All 74
 *    slugs were re-checked one by one: no false positives, and no remaining unselected detail page
 *    names a country from config/watch.yaml's exotika profile. The sitemap also carries filter URLs
 *    (/zajezdy/?druh=…),
 *    detail sub-pages (/zajezdy/{id}-{slug}/galerie/, /dalsi-fotky/), theme pages
 *    (/zajezdy/dle-tematu/{id}-{slug}/) and other sections (/zeme/, /cestopisy/) — all rejected
 *    structurally.
 *  - GET /zajezdy/12666-reunion-a-mauricius-turistika-a-koupani/ (200) → single term
 *    "11. 11. – 23. 11. 2026", "13 dní", "-1%", 79 800 → 79 002 Kč, code 26591601; multi-country
 *    title → first known country Réunion; "10x hotel se snídaní" in "V ceně zahrnuto" → BB.
 *  - GET /zajezdy/12311-kapverdy-turistika-a-koupani/ (200) → "9. 11. – 19. 11. 2026", "11 dní",
 *    "-1%", 64 800 → 64 152 Kč, code 16811601, "9x hotel *** se snídaní" → BB. Previously
 *    unreachable twice over (past the old cap AND slug "kapverdy" only matched by the new stem).
 *  - GET /zajezdy/11893-havaj-velky-okruh-ctyrmi-ostrovy/ (200) → "V ceně zahrnuto" lists only
 *    "12x ubytování v apartmánech či hotelech" while "V ceně nezahrnuto" opens with "Stravování"
 *    → board 'none' (was 'unknown'; see boardFromTermsBlocks).
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
 *               isKnownCountry; the FIRST recognized canonical country wins. If nothing matches
 *               exactly, a second pass looks for the EXOTIC_SLUG_TOKENS stems in the slugified
 *               title — Czech declension only changes word endings, so "Treking na Réunionu" and
 *               "Silvestr v Kambodži" still resolve (they used to yield null). A third pass reads
 *               the URL slug, which catches titles that use a synonym ("Jižní Afrika" for the
 *               `jar` tour). Titles whose only exotic marker has no canonical country (Havaj/USA,
 *               Kostarika, Ekvádor, Galápagy…) stay null.
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
 *               autobus → bus, else unknown. board via normalizeBoard on the matched phrase; when
 *               the included prose names no meal at all AND "V ceně nezahrnuto" explicitly lists
 *               stravování, board is 'none' rather than 'unknown' (see boardFromTermsBlocks).
 *  - sourceOfferKey  offerKeyHash([td.code]) — the order number is unique per term.
 *  - url        the detail page URL passed in.
 *
 * stars/locality/departureAirport/priceTotal/omnibusLowestPrice/tourOperator are null (Adventura
 * sells its own guided expeditions; the detail term table exposes none of them).
 */

const BASE_URL = 'https://www.adventura.cz';
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;

/**
 * Hard per-run request ceiling for this adapter: 1 sitemap + MAX_DETAILS tour pages. Sized against
 * run.ts's ADAPTER_FETCH_TIMEOUT_MS (240 s) and the 3 s per-host politeness gap: a full 40-request
 * run measured 160.5 s live on 2026-07-29 (≈4.0 s per request incl. fetch), leaving ~80 s of
 * margin. An adapter that overruns the timeout is recorded 'failed' and its whole source vanishes
 * from the board, which is strictly worse than partial coverage — so this constant exists to stop a
 * future catalogue/token change from silently exploding the crawl. Raising it REQUIRES a fresh
 * wall-clock measurement, not arithmetic.
 */
export const MAX_REQUESTS_PER_RUN = 40;

/** Tour detail pages fetched per scan (MAX_REQUESTS_PER_RUN minus the one sitemap GET). */
export const MAX_DETAILS = MAX_REQUESTS_PER_RUN - 1;

/**
 * How often the rotating detail window advances. Matches the scan cadence
 * (.github/workflows/scan.yml cron "0 every-2-hours") so two consecutive scans land in two consecutive
 * windows — which is what keeps every offer inside ingest.ts's MAX_MISSES = 2 budget.
 */
export const ROTATION_PERIOD_MS = 2 * 60 * 60 * 1000;

/**
 * Exotic country stems → the canonical country the tour belongs to (null = genuinely exotic and
 * worth crawling, but the country is outside core/normalize.ts's COUNTRIES dictionary, so the
 * offer's `country` stays null by design).
 *
 * Stems, not full names, and matched at the START of a slug word: Czech declension only ever
 * changes the ENDING ("kapverdy" → "na-kapverdach", "maledivy" → "po-maledivach", "indonesie" →
 * "indonesky", "réunion" → "na-reunionu"). The old list matched full nominatives as bare
 * substrings and therefore missed six live tours before any cap even applied (audit 2026-07-29
 * finding 4). Anchoring at the word start also removes the substring false positives the old rule
 * had to live with (e.g. "vikendovy" contains "ken").
 *
 * The lone exception is `jar` (Jihoafrická republika, an acronym), matched at BOTH ends — a
 * start-anchored stem would still fire on "jarni" (spring), e.g. "…-hory-a-pobrezi-jarni-andalusie".
 */
const EXOTIC_COUNTRY_BY_TOKEN: Record<string, string | null> = {
  nepal: 'Nepál',
  vietnam: 'Vietnam',
  'sri-lanka': 'Srí Lanka',
  srilanka: 'Srí Lanka',
  tanzani: 'Tanzanie',
  zanzibar: 'Zanzibar',
  kambodz: 'Kambodža',
  kuba: 'Kuba',
  filipin: 'Filipíny',
  peru: 'Peru',
  kena: 'Keňa',
  keni: 'Keňa',
  thajsk: 'Thajsko',
  seychel: 'Seychely',
  reunion: 'Réunion',
  mexik: 'Mexiko',
  dominik: 'Dominikánská republika',
  indone: 'Indonésie',
  bali: 'Indonésie',
  mauric: 'Mauricius',
  malediv: 'Maledivy',
  kapverd: 'Kapverdy',
  japons: 'Japonsko',
  madagaskar: 'Madagaskar',
  namibi: 'Namibie',
  jihoafric: 'Jihoafrická republika',
  jar: 'Jihoafrická republika',
  // Third spelling of the same watched country. Adventura publishes JAR tours under all three:
  // "jihoafricka-republika-…", "jar-…" and "…-v-jizni-africe-…". Verified live 2026-07-29, the
  // third spelling matched NEITHER of the other two stems, so both of its tours were still
  // unreachable after the declension fix — and "Jižní Afrika" is likewise absent from COUNTRIES,
  // so their titles resolved country: null too:
  //   /zajezdy/12891-silvestr-v-jizni-africe-vinice-a-np-kruger/    1 term, 96 806 Kč, -3 %
  //   /zajezdy/11883-safari-a-turistika-v-jizni-africe-draci-hory/  3 terms, 75 648–79 800 Kč
  // Two hyphenated words are fine: tokenIndexIn anchors the whole stem at a word start, so this
  // fires on "-jizni-africe-" but not on a bare "jizni-…" ("jizni-vietnam-…" stays Vietnam).
  'jizni-afric': 'Jihoafrická republika',
  // Long-haul exotics with no canonical country in COUNTRIES — crawled for the dashboard/market
  // reference data, but they can never match a watch profile (country filter), hence null.
  galapag: null,
  ekvador: null,
  havaj: null,
  kostarika: null,
  panama: null,
};

/** Country-slug stems that mark a /zajezdy/{id}-{slug}/ tour as exotic (see the map above). */
export const EXOTIC_SLUG_TOKENS = Object.keys(EXOTIC_COUNTRY_BY_TOKEN);

// Tokens that must match at a hyphen/word boundary on BOTH ends rather than only at a word start.
const WORD_BOUNDARY_TOKENS = new Set<string>(['jar']);

/** Only a clean tour detail: /zajezdy/{digits}-{slug}/ with no query and no extra path segment. */
const DETAIL_URL_RE = /^https:\/\/www\.adventura\.cz\/zajezdy\/\d+-([a-z0-9-]+)\/?$/;

/** Lowercase, diacritics-free, hyphen-joined form of any text — i.e. the site's own slug shape.
 *  Lets one matcher serve both URL slugs and tour titles ("Treking na Réunionu" →
 *  "treking-na-reunionu"). Idempotent on an existing slug. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
}

/** Index of `token` in `slug` at a word start (or at both boundaries for WORD_BOUNDARY_TOKENS), or -1. */
function tokenIndexIn(slug: string, token: string): number {
  const re = WORD_BOUNDARY_TOKENS.has(token)
    ? new RegExp(`(?:^|-)(${token})(?:-|$)`)
    : new RegExp(`(?:^|-)(${token})`);
  const m = re.exec(slug);
  return m ? m.index + m[0].indexOf(m[1]!) : -1;
}

function slugIsExotic(slug: string): boolean {
  return EXOTIC_SLUG_TOKENS.some((token) => tokenIndexIn(slug, token) >= 0);
}

/**
 * From a sitemap.xml body, returns the deduplicated, lexicographically-sorted list of exotic tour
 * detail URLs (/zajezdy/{id}-{slug}/ whose slug carries an EXOTIC_SLUG_TOKENS stem). Pure; the
 * MAX_DETAILS window is applied by the caller (fetchOffers → selectDetailWindow). Filter URLs
 * (query strings), detail sub-pages and category/other-section pages are all rejected by
 * DETAIL_URL_RE. The sort only provides a STABLE ordering for the rotation to walk — it carries no
 * relevance meaning (it is ascending tour id, i.e. catalogue age), which is exactly why a fixed
 * prefix of it was the wrong selection.
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

export interface DetailWindow {
  targets: string[];
  windowIndex: number;
  windowCount: number;
}

/**
 * The MAX_DETAILS-sized slice of `urls` this run is responsible for. Consecutive scans walk
 * consecutive, non-overlapping windows and wrap around, so the whole catalogue is covered in
 * `windowCount` runs at a constant request budget. The index comes from wall clock rather than
 * state because adapters get no run counter and no DB handle; ROTATION_PERIOD_MS equals the scan
 * cadence, so run N and run N+1 fall in different buckets (a scan delayed by <2 h still does).
 */
export function selectDetailWindow(urls: string[], nowMs: number, size: number = MAX_DETAILS): DetailWindow {
  const windowCount = Math.max(1, Math.ceil(urls.length / size));
  const windowIndex = ((Math.floor(nowMs / ROTATION_PERIOD_MS) % windowCount) + windowCount) % windowCount;
  const start = windowIndex * size;
  return { targets: urls.slice(start, start + size), windowIndex, windowCount };
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
 * Country from the tour title (then p.sub). Pass 1 is a left-to-right n-gram scan gated by
 * isKnownCountry: the first recognized canonical country wins, and n-grams (up to 3 words) let
 * multi-word canonical names ("Srí Lanka") resolve. Pass 2 (added 2026-07-29) re-reads the title
 * as a slug and takes the LEFTMOST EXOTIC_COUNTRY_BY_TOKEN stem, which is what rescues Czech
 * declined forms ("Treking na Réunionu" → Réunion, "Silvestr v Kambodži" → Kambodža) that pass 1
 * cannot match exactly. Both passes preserve "first country of a multi-country title wins"
 * ("Réunion a Mauricius" → Réunion). No recognized country → null.
 */
function countryFromText(text: string): string | null {
  const words = text.split(/[^\p{L}]+/u).filter((w) => w.length > 0);
  for (let i = 0; i < words.length; i += 1) {
    for (let n = Math.min(3, words.length - i); n >= 1; n -= 1) {
      const phrase = words.slice(i, i + n).join(' ');
      if (isKnownCountry(phrase)) return normalizeCountry(phrase);
    }
  }
  return exoticCountryIn(slugify(text));
}

/**
 * Leftmost EXOTIC_COUNTRY_BY_TOKEN stem in an already-slugified string → its canonical country.
 * Tokens whose country is null (Havaj, Kostarika, Ekvádor, Galápagy…) are skipped rather than
 * treated as a hit, so a tour outside COUNTRIES keeps `country: null` instead of guessing.
 */
function exoticCountryIn(slug: string): string | null {
  let bestAt = Infinity;
  let best: string | null = null;
  for (const [token, country] of Object.entries(EXOTIC_COUNTRY_BY_TOKEN)) {
    if (country === null) continue; // exotic marker without a canonical country — never a match
    const at = tokenIndexIn(slug, token);
    if (at >= 0 && at < bestAt) {
      bestAt = at;
      best = country;
    }
  }
  return best;
}

/** Transport keywords from the "V ceně zahrnuto" (price-included) prose of graybox.terms. */
function transportFrom(includedText: string): Transport {
  const t = includedText.toLowerCase();
  if (/leten|letec|letadl/.test(t)) return normalizeTransport('letecky');
  if (/autobus/.test(t)) return normalizeTransport('autobus');
  return 'unknown';
}

/** Board keyword scan over one prose block; null = the block names no meal arrangement at all. */
function boardFromText(text: string): Board | null {
  const t = text.toLowerCase();
  if (/all\s*inclusive/.test(t)) return normalizeBoard('all inclusive');
  if (/pln[áou]\s*penz/.test(t)) return normalizeBoard('plna penze');
  if (/polopenz/.test(t)) return normalizeBoard('polopenze');
  if (/sníd|snid/.test(t)) return normalizeBoard('snidane');
  if (/bez\s*strav/.test(t)) return normalizeBoard('bez stravovani');
  return null;
}

/**
 * Board from the two labelled prose blocks of div.graybox.terms.
 *
 * "V ceně zahrnuto" is the only trustworthy meal source (Nepal's "snídaně lze zakoupit" lives in
 * the NOT-included block and must not read as BB). But feeding only that block meant a page that
 * explicitly sells the tour WITHOUT meals could never resolve: its included prose simply never
 * mentions food, so board came out 'unknown' where 'none' is the truth (audit finding 6, e.g.
 * /zajezdy/11893-havaj-velky-okruh-ctyrmi-ostrovy/ — included lists only "12x ubytování …", while
 * "V ceně nezahrnuto" opens with "Stravování"). So: no meal named in the included block AND the
 * included block says nothing about stravování at all AND the not-included block does → 'none'.
 * The extra "included mentions no strav*" guard keeps pages that phrase meals as "stravování dle
 * programu" (meals ARE included, just not as a named board) out of the 'none' bucket.
 */
function boardFromTermsBlocks(included: string, includedIsLabelled: boolean, excluded: string): Board {
  const fromIncluded = boardFromText(included);
  if (fromIncluded !== null) return fromIncluded;
  if (!includedIsLabelled || !excluded) return 'unknown';
  if (/strav/i.test(included)) return 'unknown';
  return /strav/i.test(excluded) ? normalizeBoard('bez stravovani') : 'unknown';
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
  // Last resort: the operator's own URL slug. It is what selected this page in the first place and
  // it sometimes names the country the prose does not — /zajezdy/12469-jar-kapske-mesto-…/ is
  // titled "Jižní Afrika – Kapské Město…", a synonym absent from COUNTRIES, so title+sub both yield
  // null while the slug says `jar` = Jihoafrická republika (a watched exotika country).
  const detailSlug = DETAIL_URL_RE.exec(url)?.[1] ?? '';
  const country =
    countryFromText(title) ?? (sub ? countryFromText(sub) : null) ?? (detailSlug ? exoticCountryIn(detailSlug) : null);

  // Transport/board are page-level (shared by every term); read from the terms prose blocks.
  const labelledIncluded = extractTermsBlock($, 'zahrnuto');
  const includedText = labelledIncluded || cleanText($('div.graybox.terms').first().text());
  const transport = transportFrom(includedText);
  const board = boardFromTermsBlocks(includedText, labelledIncluded !== '', extractTermsBlock($, 'nezahrnuto'));

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
 * Text of one labelled block inside div.graybox.terms — 'zahrnuto' for "V ceně zahrnuto:" (the
 * reliable board/transport source), 'nezahrnuto' for "V ceně nezahrnuto:". Adventura repeats each
 * block in a print-hide `.row` (fourth/three-fourths columns) and a print-show `<li>`; we take the
 * first `.three-fourths` following the matching label. Returns '' when the block is absent — the
 * caller decides whether to fall back to the whole terms prose (safe for transport, NOT for board:
 * the unlabelled fallback mixes the included and not-included text together).
 */
function extractTermsBlock($: cheerio.CheerioAPI, kind: 'zahrnuto' | 'nezahrnuto'): string {
  let found = '';
  $('div.graybox.terms .row').each((_, el) => {
    const row = $(el);
    const label = cleanText(row.find('.fourth, .headline').first().text()).toLowerCase();
    const isNegated = label.includes('nezahrnuto');
    if (!label.includes('zahrnuto')) return undefined;
    if (isNegated !== (kind === 'nezahrnuto')) return undefined;
    found = cleanText(row.find('.three-fourths, .content').first().text());
    return false; // stop at the first match
  });
  return found;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  // Without the sitemap there is nothing to scan → let a sitemap failure propagate (runScan then
  // records this source 'failed' rather than degrading to [] and flipping known offers inactive).
  const sitemapXml = await ctx.http.text(SITEMAP_URL);

  const exoticUrls = filterExoticTourUrls(sitemapXml);
  const { targets, windowIndex, windowCount } = selectDetailWindow(exoticUrls, Date.now());
  if (windowCount > 1) {
    ctx.log(
      `adventura: ${exoticUrls.length} exotic tour URLs, rotating window ${windowIndex + 1}/${windowCount} ` +
        `(${targets.length} details now; the other ${exoticUrls.length - targets.length} are covered by the next ${windowCount - 1} run(s))`,
    );
  }
  if (windowCount > 2) {
    // A 3+ run cycle means some offer misses two scans in a row, and ingest.ts deactivates at
    // MAX_MISSES = 2 → the board would flap. Surface it loudly instead of silently degrading.
    ctx.log(
      `adventura: WARNING catalogue needs ${windowCount} runs per full pass (>2) — offers will flap inactive; ` +
        `raise MAX_REQUESTS_PER_RUN only if the wall clock still fits ADAPTER_FETCH_TIMEOUT_MS, else narrow EXOTIC_SLUG_TOKENS`,
    );
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
