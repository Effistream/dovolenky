# Audit: firo (high)

## Shrnutí

firo.ts is a thin config over makeCesysAdapter: it issues 3 POSTs to https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12352 (customer_id 3593, transport_id ["1"], adults 2, rows_on_page 30, page 1 only, sort ['price asc','date_from asc']) — leto-more (0-60d, duration 7-22d, minNights>=6), last-minute (0-14d, duration 1-21d) and exotika (0-270d, duration 7-22d, minNights>=6, country_id = 12 exotic ids) — then enriches hotel names from www.firotravel.cz/sitemap.xml + up to 40 /detail-zajezdu/x/<id>a redirect lookups. Live run: 50 offers in 133s, price 7,871–22,455 CZK, all flight, names 100% resolved, and every scalar field I checked against the site is correct (price really is per person, dates/nights/board/country/stars/airport all match). Two things are not healthy. (1) The exotika query — the documented reason this adapter exists — returns exactly ONE country and ONE hotel out of the 12 exotic countries requested; the multi-country country_id filter demonstrably breaks the price-asc sort server-side, so it returns neither the exotic destinations nor even UAE's cheapest rows. Maldives (from 40,690 CZK), Thailand (from 18,880), Mauritius, Mexico, Dominican, Seychelles, Sri Lanka, Tanzania, Cuba, Vietnam and Cape Verde inventory all exists on this client_id and never reaches the board; the entire >22,455 CZK price band is absent. (2) All 50 offers carry url = the generic fallback search page, so every firo row on the board is a dead link even though the adapter already fetches the canonical deep link and throws it away.

## Nálezy k opravě

### 1.

EXOTIKA QUERY IS EFFECTIVELY BROKEN — 1 of 12 requested countries comes back. src/sources/firo.ts:45 passes 12 exotic country ids in one dates-list body. Live replay of the adapter's exact exotika body (date 2026-07-29..2027-04-25, duration 7-22, adults 2, transport 1, 30 rows, price asc) returned results=7,598,906 but all 30 rows were country 198 (SAE), master_id 6564 (Sheraton Jumeirah Beach Resort & Towers), 19,975–22,455 CZK. After the minNights>=6 client filter only 9 offers survive — one hotel. Zero Thailand/Maldives/Mauritius/Mexico/Dominican/Seychelles/Sri Lanka/Tanzania/Cuba/Vietnam/Cape Verde rows have ever a chance of appearing.

### 2.

THE MULTI-COUNTRY FILTER BREAKS PRICE-ASC SORTING SERVER-SIDE (root cause of the above, reproducible). Same window/duration, only the country_id array length changes: country_id:["198"] → cheapest 14,755 CZK (master 301746); country_id:["198","220"] → cheapest 14,755 CZK (same row, correct OR + correct sort); country_id:["220","131","138","198"] → cheapest 19,975 CZK (master 6564); the full 12-id list → cheapest 19,975 CZK. A superset of rows cannot have a HIGHER minimum under a correct price-asc sort, so with >=4 country ids the API stops returning the global cheapest page. Consequence: even the UAE rows firo does publish are ~5,200 CZK above the real cheapest UAE offer the site sells. A per-country (or <=2-country) loop returns correct, cheapest-first results.

### 3.

WHOLE PRICE BAND MISSING: adapter max = 22,455 CZK. The site's /exotika page advertises Maldives, Mauricius, Thajsko, Zanzibar, Panama, Omán, Bahrajn, Katar, Keňa, Kambodža, Vietnam, Dominikánská republika, Mexiko, Kapverdy for 2026/27, and the same API confirms real inventory: country_id:["131"] (Maledivy) → results=2,048,250, cheapest 40,690 CZK; country_id:["220"] (Thajsko) → results=1,360,959, cheapest 18,880 CZK. None of it reaches the board.

### 4.

EVERY OFFER URL IS THE GENERIC FALLBACK SEARCH PAGE — 50/50 offers had url = https://www.firotravel.cz/vyhledavani-zajezdu/ (distinct urls: 1). The sitemap map (src/sources/cesys.ts parseAccommodationsSitemap) matched none of the returned master_ids, and resolveUnknownHotelNames (src/sources/cesys.ts:622-686) fetches https://www.firotravel.cz/detail-zajezdu/x/<id>a — which 301s to the canonical deep link — but only writes `offer.title`, never `offer.url`. I confirmed the redirect targets exist and are correct: /detail-zajezdu/x/185781a → https://www.firotravel.cz/detail-zajezdu/bulharsko/admiral-plaza/185781a, /detail-zajezdu/x/6564a → https://www.firotravel.cz/detail-zajezdu/spojene-arabske-emiraty/sheraton-jumeirah-beach-resort-towers/6564a. HttpClient.text() (src/core/http.ts:61) discards `response.url`, so the deep link is fetched and thrown away. Every firo click-through on the board lands on an empty search form.

### 5.

LOW DIVERSITY IN THE MAIN QUERY: leto-more returned results=5,855,470 but its 30-row page covers only 4 distinct hotels (3 Bulgarian: Admiral Plaza / Ivana Palace / Obzor Beach Resort = 29 of 30 rows, + 1 Greek). last-minute is healthier (15 hotels). Since page is hardcoded to 1 and more_exists is true on every query, the adapter reads 90 rows total per scan.

### 6.

locality is always null (0/50) even though it is available for free: the detail page the adapter already fetches carries it in the ld+json LodgingBusiness (addressLocality "Burgas" for 185781, "Dubaj" for 6564) and in the breadcrumb ("Bulharsko » Burgas » Slunečné Pobřeží"). Note /mapping/destinations does NOT exist (HTTP 404), so the row's `destination` id cannot be resolved that way — the detail page is the practical source.

### 7.

buildDatesListBody (src/sources/cesys.ts:469) hardcodes composition:{adults:2} and ignores ctx.adults. Harmless while config scan.adults stays 2, but the adapter silently reports prices for a party size other than the one configured if that ever changes.

### 8.

sourceOfferKey = offerKeyHash([master_id, date_from, duration_night, boarding_id]) (src/sources/cesys.ts:405) omits tour_operator/room_id. Two tour operators selling the same hotel/date/nights/board collapse to one row (first wins, i.e. cheapest under price-asc) — acceptable for a deals board, but it silently hides a competing operator's price.

## Důkazy z auditu

READ: src/sources/firo.ts (whole file), src/sources/cesys.ts (whole file, the actual implementation), src/core/http.ts, src/core/types.ts, src/core/normalize.ts.

LIVE ADAPTER RUN (throwaway ./._audit_firo.mts, npx tsx, since deleted; HttpClient default Chrome UA): 50 offers in 133.4s. pricePerPerson min/median/max = 7,871 / 11,690 / 22,455 CZK. Countries: Bulharsko 23, SAE 9, Turecko 6, Egypt 6, Řecko 5, Itálie 1. Boards: BB 23, none 12, AI 12, HB 3. Transport: flight 50/50. Airports: OSR 17, BRQ 15, PRG 13, VIE 4, BTS 1. Nights 3–10. Departure dates 2026-08-01..2026-09-16. stars non-null 50/50 (values 2,3,4,5). locality non-null 0/50. priceTotal non-null 0/50. claimedDiscountPct non-null 0/50. placeholder "Hotel <id>" titles 0/50. distinct urls = 1 (fallback) / 50 offers on fallback. tourOperators: TUI, Fischer CK, Join UP, Eximtours, Čedok, Brenna, Coral Travel.

RAW API PROBES (curl, Chrome UA, >=3s gap, POST https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12352&lang=cs, bodies byte-identical to buildDatesListBody):
- leto-more body → results 5,855,470, more_exists true, 30 rows, 4 distinct master_ids ((35,61838)x14, (35,10190)x8, (35,185781)x7, (183,211504)x1), price 7,870.6–10,840.2.
- last-minute body → results 335,143, 30 rows, 15 distinct hotels, price 9,890–13,790.
- exotika body (12 country ids) → results 7,598,906, 30 rows, ALL (198, 6564), price 19,975–22,455, nights 5–6, dates 2026-08-31..2026-09-25.
- country_id ["131"] → results 2,048,250, 30 rows, all master 6458, 40,690–42,705 CZK.
- country_id ["220"] → results 1,360,959, 30 rows, all master 343727, 18,880–19,630 CZK.
- SORT-BREAK ISOLATION, identical window/duration, only array length varies: ["198"] → 14,755 (m 301746); ["198","220"] → 14,755 (m 301746); ["220","131","138","198"] → 19,975 (m 6564); ["220","131","138","198","46","142"] → 19,975; full 12 → 19,975. Superset with a higher minimum = broken sort.
- PER-PERSON CONFIRMATION, country 198, 2026-09-01..2026-09-10: adults=1 cheapest 14,070 CZK (master 170923, 5n, Snídaně); adults=2 cheapest for that same master 12,290 CZK (6n, Snídaně). A couple's total would be ~2x the solo figure — it is lower, i.e. a single supplement on a PER-PERSON price. price_total was null on every row observed, matching the adapter leaving priceTotal null. discount/discount_percent null on every row, matching claimed* null.

FIELD CHECK VS THE OFFER'S OWN PAGE:
- Offer "Admiral Plaza", 7,871 CZK, 2026-09-01, 7 nights, board none, OSR, 4*, Bulharsko, TUI. Raw row: master_id 185781, price_from.CZK 7870.6 (→ round 7871 ✓), date_from 2026-09-01 ✓, duration_night 7 ✓, boarding "Bez stravy" → normalizeBoard 'none' ✓, airport_code "OSR" ✓, rating 4.0 ✓, country 35. Page https://www.firotravel.cz/detail-zajezdu/bulharsko/admiral-plaza/185781a: h1 "Admiral Plaza", ld+json LodgingBusiness starRating.ratingValue 4, addressCountry "Bulharsko", addressLocality "Burgas", breadcrumb "Bulharsko » Burgas » Slunečné Pobřeží". All adapter fields match; locality is on the page but dropped.
- Offer "Sheraton Jumeirah Beach Resort & Towers", 21,440–22,455 CZK, 6 nights, BB, PRG/VIE, 5*, SAE, Coral Travel. Raw row: master_id 6564, boarding "Snídaně" → 'BB' ✓, rating 5.0 ✓, country 198. Page https://www.firotravel.cz/detail-zajezdu/spojene-arabske-emiraty/sheraton-jumeirah-beach-resort-towers/6564a: h1 matches, ld+json starRating 5, addressCountry "Spojené arabské emiráty", addressLocality "Dubaj", headline "od 20 389 Kč / za osobu" — explicitly per person, and the detail page's own term widget calls the same api-ng.cesys.eu endpoint the adapter uses, so the adapter's prices are the site's own prices.
- Detail-page term tables are rendered client-side (no "2026-09-01" or price strings in the HTML), so per-term verification was done against the same API the site's own JS calls.

SITE COVERAGE REFERENCE: https://www.firotravel.cz/ nav has "Exotika 2026/27"; https://www.firotravel.cz/exotika lists Omán, SAE, Bahrajn, Kapverdy, Egypt, Keňa, Kambodža, Vietnam, Dominikánská republika, Maledivy, Mauricius, Mexiko, Thajsko, Panama, Zanzibar, Katar. robots.txt (fetched) does not disallow /detail-zajezdu; it does disallow /online/ on the storefront host (not the api-ng host).

## Adversariální ověření

- **VYVRÁCENO — neopravovat** (low): REFUTED — false-positive category (c), intentional design documented in the file header and the project spec, plus a factually false central claim.

INDEPENDENT REPRODUCTION (my own probes, Chrome UA, 3.5s gaps, body re-implemented verbatim from buildDatesListBody in /Users/daniel/Library/CloudStorage/OneDrive-Osobni/Effistream/dovolenky/src/sources/cesys.ts): exotika-12 → HTTP 200, results 7,598,906, 30 rows, ALL country 198 / master 6564, 19,975–22,455 CZK, dates 2026-08-31..09-25; ["131"] → 40,690 (master 6458); ["220"] → 18,880 (master 343727); ["198"] alone → 14,755 (master 301746); 4-id superset → 19,975 (master 6564). mapping/countries: 198 = "Spojené arabské emiráty", 131 = Maledivy, 220 = Thajsko. Every reported number reproduces. The dispute is interpretation, not data.

WHY THE DEFECT FALLS:

1. The central claim "None of it reaches the board" is empirically false. All 30 exotika rows are country 198 = SAE — one of the countries the site's own /exotika page advertises, and one of the 24 countries in the `exotika` watch profile in config/watch.yaml, at 19,975–22,455 CZK, far under that profile's max_price_per_person: 60000. The auditor's own adapter run shows 9 SAE offers landing on the board. Genuine exotic long-haul from the exotika query does reach the board; it is the more expensive exotic countries that do not.

2. The price ceiling is arithmetic, not a defect. I checked price monotonicity on every response: prices are strictly ascending in all five probes, i.e. the 30-row page is a true cheapest-first slice. With price-asc + rows_on_page 30 + a single page pooled over 12 countries whose cheapest country (SAE) starts at ~20k, a 40,690 CZK Maldives row can never appear. No filter, price cap (price.from 0 / to 999999), country mapping, or sort parameter is broken. The auditor's own field-by-field check against firotravel.cz confirms every mapped field is correct — this is a sampling width question, not a data-correctness one.

3. It is documented intentional design, twice over. firo.ts line 50: "All flight-only, sorted price asc, 30 rows/page." cesys.ts lines 59–83 ("Query-quality probe results") explicitly analyses this exact phenomenon — "price-asc sorting then concentrates on whichever single AI-boarded hotel is cheapest at each duration" — and records the tradeoff as a conscious decision. docs/superpowers/specs/2026-07-04-dovolenky-design.md §16.2 prescribes exactly one pooled exotika query with the full exotic country-id list, +270d window, duration 7–22, minNights 6 — which is precisely what firo.ts:54 implements. §16.1 budgets FIRO at ~4-5 dates-list requests to keep the project inside its 50–250 requests/run ceiling; per-country queries would be a 12× budget increase.

4. Coverage of the missing countries is assigned elsewhere by design. The same spec section routes Maledivy/Thajsko/Mauricius to alexandria (EXOTIC_LOCATION_IDS one page per exotic location, incl. Maledivy 3175 — src/sources/alexandria.ts:68), datour (per-country web-search), deluxea (12 exotic country listings), esotravel and adventura. The board aggregates 16 sources; the auditor ran firo alone and generalised "not in firo's 50 rows" to "not on the board".

5. The "sort-break" evidence cuts against the defect, not for it. I reproduced it (superset returns a higher minimum; both ["198"] and the 12-id query return country 198, different hotels). It is a server-side CESYS anomaly, not adapter code, and a correct sort would surface the cheaper 14,755 SAE hotel — still no Maldives. It cannot produce a missing high-price band.

RESIDUAL (why low, not none): firo.ts's header states the adapter "exists to give the project genuine exotic/long-haul coverage (Thailand, Maldives, Mauritius, UAE, …)", and live it delivers only UAE — 30 rows from one Dubai hotel (master 6564), ~9 offers after the [master_id, date_from, nights, boarding_id] dedupe. That is a real diversity/wording gap worth a header amendment or, if budget allowed, splitting exotika into a few per-country queries the way alexandria/datour already do. But it is a coverage nit against documented, spec-mandated, budget-motivated behaviour — not the reported "whole price band missing / none of it reaches the board" defect.
- **POTVRZENO** (high): CONFIRMED as an observable defect, but the reported ROOT CAUSE and the proposed fix are both wrong — the real trigger is result-set size, not country-array length, and the bug is worse and wider than reported.

What I independently did: read src/sources/firo.ts and src/sources/cesys.ts in full, then issued 11 raw POSTs to https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12352&lang=cs with bodies generated by a copy of buildDatesListBody() (same date math, adults 2, transport_id ["1"], rows_on_page 30, sort ['price asc','date_from asc'], client_id 12352 / customer_id 3593), Chrome UA, 3.5s gaps. Scripts were in the scratchpad and are deleted; repo left untouched (git status shows only the two pre-existing untracked entries).

REPRODUCED EXACTLY (today's window 2026-07-29..2027-04-25, duration 7-22):
- country_id 12-id exotika list → results 7,598,906, 30 rows, ALL master 6564 (country 198), 19,975-22,455 CZK, cheapest row nights 5.
- country_id ["198"] → results 1,244,329, 30 rows, ALL master 301746, 14,755-15,585.
- country_id ["198","220"] → 14,755, same master 301746.
- country_id ["220","131","138","198"] → 19,975, master 6564. Repeated verbatim → byte-identical result, so it is deterministic, not caching noise.
So yes: a strict superset returns a HIGHER page-1 minimum. The auditor's isolation reproduces perfectly.

THE DISCRIMINATING PROBE THE AUDITOR DID NOT RUN — same 12-id filter, only the price ceiling changed from 999999 to 16000: results 1,501, 30 rows, 11,690-12,590 CZK across TEN distinct UAE hotels (199431, 170923, 298927, 232780, 63952, 314856, 301746, 39195, 128772, 237698). Those rows satisfy every constraint of the shipped query (price 0-999999 trivially includes 11,690; cheapest row is 6 nights, so it also survives the client-side minNights>=6 filter in fetchOffers). The cheap rows ARE in the filtered set; price-asc simply fails to surface them. That is proof, not inference.

WHY THE REPORTED ROOT CAUSE IS WRONG: country_id ["198"] ALONE with the adapter's real price window returns 14,755 as its "cheapest", yet country_id ["198"] with priceTo=16000 returns 11,690 (results 1,487) — a strict subset of the same query. So the single-country query is ALSO broken. The proposed remedy ("a per-country or <=2-country loop returns correct, cheapest-first results") is refuted: it would still miss the 11,690 row by 3,065 CZK. The country-count variable is a confound. The actual correlate is candidate-set size: results 44 → correct (11,690); 1,487 → correct; 18,597 → correct; 1,244,329 → broken (14,755); 2,605,731 → broken; 5,879,377 → broken (19,975); 7,598,906 → broken. Above ~10^6 candidates the backend stops returning a globally price-ordered head (each broken page is internally price-ascending but drawn from a single master_id, and page 2 just continues that same hotel: 22,455-23,635, still master 6564). A correct fix is a price-window ladder (or any narrowing that keeps candidates small), not a per-country loop.

CONSEQUENCE, CORRECTED UPWARD: the shipped exotika query yields 30 rows from ONE hotel, of which only the 6-night ones survive minNights>=6 (matches the auditor's "SAE 9" adapter run), priced 19,975+. The real cheapest same-window UAE offer the site sells is 11,690 CZK — I resolved master 199431 via the adapter's own detail-redirect path (GET /detail-zajezdu/x/199431a → 301 → /detail-zajezdu/spojene-arabske-emiraty/tryp-by-wyndham-dubai/199431a, h1 "Tryp By Wyndham Dubai"), a genuine UAE hotel, 6 nights, 2026-08-26, PRG, Blue Sky Travel. Gap is ~8,285 CZK / 41%, not the reported ~5,200. Hotel diversity in the exotic segment is 1 instead of 10+.

FALSE-POSITIVE CHECKS, all negative: (a) not a missing field — this is about which rows come back, and every field on the returned rows maps correctly; (b) not a teaser/date mismatch — every comparison holds date window, duration, adults, transport and sort constant, and the cheap rows come from the same endpoint the site's own term widget calls; (c) not documented intent — the cesys.ts header documents only that 'discount desc' 500s and that 'price asc' is therefore hardcoded, i.e. it explicitly relies on price-asc to surface the cheapest page; nothing anywhere anticipates the sort silently failing at scale; (d) not dedupe/overlap — parseCesysDates dedupes by sourceOfferKey and never drops a cheaper row, and the cheap rows never reach it.

Severity high, not critical: no incorrect data is published (every emitted price is a real, correctly-mapped, bookable per-person price) and nothing crashes. But the defect defeats the exact purpose of the exotika query — firo.ts's header calls exotic coverage "FIRO's reason for existing" — is deterministic on every scan, and the same mechanism plausibly degrades the leto-more (results 5.8M) and last-minute (335k) queries and, since the code is shared, dovolenkovani too. Worth flagging to whoever fixes it that applying the reported remedy verbatim would leave the bug largely in place.
- **POTVRZENO** (medium): CONFIRMED — reproduced independently and deterministically, with stronger evidence than the original report.

WHAT I CHECKED
Read /Users/daniel/Library/CloudStorage/OneDrive-Osobní/Effistream/dovolenky/src/sources/firo.ts, src/sources/cesys.ts (buildDatesListBody L457-485, fetchOffers L541-553, DatesListQuery L211-224), src/core/http.ts. Then replayed the adapter's exact body (reconstructed from buildDatesListBody, today 2026-07-29 → date 2026-07-29..2027-04-25, duration 7-22, adults 2, transport_id ["1"], rows 30, sort ['price asc','date_from asc'], client 12352 / customer 3593) plus 12 comparison probes against POST https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list, Chrome UA, >=3.5s gaps, and 3 storefront detail pages.

CORE CLAIM REPRODUCED EXACTLY
Exotika body, run twice (and once with the 12-id array reversed): HTTP 200, results 7,598,906, more_exists true, 30/30 rows country 198, ONE master_id 6564, 19,975-22,455 CZK. Identical output across all three runs — deterministic, not sampling noise. After the minNights>=6 client filter (cesys.ts L547-552) 10 rows survive today (report said 9; nightsHist 5n:20 / 6n:10 — day-to-day pricing variance, immaterial). So 11 of the 12 requested exotic countries contribute zero offers, and the whole exotika query yields ~10 rows of a single hotel.

THE SUPERSET ANOMALY — reproduced more strongly than reported
Same body, only the country_id array varies:
  ["198"]              -> min 14,755, master 301746, 20 rows survive minNights
  ["220"]              -> min 18,880, master 343727, 30 rows survive minNights
  ["220","131"]        -> min 24,105, master 190233
  ["198","220","131"]  -> min 19,975, master 6564
  full 12 (adapter)    -> min 19,975, master 6564
A superset filter returns a HIGHER minimum than its own subset (both 198-alone at 14,755 and 220-alone at 18,880 are cheaper than the 12-id query's floor of 19,975, and neither hotel appears anywhere in the 12-id page). That is impossible under a correct price-asc union, so the server's multi-country result set is provably not the union's cheapest rows. Real offers are systematically lost.

THE MISSED OFFERS ARE REAL
GET /detail-zajezdu/x/<id>a on www.firotravel.cz: 301746 -> "Millennium Place Barsha Heights", Dubaj, 4* (SAE, 14,755); 343727 -> "Zing", Pattaya, 3* (Thajsko, 18,880); 6564 -> "Sheraton Jumeirah Beach Resort & Towers", Dubaj, 5* (the only hotel the query ever returns). All HTTP 200, live, bookable.

FALSE-POSITIVE CHECKS — none apply
(a) missing-field: N/A. (b) teaser-vs-term price mismatch: N/A. (c) intentional documented design: cesys.ts DOES document that price-asc + 30 rows concentrates on few hotels (probe B, 2 distinct master_ids), so concentration in kind is expected — but firo.ts's own header states the adapter "exists to give the project genuine exotic/long-haul coverage (Thailand, Maldives, Mauritius, UAE, …)", and its live-verification note (b) only ever verified country_id:["131"] SINGLE-id filtering and extrapolated to the 12-id list. That extrapolation is exactly what fails; observed behavior contradicts the documented intent. Concentration also cannot explain the anomaly — it would predict the union returns the globally cheapest hotel (Millennium Place, 14,755); it doesn't. (d) dedupe/overlap: N/A, single query.

TWO CORRECTIONS TO THE REPORT
1. The sort is NOT broken. Every response is monotonically price-ascending (verified on all probes) and page 2 resumes exactly at page 1's max (22,455). The defect is the server's candidate-set selection for multi-id country_id filters, not sort ordering. The reporter's label is imprecise; the effect they describe is correct.
2. It is fixable inside the adapter, so it is not an immutable source limitation: rows_on_page:100 IS honored (100 rows returned, 198x90 + 220x10, 2 hotels), and pagination works — per-country queries or a country rotation would fix it outright.

SEVERITY medium, not high: no incorrect data is emitted (fields map correctly, price_from.CZK is per-person as documented, price_total/discount genuinely null on every row) and the source still contributes valid offers, so this is a coverage/yield defect rather than a correctness one. Not low: firo is byte-identical to dovolenkovani apart from ids, so exotic coverage is its entire reason to exist, and it delivers 1 of 12 countries / 1 hotel while provably dropping cheaper real offers the same API returns for narrower filters.
