import * as cheerio from 'cheerio';
import type { Board, NormalizedOffer, SourceAdapter, SourceContext, Transport } from '../core/types.js';
import { normalizeBoard, normalizeCountry, isKnownCountry, parseCzk, parseCzDate, offerKeyHash } from '../core/normalize.js';
import { dayDiff } from '../core/dates.js';
import { SourceBlockedError } from '../core/http.js';

/**
 * ESO travel (esotravel.cz; exotika.cz is a 301 alias) — an established Czech exotic/long-haul
 * specialist (Thailand, Maldives, USA, Polynesia, expedition cruises…), spec §16.1 row 14.
 * Classic PHP SSR; offer cards are server-rendered in the listing HTML.
 *
 * PAGINATION — the 2026-07-07 header claim that "Načíst další only reveals already-embedded cards"
 * was FALSE and cost this source ~77 % of its inventory (audit docs/audits/per-adapter/esotravel.md).
 * `/js/redesign/pageloader.js` implements the button as `$.ajax({url: path + '?strana=' + page})`,
 * slicing `<!-- startresults {feedId} --> … <!-- endresults -->` out of the response and stopping on
 * `<!-- feed_end -->`. EVERY feed panel serves exactly 15 cards per page, so a single GET can never
 * see more than 15 offers per panel. We now walk `?strana=N`.
 *
 * IMPORTANT SOURCE PECULIARITY: ESO publishes NO crossed-out prices and NO discount percentages
 * anywhere (it positions on absolute "od X Kč" pricing) → claimedOriginalPrice/claimedDiscountPct
 * are ALWAYS null here, and price-drop detection for this source comes purely from our own
 * price snapshots keyed by sourceOfferKey. For that to work the key MUST be price-independent —
 * see the key strategy below.
 *
 * Live recon 2026-07-29 (curl, standard Chrome UA, ≥3 s host gap; robots.txt fully permissive):
 *  - `/dovolena/zajezdy/` is the site's GLOBAL catalogue page and it renders BOTH feed panels at
 *    once (`panel-feed-poznavaci` + `panel-feed-pobytove`), and `?strana=N` advances BOTH → 30
 *    cards per request instead of 15. That is the single best coverage lever available: it is the
 *    reason ~264 priced offers fit in ~13 requests. (`/dovolena/{slug}/zajezdy/zajezdy/` country
 *    listings serve the SAME cards 15 at a time, so they are no longer fetched at all; the old
 *    10-slug list also skewed to sold-out beach destinations — mauritius 17 cards/1 priced,
 *    zanzibar 2/0, seychely 19/2.)
 *  - Both global feeds order PRICED cards first and sold-out/"na vyžádání" ones after, so a page
 *    past the priced window parses to ZERO offers and stops the walk: tours run out after
 *    `?strana=7`, stays after `?strana=10`, and `?strana=11` is the all-sold-out page that ends it
 *    (12 requests, 263 priced offers, up to 2 767 000 Kč — re-measured 2026-07-29).
 *  - `/last-minute/` (15 + 9 priced cards, `feed_end` on page 1) and `/first-moment/` (15 + 9,
 *    `feed_end` on page 1, carries the cheapest offer on the site at 32 490 Kč) are curated deal
 *    feeds — 2 requests each. They overlap the catalogue heavily (last-minute page 0 contributed
 *    exactly 1 offer the catalogue did not have), which is why the per-feed stop below counts
 *    novelty WITHIN the feed and not against the globally-deduped set.
 *  - NO page-size parameter exists: `?pocet=60` (and friends) is ignored, 15/panel is hard-coded.
 *  - Card anatomy is unchanged from 2026-07-07: each `div.listview.primary` holds TWO alternate
 *    layouts of the SAME offer — a `.visible` block (image + .tour-type + h2 + .detail-date +
 *    a.term-price with span.days + div.price strong) and a `.hidden` list layout that adds `.place`
 *    (`<em>Country</em> | <em>Locality</em>`) and `.popis` (board). One card = ONE offer.
 *
 * Field mapping (all selectors observed live 2026-07-29):
 *  - title      `.visible h2` minus its `<sup>` star icons; `<br>` inside h2 → space.
 *  - stars      `h2 i.fa-star` count + 0.5 per `i.fa-star-half`, CAPPED AT 5. ESO renders six
 *               `fa-star` glyphs for a few luxury resorts (Constance Halaveli) — out of range for a
 *               1-5 field — and uses a separate `fa-star-half` token that used to be dropped
 *               silently (3.5★ Thai hotels rounded down). `stars` is a REAL column, so .5 is safe.
 *  - country    from the CARD'S OWN URL slug (`/poznavaci/usa/…` → USA, `/pobytove/maledivy/…` →
 *               Maledivy) via ESO_COUNTRY_BY_SLUG, which is generated from the live sitemap's 149
 *               country slugs. This replaces the old "inherit the listing slug" rule that tagged
 *               cross-listed promo cards with the wrong country (13/62 offers disagreed with their
 *               own URL) and left every last-minute card null. Fallbacks: `.hidden .place` first
 *               `<em>` (stays), then `.tour-type span` — both gated by isKnownCountry.
 *  - locality   `.hidden .place` second `<em>` (Pattaya, Baa atol…); else `.tour-type span` when it
 *               is not the country itself.
 *  - departureDate  first day.month of the `.detail-date` range. The year is printed ONCE, at the
 *               END of the range — even for Dec→Jan wraps ("22. 12. - 03. 01. 2027" departs
 *               22.12.2026) — so a wrapped range gets year-1 for the start. See parseDateRange.
 *               ⚠️ NOT every `.detail-date` range is a term: season-priced stays (all Maldives, some
 *               Polynesia) show a PRICE-VALIDITY WINDOW there — "01. 05. - 31. 10. 2026" with
 *               "10 dní / 7 nocí", labelled "V období …" on the offer page — and the old code
 *               emitted its start as a departure date (2026-05-01, three months in the past, 24 %
 *               of the source's rows, exactly the DB's departureDate-NULL bucket). A range longer
 *               than the trip it prices is a window, not a departure → departureDate null.
 *  - nights     `span.days` "15 dní / 12 nocí" → 12.
 *  - pricePerPerson  `div.price strong`, e.g. "54 990" — the HTML stores an `&nbsp;` entity that
 *               cheerio's .text() decodes to U+00A0. ⚠️ parseCzk's whitespace-strip class contains
 *               only regular 0x20 spaces, so NBSP variants are normalized here BEFORE parseCzk (same
 *               pattern as deluxea). No parsable price ("vyprodáno"/"na vyžádání") → SKIP the card.
 *  - board      `.hidden .popis i.fa-utensils` + the text node after it → normalizeBoard. Present
 *               only on single-hotel stay cards; multi-hotel "2v1" stays put a combination list in
 *               `.popis` instead and tours have a description there, so board stays 'unknown' for
 *               them. The real board sits on the offer page ("12x ubytování se snídaní") — one GET
 *               per offer, ~250 GETs/scan, far outside the request budget → NOT recoverable here.
 *  - transport  'flight' for the whole source, departureAirport 'PRG'. ESO sells air-inclusive
 *               packages ex-Praha only; the card markup never says so (its `.tour-type` icon is
 *               `fab fa-fort-awesome` for stays AND tours, so the old "letecky" regex could never
 *               fire → transport unknown 100 %), but every offer page states it. Verified on four
 *               offers of three different shapes: pobytové Thailand (sea-breeze-resort-pattaya
 *               "leteckou přepravu Praha – Bangkok - Praha"), pobytové Maldives (constance-halaveli
 *               "Praha - Malé - Praha"), poznávací USA (usa-zapad-a-florida "leteckou přepravu a
 *               letištní poplatky", itinerary "1. den ODLET Z PRAHY") and even the Svalbard
 *               expedition cruise (spicberky-plavba "leteckou přepravu Praha – Oslo – Longyearbyen").
 *  - url        first `.visible a[href]`, absolutized against baseUrl, `#panel-terminy` hash stripped.
 *
 * sourceOfferKey strategy (price-independent BY DESIGN — a price change must keep the key stable
 * or our snapshot history, ESO's only price-drop signal, would reset on every drop):
 *  - poznávací:  `?termin={id}` — numeric term ids are site-global → offerKeyHash([termin]).
 *  - pobytové:   no termin; `?ha={hotelId}` + URL path identify the hotel offer
 *                → offerKeyHash([pathname, ha, departureDate, nights]).
 *  - neither:    offerKeyHash([pathname, departureDate, nights]).
 *
 * priceTotal is null (listings publish only the per-person "od" price). tourOperator null (ESO
 * sells its own tours; no per-offer operator on the card).
 */

const BASE_URL = 'https://www.esotravel.cz';

/**
 * HARD REQUEST BUDGET. run.ts aborts an adapter after ADAPTER_FETCH_TIMEOUT_MS (240 s) and
 * HttpClient enforces a 3 s per-host gap, so one request costs ~4 s wall clock and an adapter that
 * overruns is recorded 'failed' — strictly worse than partial coverage. 30 requests ≈ 130 s worst
 * case; the per-feed page caps below make 16+4+4 = 24 the highest reachable count, and the walk
 * stops itself at 16 (measured live 2026-07-29: 12 + 2 + 2). This cap exists so a site change (feeds
 * that never run out of priced cards, a `strana` param that starts being ignored) cannot silently
 * explode the request count.
 */
const MAX_REQUESTS = 30;

/**
 * Feeds walked per scan, in priority order — the budget is spent top-down, so the global catalogue
 * (30 cards/request, both panels) always gets served first. `maxPages` is a per-feed safety stop
 * well above the observed priced depth (stays end at strana=10, tours at 7, last-minute at 1).
 */
const FEEDS: ReadonlyArray<{ readonly label: string; readonly url: string; readonly maxPages: number }> = [
  { label: 'katalog', url: `${BASE_URL}/dovolena/zajezdy/`, maxPages: 16 },
  { label: 'last-minute', url: `${BASE_URL}/last-minute/`, maxPages: 4 },
  { label: 'first-moment', url: `${BASE_URL}/first-moment/`, maxPages: 4 },
];

/** Page 0 is the plain listing URL (what a browser loads); deeper pages use the site's own param. */
function feedPageUrl(baseUrl: string, page: number): string {
  return page === 0 ? baseUrl : `${baseUrl}?strana=${page}`;
}

/**
 * ESO URL slug → canonical Czech country name. Generated from the live sitemap 2026-07-29 (149
 * `/dovolena|/pobytove|/poznavaci|/last-minute/{slug}/` slugs, all covered). Canonical spellings
 * match normalize.ts's COUNTRY_BY_KEY where it knows the country, so config/watch.yaml profile
 * filters (exotika: Thajsko, Maledivy, Mauricius…) keep matching; the rest are ESO-only countries
 * that normalizeCountry has never heard of (USA, Čína, Austrálie…) and would otherwise be dropped.
 * Islands/regions resolve to their sovereign country (galapagy → Ekvádor, tahiti → Francouzská
 * Polynésie, rodrigues → Mauricius, azorske-ostrovy → Portugalsko, velikonocni-ostrov → Chile,
 * jizni-pol → Antarktida). `karibik` is deliberately absent: it is a region, not a country, and a
 * card under it always carries its real country in its own URL.
 */
const ESO_COUNTRY_BY_SLUG = new Map<string, string>([
  ['albanie', 'Albánie'],  ['alzirsko', 'Alžírsko'],  ['antarktida', 'Antarktida'],
  ['antigua-a-barbuda', 'Antigua a Barbuda'],  ['argentina', 'Argentina'],  ['arktida', 'Arktida'],
  ['armenie', 'Arménie'],  ['aruba', 'Aruba'],  ['australie', 'Austrálie'],
  ['azerbajdzan', 'Ázerbájdžán'],  ['azorske-ostrovy', 'Portugalsko'],  ['bahamy', 'Bahamy'],
  ['bahrajn', 'Bahrajn'],  ['barbados', 'Barbados'],  ['belize', 'Belize'],
  ['bhutan', 'Bhútán'],  ['bolivie', 'Bolívie'],  ['bonaire', 'Bonaire'],
  ['botswana', 'Botswana'],  ['brazilie', 'Brazílie'],  ['britske-panenske-ostrovy', 'Britské Panenské ostrovy'],
  ['bulharsko', 'Bulharsko'],  ['chile', 'Chile'],  ['cina', 'Čína'],
  ['cookovy-ostrovy', 'Cookovy ostrovy'],  ['curacao', 'Curaçao'],  ['dominika', 'Dominika'],
  ['dominikanska-republika', 'Dominikánská republika'],  ['egypt', 'Egypt'],  ['ekvador', 'Ekvádor'],
  ['emiraty', 'Spojené arabské emiráty'],  ['estonsko', 'Estonsko'],  ['etiopie', 'Etiopie'],
  ['faerske-ostrovy', 'Faerské ostrovy'],  ['fidzi', 'Fidži'],  ['filipiny', 'Filipíny'],
  ['finsko', 'Finsko'],  ['fr-guyana', 'Francouzská Guyana'],  ['francouzska-polynesie', 'Francouzská Polynésie'],
  ['galapagy', 'Ekvádor'],  ['gambie', 'Gambie'],  ['grenada', 'Grenada'],
  ['gronsko', 'Grónsko'],  ['gruzie', 'Gruzie'],  ['guadeloupe', 'Guadeloupe'],
  ['guatemala', 'Guatemala'],  ['honduras', 'Honduras'],  ['hongkong', 'Hongkong'],
  ['indie', 'Indie'],  ['indonesie', 'Indonésie'],  ['iran', 'Írán'],
  ['island', 'Island'],  ['italie', 'Itálie'],  ['izrael', 'Izrael'],
  ['jamajka', 'Jamajka'],  ['japonsko', 'Japonsko'],  ['jizni-afrika', 'Jihoafrická republika'],
  ['jizni-korea', 'Jižní Korea'],  ['jizni-pol', 'Antarktida'],  ['jordansko', 'Jordánsko'],
  ['kajmanske-ostrovy', 'Kajmanské ostrovy'],  ['kambodza', 'Kambodža'],  ['kamerun', 'Kamerun'],
  ['kanada', 'Kanada'],  ['kanarske-ostrovy', 'Kanárské ostrovy'],  ['kapverdy', 'Kapverdy'],
  ['katar', 'Katar'],  ['kena', 'Keňa'],  ['kolumbie', 'Kolumbie'],
  ['komory', 'Komory'],  ['kostarika', 'Kostarika'],  ['kuba', 'Kuba'],
  ['kypr', 'Kypr'],  ['laos', 'Laos'],  ['libanon', 'Libanon'],
  ['litva', 'Litva'],  ['lotyssko', 'Lotyšsko'],  ['madagaskar', 'Madagaskar'],
  ['madeira', 'Madeira'],  ['makedonie', 'Makedonie'],  ['malajsie', 'Malajsie'],
  ['malawi', 'Malawi'],  ['maledivy', 'Maledivy'],  ['malta', 'Malta'],
  ['maroko', 'Maroko'],  ['martinik', 'Martinik'],  ['mauritius', 'Mauricius'],
  ['mayotte', 'Mayotte'],  ['mexiko', 'Mexiko'],  ['mongolsko', 'Mongolsko'],
  ['mosambik', 'Mosambik'],  ['myanmar-barma', 'Myanmar'],  ['namibie', 'Namibie'],
  ['nepal', 'Nepál'],  ['nikaragua', 'Nikaragua'],  ['nizozemsko', 'Nizozemsko'],
  ['norsko', 'Norsko'],  ['nova-kaledonie', 'Nová Kaledonie'],  ['novy-zeland', 'Nový Zéland'],
  ['oman', 'Omán'],  ['palau', 'Palau'],  ['panama', 'Panama'],
  ['papua-nova-guinea', 'Papua-Nová Guinea'],  ['paraguay', 'Paraguay'],  ['peru', 'Peru'],
  ['portoriko', 'Portoriko'],  ['portugalsko', 'Portugalsko'],  ['recko', 'Řecko'],
  ['reunion', 'Réunion'],  ['rodrigues', 'Mauricius'],  ['rusko', 'Rusko'],
  ['rwanda', 'Rwanda'],  ['saudska-arabie', 'Saúdská Arábie'],  ['senegal', 'Senegal'],
  ['severni-korea', 'Severní Korea'],  ['severni-pol', 'Arktida'],  ['seychely', 'Seychely'],
  ['singapur', 'Singapur'],  ['spanelsko', 'Španělsko'],  ['spicberky', 'Špicberky'],
  ['sri-lanka', 'Srí Lanka'],  ['st-vincenc-a-grenadiny', 'Svatý Vincenc a Grenadiny'],  ['sudan', 'Súdán'],
  ['surinam', 'Surinam'],  ['svata-lucie', 'Svatá Lucie'],  ['svaty-bartolomej', 'Svatý Bartoloměj'],
  ['svaty-martin', 'Svatý Martin'],  ['tahiti', 'Francouzská Polynésie'],  ['tanzanie', 'Tanzanie'],
  ['tchaj-wan', 'Tchaj-wan'],  ['thajsko', 'Thajsko'],  ['tibet', 'Tibet'],
  ['tonga', 'Tonga'],  ['trinidad-a-tobago', 'Trinidad a Tobago'],  ['turecko', 'Turecko'],
  ['turkmenistan', 'Turkmenistán'],  ['turks-caicos', 'Turks a Caicos'],  ['uganda', 'Uganda'],
  ['ukrajina', 'Ukrajina'],  ['uruguay', 'Uruguay'],  ['usa', 'USA'],
  ['uzbekistan', 'Uzbekistán'],  ['velikonocni-ostrov', 'Chile'],  ['venezuela', 'Venezuela'],
  ['vietnam', 'Vietnam'],  ['yap', 'Mikronésie'],  ['zambie', 'Zambie'],
  ['zanzibar', 'Zanzibar'],  ['zimbabwe', 'Zimbabwe'],
]);

/** Strips zero-width chars and collapses whitespace (incl. NBSP) in card text. */
function cleanText(s: string): string {
  return s.replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parses a card price like "54 990" to integer CZK. parseCzk's own whitespace strip only
 * covers regular spaces, so NBSP/narrow-NBSP (and a defensive literal "&nbsp;") are normalized
 * to plain spaces first — verified against the live fixtures where the separator is U+00A0.
 */
function parsePrice(raw: string): number | null {
  return parseCzk(raw.replace(/&nbsp;|[  ]/g, ' '));
}

/**
 * Splits a `.detail-date` range ("01. 05. - 31. 10. 2026") into ISO start/end. The year is printed
 * ONCE, at the END of the range, and belongs to the END date; a range whose start month is greater
 * than its end month wraps the year boundary, so the start date gets year-1 (real card "SKRYTÁ TVÁŘ
 * THAJSKA": "22. 12. - 03. 01. 2027" departs 22.12.2026, returns 3.1.2027). Defensive: if a year is
 * ever printed per date, the first year found already belongs to the start date and is used as-is.
 * A single date with no range end yields end === null.
 */
function parseDateRange(text: string): { start: string | null; end: string | null } {
  const start = text.match(/(\d{1,2})\.\s*(\d{1,2})\./);
  const years = text.match(/\d{4}/g);
  if (!start || !years || years.length === 0) return { start: null, end: null };

  const rest = text.slice((start.index ?? 0) + start[0].length);
  const end = rest.match(/(\d{1,2})\.\s*(\d{1,2})\./);

  if (years.length >= 2) {
    // One year per date: the first year belongs to the first (start) date.
    return {
      start: parseCzDate(`${start[1]}.${start[2]}.${years[0]}`),
      end: end ? parseCzDate(`${end[1]}.${end[2]}.${years[1]}`) : null,
    };
  }

  const endYear = Number(years[0]);
  const wraps = end !== null && Number(start[2]) > Number(end[2]);
  return {
    start: parseCzDate(`${start[1]}.${start[2]}.${wraps ? endYear - 1 : endYear}`),
    end: end ? parseCzDate(`${end[1]}.${end[2]}.${endYear}`) : null,
  };
}

/**
 * True when a `.detail-date` range is a PRICE-VALIDITY WINDOW rather than a term. Season-priced
 * stays print the season the price is valid in ("V období 01. 05. – 31. 10. 2026" on the offer
 * page) in the same slot a tour prints its departure-return range, and its start is not a departure
 * date — emitting it produced 24 % long-past dates. A genuine term spans exactly the trip
 * (30. 10. → 13. 11. for "15 dní / 12 nocí" = 14 days), so a range longer than the trip it prices
 * (+2 days of slack for off-by-one printing) can only be a window. Unknown trip length → keep the
 * date; we only null what we can prove wrong.
 */
function isPriceValidityWindow(start: string | null, end: string | null, tripDays: number | null): boolean {
  if (start === null || end === null || tripDays === null) return false;
  return dayDiff(start, end) > tripDays + 2;
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

/**
 * Canonical country from an ESO slug or from a human label printed on the card ("Čína", "Jižní
 * Afrika"): the label is slugified the same way ESO builds its URLs (lowercase, diacritics
 * stripped, spaces → dashes) and looked up in the same table, so both spellings of a country
 * resolve to one canonical name. Falls back to normalize.ts's country set and otherwise returns
 * null rather than a guess — which is also what tells the caller a label is NOT a country and can
 * therefore be used as a locality.
 */
function countryFromLabel(raw: string): string | null {
  if (raw === '') return null;
  const slug = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return ESO_COUNTRY_BY_SLUG.get(slug) ?? (isKnownCountry(raw) ? normalizeCountry(raw) : null);
}

/**
 * Canonical country from the offer's OWN url path — `/poznavaci/usa/velky-okruh/` → 'USA',
 * `/pobytove/maledivy/hotel/…` → 'Maledivy'.
 */
function countryFromPath(pathname: string): string | null {
  const slug = pathname.match(/^\/(?:pobytove|poznavaci|last-minute|dovolena)\/([a-z0-9-]+)\//)?.[1];
  return slug === undefined ? null : countryFromLabel(slug);
}

function mapCard(card: ReturnType<cheerio.CheerioAPI>, baseUrl: string): NormalizedOffer | null {
  // Each card carries the SAME offer twice (.visible grid layout + .hidden list layout);
  // scope field extraction to .visible so nothing double-counts, with a defensive fallback.
  const visible = card.children('.visible').first();
  const scope = visible.length > 0 ? visible : card;

  // Price gate first: no parsable "od X Kč" (sold out / price on request) → skip.
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

  // Country: the card's own URL slug wins (works on every feed and never inherits a listing's
  // country onto a cross-listed promo card). `.place` <em>s are the stay-card fallback, the
  // `.tour-type span` the tour fallback — both gated so an unrecognized string never becomes a
  // country. `.place` also carries the locality (Pattaya, Baa atol…).
  const placeEms = card.find('.place em');
  const placeCountry = placeEms.eq(0).text().trim();
  const placeLocality = placeEms.eq(1).text().trim();
  const span = scope.find('.tour-type span').first().text().trim();

  const offerCountry = countryFromPath(parsedUrl.pathname) ?? countryFromLabel(placeCountry) ?? countryFromLabel(span);

  // The `.tour-type span` is a locality on stay cards (Pattaya, Raa Atol) but a country on tour
  // cards ("Čína", "Jižní Afrika") — anything that resolves to a country is never a locality.
  let locality: string | null = placeLocality !== '' ? placeLocality : null;
  if (locality === null && span !== '' && countryFromLabel(span) === null) locality = span;

  const daysText = scope.find('.days').first().text();
  const nightsMatch = daysText.match(/(\d+)\s*noc/i);
  const nights = nightsMatch?.[1] !== undefined ? Number(nightsMatch[1]) : null;
  const daysMatch = daysText.match(/(\d+)\s*dn/i);
  const tripDays = daysMatch?.[1] !== undefined ? Number(daysMatch[1]) : nights !== null ? nights + 1 : null;

  const range = parseDateRange(scope.find('.detail-date a').first().text());
  const departureDate = isPriceValidityWindow(range.start, range.end, tripDays) ? null : range.start;

  // Half-stars are a separate class token, and ESO renders six full stars for a few luxury
  // resorts — count both, cap at the 5 the field is defined for.
  const starPoints = scope.find('h2 i.fa-star').length + scope.find('h2 i.fa-star-half').length * 0.5;
  const stars = starPoints > 0 ? Math.min(5, starPoints) : null;

  const board = extractBoard(card);

  // Source-level constants, not card-derived: every ESO package is air-inclusive from Prague
  // (see the header's four verified offer pages). The card markup never states it.
  const transport: Transport = 'flight';

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
    departureAirport: 'PRG',
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
 * Parses one ESO travel feed page (the global catalogue, last-minute or first-moment; page 0 or any
 * `?strana=N`) to NormalizedOffer[]. Pure function: no I/O. Iterates `div.listview.primary` cards —
 * on the global catalogue page that is BOTH feed panels (tours + stays) at once. Country comes from
 * each card's own URL, so no listing-level country is needed. A card with "+ další období (N)"
 * yields ONE offer (the displayed nearest term). Dedupes by sourceOfferKey (first wins).
 */
export function parseEsoListing(html: string, baseUrl: string): NormalizedOffer[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  $('.listview.primary').each((_, el) => {
    const offer = mapCard($(el), baseUrl);
    if (!offer) return;
    if (seen.has(offer.sourceOfferKey)) return;
    seen.add(offer.sourceOfferKey);
    offers.push(offer);
  });

  return offers;
}

/** The site's own end-of-feed marker, emitted inside the results block of the last page. */
function hasFeedEnd(html: string): boolean {
  return html.includes('<!-- feed_end -->');
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;
  let requests = 0;
  let blocked = false;

  for (const feed of FEEDS) {
    if (blocked || requests >= MAX_REQUESTS) break;
    let consecutiveFailures = 0;
    // Novelty is tracked PER FEED for the stop decision, separately from the global `seen` used for
    // emission. The two questions are different: "has this feed run out of inventory" vs "have we
    // already got this offer from an earlier feed". Measured live 2026-07-29, `/last-minute/` page 0
    // held 15 priced cards of which only ONE was not already in the catalogue — a global-novelty
    // stop would abandon that feed at page 0 (losing page 1) after any reshuffle that covers that
    // last card. Per-feed novelty still catches the case this stop exists for: a `strana` param
    // that stops working re-serves page 0, whose keys are all already in `feedSeen` → stop.
    const feedSeen = new Set<string>();

    for (let page = 0; page < feed.maxPages; page += 1) {
      if (requests >= MAX_REQUESTS) {
        ctx.log(`esotravel: request budget ${MAX_REQUESTS} reached, stopping at ${feed.label} page ${page}`);
        break;
      }

      const url = feedPageUrl(feed.url, page);
      let html: string;
      requests += 1;
      try {
        html = await ctx.http.text(url);
        successCount += 1;
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof SourceBlockedError) {
          // Site is actively blocking us: stop issuing further GETs (politeness) but keep whatever
          // earlier pages yielded. Record the block as lastError so a block BEFORE the first success
          // still trips the successCount===0 rethrow below (→ BLOCKED marker → 24h backoff) instead
          // of silently degrading to [].
          lastError = err;
          blocked = true;
          ctx.log(`esotravel: ${url} blocked (${err.message}), stopping`);
          break;
        }
        lastError = err;
        consecutiveFailures += 1;
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`esotravel: ${url} failed (${message}), skipping`);
        // One flaky page must not cost us the rest of the feed (the deepest pages carry the top
        // price band), but a feed that keeps failing is dead — give up on it after two in a row.
        if (consecutiveFailures >= 2) break;
        continue;
      }

      let fresh = 0;
      for (const offer of parseEsoListing(html, BASE_URL)) {
        // Novelty within THIS feed drives the stop decision (see feedSeen above)…
        if (!feedSeen.has(offer.sourceOfferKey)) {
          feedSeen.add(offer.sourceOfferKey);
          fresh += 1;
        }
        // …while emission dedupes GLOBALLY: the same term surfaces on more than one feed (a
        // last-minute card is also in the global catalogue) and must be emitted only once.
        if (seen.has(offer.sourceOfferKey)) continue;
        seen.add(offer.sourceOfferKey);
        all.push(offer);
      }

      // Both stop signals matter: `feed_end` is the site's own marker, and a page with no offer this
      // feed has not already shown means either its priced cards ran out (they are ordered before
      // the sold-out ones, so a page of pure sold-out cards parses to zero offers) or that `strana`
      // stopped working and we are re-reading page 0 — neither may burn the rest of the budget.
      if (fresh === 0 || hasFeedEnd(html)) break;
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every GET failed: this is not "market empty" — rethrow (fischer/deluxea pattern) so runScan
    // records this source 'failed' rather than degrading to [] and flipping known offers inactive /
    // muting the health alert.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`esotravel: all ${requests} requests failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`esotravel: fetched ${all.length} offers in ${requests} requests (${successCount} ok)`);
  return all;
}

export const esotravel: SourceAdapter = {
  name: 'esotravel',
  fetchOffers,
};
