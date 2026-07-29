# Audit: dovolenkovani (high)

## Shrnutí

dovolenkovani.cz is a white-label CESYS storefront (TRAVEL Group s.r.o.); the adapter is a thin `makeCesysAdapter` instance in src/sources/dovolenkovani.ts over the shared logic in src/sources/cesys.ts. Per scan it issues exactly 3 POSTs to https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list (client_id=12274, customer_id=2119), each hardcoded to `page: 1`, `rows_on_page: 30`, `transport_id:["1"]`, `sort:["price asc","date_from asc"]`: leto-more (0..+60d, duration 7-22, nights>=6), last-minute (0..+14d, duration 1-21), exotika (0..+270d, duration 7-22, nights>=6, country_id = 12 exotic ids). Enrichment comes from sitemap.xml -> accommodations shards, /mapping/countries, and up to 40 detail-page redirect lookups for hotel names. Live run today returned 50 offers / 19 hotels / 6 countries, 7,871-22,455 CZK, all fields populated and hotel names fully resolved. The mapped fields I could check against the site are exact — price is genuinely per person per stay, dates/nights/board/country/stars/airport all match. The problem is scope: 90 rows are read out of ~5.9M (leto-more) and ~7.6M (exotika) matching rows, always the cheapest tail of page 1. The exotika query, which exists specifically to pull long-haul supply, delivers exactly one country and one hotel out of its 12 configured countries, so the entire 23k-45k CZK exotic band the agency headlines on its own homepage never reaches the board. A secondary bug in the shared sourceOfferKey silently discards 15 further real offers per scan. The agency is present and honest on the board, just represented by a narrow cheap slice.

## Nálezy k opravě

### 1.

EXOTIKA QUERY DELIVERS 1 OF ITS 12 COUNTRIES — the whole long-haul band is missing. src/sources/dovolenkovani.ts EXOTIKA_COUNTRY_IDS lists Thajsko/Maledivy/Mauricius/SAE/Dominikánská/Mexiko/Seychely/Srí Lanka/Tanzanie/Kuba/Vietnam/Kapverdy, but page 1 (30/30 rows, verified twice, deterministic) is 100% country_id 198 (Spojené arabské emiráty) and 100% master_id 6564 (Sheraton Jumeirah Beach Resort & Towers). After the client-side nights>=6 filter only 9 offers survive — one hotel. Same-window per-country probes prove the supply exists: Thajsko results=1,360,959 cheapest 18,880; Maledivy results=2,086,680 cheapest 40,690; Mexiko results=414,351 cheapest 33,805; Seychely results=322,221 cheapest 34,327; Kuba results=10,971 cheapest 43,500. The site's own homepage 'Naše nejlepší nabídky' block advertises Kuba od 42 542 Kč, Maledivy od 34 710 Kč, Zanzibar od 30 612 Kč, Dominikánská republika od 19 855 Kč (https://dovolenkovani.cz/). The adapter's global max price is 22,455 Kč — nothing above that band ever reaches the board.

### 2.

EXOTIKA ALSO BURNS 20 OF ITS 30 ROWS ON ROWS IT THEN THROWS AWAY. The server-side `duration:{from:7}` filter is in calendar days, so page 1 comes back dominated by duration_night=5 rows; the client-side `minNights: 6` post-filter in cesys.ts fetchOffers discards 20 of 30. Net yield of the exotika query is 10 rows before dedupe, 9 after — a third of one page for a third of the request budget.

### 3.

MULTI-COUNTRY `country_id` FILTER DOES NOT RETURN THE CHEAPEST ROWS, so even the one country it does surface is misrepresented. The 12-country exotika body returns SAE master 6564 starting at 19,975 Kč; an otherwise byte-identical body with `country_id:["220","198"]` returns SAE master 301746 starting at 14,755 Kč in the same date/duration window. `sort:["price asc"]` is therefore not global across a multi-id country filter — the adapter's comment in cesys.ts (lines 50-54) assumes it is. Splitting exotika into per-country queries would both fix this and fix the 1-of-12 coverage collapse.

### 4.

sourceOfferKey OMITS departureAirport — 15 genuinely distinct offers are silently dropped per scan (30% of the 50 published). cesys.ts:405 `offerKeyHash([masterId, departureDate, nights, row.boarding_id])`. Measured over the exact 3 queries this run: 90 rows fetched, 20 removed by the nights floor, 20 collapsed by dedupe — of those, 13 differed only by departure airport, 2 differed by price, and only 5 were true duplicates. Concrete case: master_id 6564, date_from 2026-09-01, duration_night 6, boarding_id 2 comes back twice — 21,440 Kč from PRG and 22,455 Kč from VIE — and the adapter keeps only the PRG row (https://dovolenkovani.cz/detail-zajezdu/sheraton-jumeirah-beach-resort-towers/6564a). Because the retained row is whichever is cheaper on that scan, a price shift between the two flips the stored key's airport, which the board would read as a price change rather than a different product.

### 5.

EVERY OFFER LINKS TO A GENERIC SEARCH PAGE. All 50/50 offers have url = https://dovolenkovani.cz/vyhledavani-zajezdu/ (the `fallbackUrl`), because `maps.hotels` only ever gets the handful of hotels in accommodations.xml. This is avoidable at zero extra request cost: cesys.ts resolveUnknownHotelNames already GETs `https://dovolenkovani.cz/detail-zajezdu/x/<master_id>a` for the name and that URL 301s to the canonical page — verified live, /detail-zajezdu/x/185781a -> https://dovolenkovani.cz/detail-zajezdu/admiral-plaza/185781a (HTTP 200) and /detail-zajezdu/x/6564a -> https://dovolenkovani.cz/detail-zajezdu/sheraton-jumeirah-beach-resort-towers/6564a (HTTP 200). The name is captured from that response, the URL is discarded. Even with no fetch at all, the un-canonical /detail-zajezdu/x/<id>a form is a working per-hotel link.

### 6.

PAGE 1 ONLY, PRICE-ASC, ACROSS ALL THREE QUERIES — the board sees only the cheapest tail. `page: 1` is hardcoded in cesys.ts buildDatesListBody with no pagination; `data.more_exists` is true on every query and ignored. leto-more page 1 is 29/30 rows Bulharsko + 1 Řecko across just 4 hotels, despite the same window holding Španělsko (results=1,055,070, from 13,500), Tunisko (70,528, from 10,990) and Kypr (59,219, from 11,351) — none of which appear anywhere in the 50 offers. The site's own last-minute menu lists Řecko, Turecko, Španělsko, Bulharsko, Tunisko, Kypr, Itálie, Černá Hora, Albánie, Emiráty, Kapverdy, Kanáry; the adapter returns 6 of those 12.

### 7.

locality IS ALWAYS NULL THOUGH IT IS AVAILABLE FROM TWO SOURCES. cesys.ts mapRow hardcodes `locality: null`, but the dates-list row carries a `destination` id (56 for the Bulgarian rows, 601 for the Dubai rows) that the CESYS mapping API resolves the same way `country` already is, and the detail page the adapter already fetches carries ld+json addressLocality ('Burgas' for 185781, 'Dubaj' for 6564).

### 8.

MINOR: `composition.adults` is hardcoded to 2 in cesys.ts buildDatesListBody and ignores `ctx.adults`, so a config change to 1 or 3 adults would still price a 2-adult room. MINOR: `isoDate` uses `toISOString()` (UTC), so a scan running between 00:00 and 02:00 CEST sets `date.from` to yesterday.

## Důkazy z auditu

Ran the adapter live via a throwaway ./._audit_dovolenkovani.mts (imported { dovolenkovani } + HttpClient, ctx = { http, adults: 2, log }), npx tsx, 81.6s, since deleted; repo tree left untouched. Result: 50 offers, 19 distinct hotels, price min 7,871 / median 11,690 / max 22,455 CZK. Countries: Bulharsko 23, SAE 9, Turecko 6, Egypt 6, Řecko 5, Itálie 1. Bands: 5-10k 14, 10-15k 27, 20-30k 9, nothing above 22,455. Field fill: country 50/50, stars 50/50, board 50/50, transport 50/50, departureAirport 50/50, tourOperator 50/50, locality 0/50, priceTotal 0/50, claimedDiscountPct 0/50, titles still "Hotel <id>" 0/50, distinct urls 1 (all the fallback search page). Nights histogram {3:18, 5:1, 6:9, 7:21, 10:1}; airports OSR 17, BRQ 15, PRG 13, VIE 4, BTS 1.

Direct API probes (curl, Chrome UA, POST https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12274&lang=cs, bodies byte-identical to buildDatesListBody): leto-more results=5,855,470 more_exists=true, page 1 = 30 rows / 4 masters / country 35 x29 + 183 x1. last-minute results=335,143, 15 masters, 5 countries. exotika results=7,598,906, page 1 = 30/30 country 198, 30/30 master 6564, prices 19,975-22,455, only 10 rows with duration_night>=6; rerun returned byte-identical first rows (deterministic). country_id:["220","198"] on the same window returned SAE master 301746 at 14,755 — cheaper than anything the 12-country query surfaced. Per-country probes: 220 Thajsko results=1,360,959 from 18,880; 131 Maledivy 2,086,680 from 40,690; 142 Mexiko 414,351 from 33,805; 192 Seychely 322,221 from 34,327; 112 Kuba 10,971 from 43,500; 214 Španělsko 1,055,070 from 13,500; 226 Tunisko 70,528 from 10,990; 114 Kypr 59,219 from 11,351. Unfiltered-transport probe: page 1 was 30/30 transport_id 3 "Vlastní" from 1,097 CZK — deliberately excluded by the flight-only design, noted as context, not counted as a defect.

Collision measurement replayed over the three real response payloads: 90 rows in, 20 dropped by the nights floor, 50 kept; of the 20 dedupe drops, 13 differed only in airport_code, 2 differed in price, 5 were true duplicates.

Field verification against the site (plain curl -L, Chrome UA):
1. https://dovolenkovani.cz/detail-zajezdu/admiral-plaza/185781a (reached via /detail-zajezdu/x/185781a, HTTP 200). Page shows "od 7 871 Kč / osobu a pobyt"; ld+json LodgingBusiness name "Admiral Plaza", ratingValue 4, addressCountry Bulharsko, addressLocality Burgas. Adapter: 7,871 CZK, 2026-09-01, 7 nights, board none, OSR, 4*, Bulharsko, TUI. Raw row confirms price_from.CZK 7870.6, price_total null, date_from 2026-09-01 / date_to 2026-09-08, duration_night 7, boarding "Bez stravy", airport_code OSR, rating 4, country 35, discount_percent null. Exact match on every checked field; locality Burgas available but dropped.
2. https://dovolenkovani.cz/detail-zajezdu/sheraton-jumeirah-beach-resort-towers/6564a (via /detail-zajezdu/x/6564a, HTTP 200). ld+json LodgingBusiness name matches, ratingValue 5, addressCountry Spojené arabské emiráty, addressLocality Dubaj; page shows "od 18 297 Kč / osobu a pobyt" (site-wide floor over all durations/airports, not comparable to the adapter's nights>=6 floor of 21,440 — not a mismatch). Adapter: 22,455 CZK, 2026-09-02, 6 nights, BB, VIE, 5*, SAE, Coral Travel; raw row confirms boarding "Snídaně", duration_night 6, airport_code VIE, rating 5, country 198, price_total null.
3. Price semantics confirmed per-person-per-stay by the site's own "/ osobu a pobyt" label on both detail pages, so pricePerPerson is right and priceTotal null is honest (price_total was null on every row in all three payloads). discount_percent was null on every row, so the null claimedOriginalPrice/claimedDiscountPct is honest too.
Homepage https://dovolenkovani.cz/ read for catalogue scope: headline offers Kuba od 42 542, Maledivy od 34 710, Zanzibar od 30 612, Dominikánská republika od 19 855, SAE od 16 380, Egypt od 6 717; "FIRST MINUTE - EXOTIKA 26/27" menu lists Dominikánská republika, Čína-Hainan, Emiráty, Kapverdy, Bahrajn, Katar, Keňa, Maledivy, Mauricius, Omán, Thajsko, Zanzibar, Kambodža.

## Adversariální ověření

- **POTVRZENO** (low): REPRODUCED EXACTLY, live and independently. I read src/sources/dovolenkovani.ts (exotika query, line 51: durationFrom 7, durationTo 22, minNights 6, 12 country ids) and src/sources/cesys.ts (buildDatesListBody line 457; the minNights post-filter at lines 547-553; sourceOfferKey = offerKeyHash([master_id, date_from, duration_night, boarding_id]) at line 405), then replicated the request body byte-for-byte and probed the live API with a Chrome UA.

As-shipped exotika (duration.from:7, window 2026-07-29..2027-04-25): HTTP 200, results=7,598,906, more_exists=true, 30 rows. duration_night histogram {5:20, 6:10}, duration(days) histogram {7:28, 8:2}. So the minNights:6 post-filter discards exactly 20 of 30 rows and keeps 10. boarding_id is uniform ({"2":30}) and sourceOfferKey excludes airport_code, so the two surviving date_from=2026-09-01 / n=6 rows (PRG 21,440 and VIE 22,455) collide: 10 kept -> 9 distinct keys. The reported "10 before dedupe, 9 after" is exactly right. All 30 rows are master_id 6564, country 198 (SAE).

The mechanism is confirmed and structural, not transient: the day-to-night offset on this long-haul supply is 2, not 1 (e.g. 2026-09-02 -> 2026-09-08, duration=7, duration_night=5) because exotic packages burn the first and last night on the plane. So duration.from:7 systematically maps to 5-night rows here, unlike the short-haul charter case the parameter was tuned for.

I also proved the loss is AVOIDABLE, which defeats the "intentional documented design" defence. Two extra probes on the same window: duration.from:8 -> 30/30 rows survive the floor ({6:14, 7:16}), 22 distinct keys; duration.from:9 -> 30/30 survive ({6:2, 7:19, 8:9}), 27 distinct keys, and TWO hotels / TWO countries (6564 SAE + 190233 Thajsko) instead of one. A one-number config change turns 9 offers into 22-27 and finally delivers on the query's stated purpose ("surfaces long-haul rows too"). The cesys.ts header (lines 66-69) anticipates the loose duration filter only as an edge case ("one row came back with duration_night: 5 despite duration.from: 6"); for exotika it is the majority case, because the leto-more tuning was copied verbatim into a long-haul-only query. That is a mis-tuned config, not documented intent, so false-positive class (c) does not apply. Classes (a), (b) and (d) are irrelevant here (this is about yield, not fields, teaser prices, or expected overlap).

SEVERITY CORRECTED DOWN to low, because the report overstates the cost on two points. (1) "for a third of the request budget" is wrong: the exotika query costs exactly ONE POST whether 30 or 10 rows survive; per the file's own budget note it is 1 of roughly 47 requests per storefront run (1 sitemap index + up to 2 shards + 1 countries + 3 dates-list + up to 40 detail lookups). The waste is opportunity cost on a 30-row page slot, not network cost. (2) The implied remedy (relax the nights floor) would buy ZERO additional hotels or countries: all 30 rows are the same Sheraton, so the 20 discarded rows are date/airport permutations of one hotel. The real diversity win comes only from raising durationFrom, a different change. Nothing incorrect is emitted, nothing crashes, and the dropped rows genuinely violate the profile's stated >=6-night invariant, so dropping them is correct behaviour given the query as written. It is a tuning inefficiency in one query on one source, worth fixing (durationFrom 7 -> 9, or drop minNights for exotika since 7 days / 5 nights IS the standard long-haul product), but not a correctness defect.
- **POTVRZENO** (high): CONFIRMED — I reproduced every load-bearing claim independently and the strongest refutation attempt fails on the evidence.

WHAT I CHECKED MYSELF
1. Read src/sources/dovolenkovani.ts (EXOTIKA_COUNTRY_IDS at line 35, QUERIES at 48-52) and src/sources/cesys.ts (buildDatesListBody at 457, the minNights client-side floor at 547-553, mapRow/parseCesysDates). Re-derived the POST body byte-for-byte rather than trusting the auditor's transcript.
2. Issued the exact adapter exotika body against POST https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12274&lang=cs with a generic Chrome UA (HttpClient's own default, per the §9 compliance note). Result: results=7,598,906, page 1 = 30/30 country_id 198, 30/30 master_id 6564, prices 19,975-22,455, only 10 rows with duration_night>=6. Reversing the id list returned byte-identical rows, so it is deterministic and not order-sensitive. This matches the report exactly.

WHY THE OBVIOUS DEFENSE FAILS
The natural refutation is "price asc + 30 rows/page naturally clusters on the single cheapest hotel — working as designed, and the board wants cheap." That is disproved by a controlled sweep over country_id list size, same window, same duration {7,22}:
  ["220"] Thajsko            -> min 18,880 (master 343727)
  ["198"] SAE                -> min 14,755 (master 301746)
  ["220","131"]              -> min 24,105 (master 190233) — Thailand's own cheapest row VANISHED
  ["220","198"]              -> min 14,755 (master 301746)
  11 ids (SAE dropped)       -> min 24,105 (master 190233)
  12 ids (the adapter query) -> min 19,975 (master 6564)
A superset country filter under a correct price-asc sort can only LOWER the minimum. Here adding countries raises it and deletes the cheapest rows of countries already in the list. Meanwhile the `results` counts do sum as a proper union (1,244,329 SAE + 1,360,959 Thajsko = 2,605,288 vs 2,605,731 measured for the pair), so the server counts the union but pages a different, more expensive slice of it. The multi-value country_id filter is simply not a working union under price-asc paging.

THE HEADER COMMENT DOCUMENTS THE OPPOSITE INTENT (false-positive category (c) checked and rejected)
cesys.ts:52-54 claims the filter "DOES filter server-side (verified live against FIRO: country_id:["131"] returns only Maledivy rows)" — that verification used a SINGLE id and the generalization to a 12-element list does not hold. dovolenkovani.ts:42-46 states the exotika query exists "so dovolenkovani ... surfaces long-haul rows too, not just the cheapest Mediterranean ones." It surfaces one country and one hotel out of twelve configured countries. The documented purpose is silently unmet — nothing logs a warning.

SUPPLY IS REAL, NOT PHANTOM
I fetched https://dovolenkovani.cz/detail-zajezdu/x/301746a (HTTP 200, redirects to /detail-zajezdu/millennium-place-barsha-heights/301746a): ld+json LodgingBusiness name "Millennium Place Barsha Heights", addressCountry Spojene arabske emiraty, addressLocality Dubaj. So a real bookable SAE hotel at 14,755 CZK in the identical window is never returned by the 12-id query, whose cheapest is 19,975 at a different hotel. The current query is strictly worse than a naive per-country query on BOTH diversity and price — that kills the "cheapest-first by design" reading entirely.

HOMEPAGE CLAIM (weakest part of the report, verified but not load-bearing)
I fetched https://dovolenkovani.cz/ once: "Nase nejlepsi nabidky" shows Kuba od 42 542 Kc, SAE od 16 380 Kc, Zanzibar od 30 612 Kc, Dominikanska republika od 19 855 Kc, Egypt od 6 717 Kc, Maledivy od 34 710 Kc — verbatim as reported. I discount this as evidence (teaser scope spans other durations/transports, i.e. false-positive category (b)), but the defect stands on the API probes alone without it.

MINOR DISCREPANCY, NOT MATERIAL
The report says 9 offers survive the nights>=6 filter; I measured 10 raw rows with duration_night>=6, which becomes <=10 after the [master_id, date_from, duration_night, boarding_id] dedupe in parseCesysDates. Consistent with one collision. Does not change the finding.

NOT RE-VERIFIED
I did not rerun the full adapter — the up-to-40 detail-page redirect lookups are a heavy load on the storefront and the auditor's field-level checks (Admiral Plaza 7,871 / Sheraton 22,455, price semantics "/ osobu a pobyt", price_total and discount_percent null on every row) were internally sound and are not what this finding rests on. The "global max 22,455" claim follows directly from the exotika page-1 range I did measure.

SEVERITY: high (not critical)
- An entire advertised capability — the long-haul band, the sole reason one of the source's three queries exists — delivers 1 of 12 countries and 1 hotel, silently, with no error or log.
- It is not merely a coverage gap: for a price-watching board it systematically suppresses a CHEAPER offer in the one country it does return (14,755 vs 19,975), which strikes at the product's core value.
- Blast radius extends beyond this adapter: dovolenkovani.ts:33 states the id list is "identical to firo's", so firo's exotika query presumably fails the same way.
Not critical because no wrong or corrupted data is emitted (the SAE rows returned are accurate and verified against the site), the source does not fail or throw, and the other two queries are unaffected — the source still returns ~50 valid offers per run.

FIX DIRECTION: issue one dates-list request per exotic country (or small batches) instead of one 12-id request, and correct the cesys.ts header comment, which currently asserts a multi-id behavior that was only ever validated with a single id.
- **POTVRZENO** (medium): CONFIRMED, and the real failure is broader than reported. I re-derived the exotika body from buildDatesListBody (cesys.ts:457-485) for today's date and varied ONLY country_id.

Reproduction (same window 2026-07-29..2027-04-25, duration 7-22, transport_id ["1"], sort ["price asc","date_from asc"], rows_on_page 30):
- 12 exotic ids (the production body, dovolenkovani.ts:35): results=7,598,906, page 1 = 30/30 country 198, 30/30 master 6564, min 19,975 max 22,455.
- country_id ["198"] alone, otherwise byte-identical: 30/30 country 198, master 301746, min 14,755 max 15,585. The 12-id query never surfaces this hotel although SAE is in its own filter list. Delta 5,220 CZK = 26% cheaper.
- country_id ["220"] alone: Thajsko master 343727 from 18,880 — also below the 12-id query's 19,975 min, so the 12-id result is not the cheapest of ANY of its twelve countries.

Refutation attempts, all failed:
(a) Non-determinism: re-ran the 12-id body back-to-back and with the id list REVERSED — byte-identical row sets (results=7,598,906, master 6564, 19,975-22,455) both times, and matching the auditor's run from an earlier session. Deterministic, order-independent.
(b) Different product semantics under multi-id (i.e. the API returning some other price basis): ruled out. Identical key schema across all responses; every row transport_id 1, price_total null, discount_percent null, price_from.CZK per person, same tour_operator object shape. The multi-id set is simply a worse-priced subset, and each page IS sorted asc within itself — the sort works, the candidate set is wrong.
(c) Intentional/documented design: no. cesys.ts:52-54 only verifies country_id with a SINGLE id (["131"] on FIRO); nothing documents that multi-id returns non-cheapest or single-country results. dovolenkovani.ts:42-46 states the opposite intent ("surfaces long-haul rows too, not just the cheapest Mediterranean ones") — observed behaviour contradicts the documented goal.
(d) Dedupe/nights-floor artefact: no. The loss is server-side, before parseCesysDates or the minNights filter ever runs.
(e) Site-teaser vs adapter-cheapest confusion: N/A — this is API-vs-API with bodies differing in one field. I confirmed both masters are real products: /detail-zajezdu/x/301746a → HTTP 200 "Millennium Place Barsha Heights", Dubaj, Spojené arabské emiráty (the 14,755 row); /detail-zajezdu/x/343727a → HTTP 200 "Zing", Pattaya, Thajsko.

The reported diagnosis is also incomplete in the adapter's favour being worse, not better: the trigger is NOT id count. country_id ["220","131"] — only two ids — returns Thajsko rows at min 24,105 (masters 190233/190243) while ["220"] alone returns Thajsko at 18,880. So a multi-id filter degrades results even for a country it does surface. Correlates with result-set size (unions ≤~2.6M behaved, ≥~3.4M degraded), consistent with an approximate/partial-scan path server-side.

Compounding impact: the 12-id page has duration_night {5:20, 6:10}, so the client-side minNights=6 floor (cesys.ts:547-553) discards 20 of 30 rows — the exotika query contributes ~9-10 offers, all one hotel, at prices ~26% above what the same country/window actually offers. That matches the auditor's live run (SAE 9 offers, max 22,455).

Severity medium, not high: no emitted row is false — per-row field accuracy was verified against the site and holds. This is a recall/coverage defect (one of three queries for this source degraded to a single hotel while materially cheaper real offers exist), so the report's "misrepresented" framing overstates it slightly; nothing is misreported, cheaper alternatives are simply never seen. The proposed fix direction is supported by evidence: single-id queries returned the true per-country cheapest in every probe (198, 220), though splitting exotika 12-ways multiplies the dates-list request budget accordingly.
