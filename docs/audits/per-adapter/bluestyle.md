# Audit: bluestyle (critical)

## Shrnutí

The adapter makes exactly one request — GET https://www.blue-style.cz/last-minute/ — pulls the __NEXT_DATA__ Apollo cache, and maps every node with __typename 'CheapestTerm' that carries a hotelName. Field mapping is genuinely good: I opened three offer pages in a real browser and price/date/nights/board/country/stars matched exactly on all three (pricePerPerson is a true per-person, all-in price for the stated nights). The problem is volume. That single page is page 1 of 108: its own Pagination node says {itemsPerPage:10, page:1, pageCount:108, totalItems:1073} and its own counters read "1 073 hotelů" / "965 810 zájezdů". So the adapter surfaces 10 hotels out of 1,073 in the Last Minute section alone (0.9%), in a 12,590–26,390 CZK band, while Blue Style's other landing pages — built on the identical THEMATIC_HOLIDAY template with the identical CheapestTerm shape, so parseBluestyle would work on them unchanged — sell up to 82,690 CZK and are not fetched at all: /exoticka-dovolena/ (280 hotels, to 63,890), /first-minute/ (833), /super-last-minute/ (428), /first-minute-exotika/ (110, to 54,990), /premiova-dovolena/ (48, to 82,690), plus ten more thematic pages. The entire exotic/premium 27k–83k band is invisible to the board. On top of that, the one page it does fetch carries 30 additional fully-formed ResultHotelTerm offers that the flat __typename filter discards. Blue Style is effectively a 10-offer token presence on the board rather than a represented agency.

## Nálezy k opravě

### 1.

CRITICAL — only page 1 of a 108-page listing is fetched. LISTING_PATHS = ['/last-minute/'] and there is no pagination loop, so fetchOffers returns exactly 10 offers. The page's own Apollo cache contains Pagination-75657803 = {"itemsPerPage":10,"page":1,"pageCount":108,"totalItems":1073} and KeyValuePair counters "1 073 hotelů" / "965 810 zájezdů". Live run: 10 offers, 7 countries, min/median/max pricePerPerson = 12 590 / 16 490 / 26 390 CZK. That is 0.9% of the Last Minute hotel pool. I confirmed the naive fix does NOT work: https://www.blue-style.cz/last-minute/?page=2 still SSRs page 1 (pagination.page stays 1, same 10 hotels) — the site paginates via client-side GraphQL, so pagination needs the GraphQL endpoint, not a query param.

### 2.

CRITICAL — the entire exotic/premium price band is missing because sibling landing pages are never fetched. The site's own thematicHolidayMenu/firstMinuteMenu/lastMinuteMenu (in ROOT_QUERY of the fetched page) list 16 more landing pages that use the same THEMATIC_HOLIDAY template and serve the same fully-populated CheapestTerm nodes. I fetched five of them and read their Pagination + priceFrom ranges: https://www.blue-style.cz/exoticka-dovolena/ = 280 hotels, 13 290–63 890 CZK (e.g. Hotel Millennium Resort Salalah /oman/salalah/, Hotel Karafuu Beach Resort & Spa /zanzibar/zanzibar/ at 54 990); https://www.blue-style.cz/first-minute/ = 833 hotels; https://www.blue-style.cz/super-last-minute/ = 428 hotels; https://www.blue-style.cz/first-minute-exotika/ = 110 hotels, to 54 990; https://www.blue-style.cz/premiova-dovolena/ = 48 hotels, 16 390–82 690 CZK. Adapter's max is 26 390 CZK — everything above that (Oman, Zanzibar, luxury Kypr/Řecko) is structurally unreachable. Also unfetched: /poznavaci-zajezdy/, /all-inclusive/, /hotely-s-aquaparkem/, /letecky-z-ostravy/, /letecky-z-brna/, /letecky-z-pardubic/, /rodinna-dovolena-plna-zabavy/, /multigeneracni-dovolena/, /dovolena-pro-dospele/, /klidna-dovolena-pro-seniory/.

### 3.

HIGH — 30 usable offers are thrown away from the request already made. The /last-minute/ apolloState holds 30 ResultHotelTerm nodes (3 'nearestTerms' alternative departure dates per hotel) alongside the 10 CheapestTerm. They carry MORE fields than CheapestTerm — departureDate, returnDate, nights, dayCount, boardingType, priceFrom, percentageDiscount, url, plus departureCity/depCity and arrivalAirportCode/arrivalAirportName that CheapestTerm lacks entirely. collectCheapestTerms() filters on `__typename === 'CheapestTerm'` only, so parseBluestyle yields 10 where 40 were available at zero extra request cost. (They lack hotelName/hotelStars, but the parent ThematicHolidayHotel node holds `name`, `hotelStars`, `countryName`, `destinationName` and references them via `nearestTerms` — so it needs a parent-aware walk rather than the current flat __typename scan.)

### 4.

MEDIUM — departureAirport is hardcoded null even though the departure airport is present in the fetched data. mapOffer() sets `departureAirport: null` unconditionally, yet the URL of every offer carries depCity and the sibling ResultHotelTerm nodes spell it out: 9 of the 10 fetched offers are `{"departureCity":"Praha","depCity":2}`, but Hotel Mythos Palace Resort (https://www.blue-style.cz/recko/korfu/hotel-mythos-palace-resort/?date=2026-09-07&duration=3&depCity=11&arrCity=26&airline=Smartwings) is depCity=11 = `{"departureCity":"Ostrava","depCity":11}`. Consequence beyond display: computeMatchKey (src/core/normalize.ts) hashes `airportNorm ?? '*'`, so every bluestyle offer buckets under '*' and can never cross-source-match a PRG or OSR offer from another agency. No false merges, but all merges are missed.

### 5.

LOW — claimedOriginalPrice is systematically ~0.3–2.2 % too high, so the claimed discount is slightly overstated. It is derived as pricePerPerson / (1 - pct/100) from Blue Style's already-rounded integer percentageDiscount, rather than from the site's actual saving figure. Measured against the 'dnes ušetříte' amount on each offer page (halved for 2 adults): Pyramisa 28 277 derived vs 28 190 actual; Sighientu 40 600 vs 39 990; Murdeira 47 705 vs 46 690. Field is honestly named 'claimed', and the direction is consistent, so this is cosmetic — but it does inflate discount-v2 inputs a little.

### 6.

LOW — priceTotal is always null although the site states it verbatim. Every offer page shows 'Cena celkem' for 2 adults (26 580 / 52 780 / 41 980 Kč on the three I checked) and that is exactly 2 × the adapter's pricePerPerson, i.e. priceTotal for ctx.adults=2 is derivable with no extra request. Not incorrect (null = unknown), just unfilled.

### 7.

LOW — /last-minute/ intermittently SSRs an empty Apollo cache and the adapter silently reports zero. 1 of 8 plain fetches returned HTTP 200 with a 130 921-byte body (normal is 1 175 330) whose __NEXT_DATA__.apolloState was `{}` while props.pageProps.initialProps still resolved the route as 200 OK — the thematicHoliday query result was simply absent. parseBluestyle returns [] with no error, indistinguishable from 'no offers'. Impact is contained: src/core/run.ts:446 already treats offersFound === 0 as 'skip markMissedOffers' so inventory is not flipped inactive, but the run is lost with only a log line.

### 8.

NOTE (no defect) — the adapter's doc comment claiming country pages carry only partial CheapestTerm teasers is still accurate, not stale: https://www.blue-style.cz/egypt/ has 14 CheapestTerm nodes, 0 of them with hotelName. Skipping those paths remains the right call. Likewise `transport: 'flight'` is correct — every offer page shows 'Místo odletu Praha/Ostrava' with an airline.

## Důkazy z auditu

RAN LIVE (npx tsx throwaway importing { bluestyle } + HttpClient, ctx {http, adults:2, log}): 10 offers total, one page fetched. Price bands: 5 offers 10–15k, 2 in 15–20k, 3 in 20–30k. Countries: Tunisko 2, Řecko 2, Španělsko 2, Egypt 1, Kapverdy 1, Turecko 1, Itálie 1. Boards AI 7 / BB 2 / HB 1. Nights {2,3,4,7}. Stars {3,4,5}. Dates 2026-08-17..2026-09-30, 0 null dates. min/median/max ppp 12 590 / 16 490 / 26 390.

FIELD CHECK — 3 offers opened in a real browser (all Chrome UA), adapter value vs page:
1) https://www.blue-style.cz/egypt/hurghada/hotel-pyramisa-beach-resort/?date=2026-08-17&duration=2&depCity=2&arrCity=9&airline=Hello%20Jets — adapter: 13 290 CZK ppp, 2026-08-17, 2 nights, AI, 5*, Egypt/Hurghada, -53 %. Page: "Termín pobytu 17.08 - 19.08.2026", "All Inclusive", "Cena celkem 26 580 Kč" for "2 dospělí" → 26 580/2 = 13 290 EXACT, "- 53 %", detail SSR hotelStars STAR_5, countryName Egypt, destinationName Hurghada. ALL MATCH.
2) https://www.blue-style.cz/italie/sardinie/sighientu-resort-thalasso/?date=2026-09-22&duration=7&depCity=2&arrCity=31&airline=Smartwings — adapter: 26 390 ppp, 2026-09-22, 7n, AI, 4*, Itálie/Sardinie, -35 %. Page: "22.09 - 29.09.2026" (=7 nights), "All Inclusive Plus", "Cena celkem 52 780 Kč" /2 = 26 390 EXACT, "- 35 %". ALL MATCH.
3) https://www.blue-style.cz/kapverdy/sal/hotel-murdeira-village-resort/?date=2026-08-20&duration=7&depCity=2&arrCity=1753&airline=Smartwings — adapter: 20 990 ppp, 2026-08-20, 7n, HB, 3*, Kapverdy, locality "Kapverdy", -56 %. Page: "20.08 - 27.08.2026", "Polopenze", "Cena celkem 41 980 Kč" /2 = 20 990 EXACT, "- 56 %", breadcrumb "Kapverdy / Kapverdy" (so the duplicated locality is the site's own data, not an adapter bug). ALL MATCH.

COVERAGE EVIDENCE — plain curl (Chrome UA), __NEXT_DATA__.apolloState parsed:
/last-minute/ → 1347 apollo entries; CheapestTerm 10 (all with hotelName), ResultHotelTerm 30, ThematicHolidayHotel 10; Pagination-75657803 {"itemsPerPage":10,"page":1,"pageCount":108,"totalItems":1073}; KeyValuePair-1818611179 {"key":"1073","value":"1 073 hotelů"}; KeyValuePair-194295553 {"key":"965810","value":"965 810 zájezdů"}.
/last-minute/?page=2 → identical 10 hotels, pagination.page still 1 (SSR ignores the param; d.query is only {"uri":["last-minute"]}).
/super-last-minute/ → totalItems 428, pageCount 43, 10 full CheapestTerm.
/exoticka-dovolena/ → totalItems 280, pageCount 28, priceFrom range 13 290–63 890.
/first-minute/ → totalItems 833, pageCount 84, range 11 590–26 190.
/first-minute-exotika/ → totalItems 110, pageCount 11, range 13 990–54 990.
/premiova-dovolena/ → totalItems 48, pageCount 5, range 16 390–82 690.
/egypt/ → 14 CheapestTerm, 0 with hotelName (confirms the adapter's stated reason for skipping country pages).
/exotika/ → HTTP 404 (the real slug is /exoticka-dovolena/).
Menus read from ROOT_QUERY of /last-minute/: lastMinuteMenu = [/last-minute/, /super-last-minute/]; firstMinuteMenu = [/first-minute/, /first-minute-exotika/]; thematicHolidayMenu = 12 entries (/exoticka-dovolena/, /multigeneracni-dovolena/, /poznavaci-zajezdy/, /premiova-dovolena/, /rodinna-dovolena-plna-zabavy/, /all-inclusive/, /hotely-s-aquaparkem/, /letecky-z-ostravy/, /letecky-z-brna/, /letecky-z-pardubic/, /dovolena-pro-dospele/, /klidna-dovolena-pro-seniory/).
Sample ResultHotelTerm the parser discards: {"airlineCode":"H3","arrivalAirportCode":"HRG","boardingType":"All Inclusive","departureCity":"Praha","depCity":2,"departureDate":"2026-07-30","returnDate":"2026-08-01","nights":2,"percentageDiscount":42,"priceFrom":16790,"url":"/egypt/hurghada/hotel-pyramisa-beach-resort/?date=2026-07-30&duration=2&depCity=2&arrCity=9&airline=Hello Jets"}. Distinct departureCity values across the 30: Praha (depCity 2) and Ostrava (depCity 11).
Flakiness: 8 plain fetches of /last-minute/; 7 returned 1 175 3xx bytes with apolloState of 1347 entries, 1 returned 130 921 bytes with apolloState {} (HTTP 200, title and route resolved normally) → parseBluestyle would yield 0.

No source file was modified; the throwaway ./._audit_bluestyle.mts was deleted (verified absent; the other ._audit_*.mts in git status belong to parallel auditors).

## Adversariální ověření

- **POTVRZENO** (high): CONFIRMED — I reproduced every load-bearing claim independently and could not refute it.

WHAT I CHECKED MYSELF

1. Source (/Users/daniel/.../dovolenky/src/sources/bluestyle.ts): `const LISTING_PATHS = ['/last-minute/'];` (line 10) and `fetchOffers` (lines 167-183) is a single `for (const path of LISTING_PATHS)` loop with one `ctx.http.text(`${BASE_URL}${path}`)` — no page counter, no cursor, no offset. Confirmed by reading, not by assumption.

2. Live adapter run (throwaway importing { bluestyle } + HttpClient, ctx {http, adults:2, log}): log line `bluestyle: fetched 10 offers across 1 pages`, TOTAL OFFERS: 10. Same 10 hotels the auditor reported, same prices/dates/boards/stars/discounts (Pyramisa 13290 / Murdeira 20990 / Bodrum Park 16690 / Medina Belisaire 13790 / Mythos Palace 16490 / Iberostar Mehari 20190 / Argile 14990 / Palas Pineda 12590 / Aqua Aquamarina 12890 / Sighientu 26390).

3. Coverage denominator, from my own curl (Chrome UA) + __NEXT_DATA__ parse of https://www.blue-style.cz/last-minute/: `Pagination-75657803 = {"itemsPerPage":10,"page":1,"pageCount":108,"totalItems":1073}`, and `KeyValuePair-1818611179 = {"key":"1073","value":"1 073 hotelů"}`. CheapestTerm count = 10, all 10 with hotelName. So the adapter takes 10 of 1073 = 0.9%.

4. The "naive fix fails" claim is also true: I fetched /last-minute/?page=2 and diffed. `__NEXT_DATA__.query` becomes {"page":"2","uri":["last-minute"]}, but the SSR Apollo key stays `thematicHoliday({"hotelFilter":{...,"page":1},...})`, Pagination.page stays 1, and the 10 CheapestTerm hotel/price/date triples are byte-identical to page 1. A pagination fix cannot be a query param.

5. Fix is feasible, so this is not "the site makes it impossible": the client bundle /_next/static/chunks/pages/_app-*.js contains `uri:"https://www.blue-style.cz/graphql"` — the paging happens over that endpoint.

WHY THE FOUR STANDARD FALSE-POSITIVE ESCAPES DON'T APPLY

(a) Not a missing field — every field the adapter emits is correct; the auditor's 3-offer browser field check matched exactly, and I re-derived the same prices/discounts straight from apolloState.
(b) Not a teaser/term mismatch — prices are the adapter's own values and they reconcile to the detail pages.
(c) NOT documented intentional design. The header comment (lines 5-9) justifies exactly one thing: dropping the country/region pages, because their CheapestTerm entries are partial teasers with no hotelName. It says nothing about accepting page 1 only. The contrast inside this same repo is decisive: invia.ts line 258 explicitly documents "v1 ships exactly 2 queries, first page only (no pagination)", and cedok.ts paginates with `LAST_MINUTE_PAGES = 4` over `?page=N&order=priceAsc`. bluestyle has neither the loop nor the waiver.
(d) Not dedupe/overlap — the 10 survive dedupe; there is simply nothing else fetched.

EXTRA EVIDENCE THAT THIS IS A BUG, NOT A CHOICE
docs/superpowers/specs/2026-07-04-dovolenky-design.md §16.2 lists bluestyle under "Vynecháno" from the exotika expansion with the justification "bluestyle (katalog ~10 nabídek)". That is factually wrong — the last-minute catalog is 1073 hotels. The 10-offer ceiling was noticed and misdiagnosed as "Blue Style is a small operator" instead of "we never paginate". The original plan (docs/.../plans/2026-07-04-dovolenky.md line 430) even expected "≈50" offers.

SEVERITY: HIGH, not CRITICAL. Downgraded because nothing is wrong or corrupted — all 10 offers are accurate, no crash, no bad notification, and the other 15 sources are unaffected; it is a completeness gap in one source, and the fix needs reverse-engineering the GraphQL pagination rather than a one-line change. It stays HIGH rather than MEDIUM because the sampled slice is not the good end of the pool: the 10 offers are unsorted by both price (12590…26390 in arbitrary order) and discount (53,56,36,27,36,27,33,42,45,35), and ROOT_QUERY shows orderBy:null/orderDirection:null — so unlike cedok's price-ascending first 4 pages, this is an arbitrary 0.9% sample, and any genuinely best Blue Style deal is missed unless it happens to land on page 1.

(Not part of this finding, but observed and worth its own ticket: the auditor's flakiness note — 1 of 8 fetches returned HTTP 200 with `apolloState: {}`, which parseBluestyle turns into 0 offers silently. My 2 fetches were both healthy, so I neither confirm nor refute it here.)
- **POTVRZENO** (high): CONFIRMED — I reproduced every load-bearing claim independently and could not refute it.

WHAT I CHECKED MYSELF
1. Source: `LISTING_PATHS = ['/last-minute/']` (bluestyle.ts:10), single loop at :171. One fetch, period.
2. Live fetches (plain curl, Chrome UA) of /last-minute/, /exoticka-dovolena/, /premiova-dovolena/, parsed __NEXT_DATA__.apolloState myself:
   - /last-minute/: 10 CheapestTerm, all with hotelName, Pagination {page:1,pageCount:108,totalItems:1072}, priceFrom 12 590–26 390.
   - /exoticka-dovolena/: 10 CheapestTerm, ALL with hotelName, totalItems 280, 13 290–63 890 (Omán/Salalah 22 290 + 24 790, Zanzibar/Karafuu 54 990, Maledivy 63 890 + 54 390, Kapverdy/Riu Funana 27 090 + 31 590).
   - /premiova-dovolena/: 10 with hotelName, totalItems 48, 16 390–82 690 (Hurawalhi Maledivy 82 690, Kypr, Kréta, Bulharsko).
3. Ran the UNMODIFIED `parseBluestyle` over the two sibling pages: 10 valid NormalizedOffers each, full country/locality/stars/board/nights/date/discount. Zero parser changes needed — the fix is literally adding strings to LISTING_PATHS, and `fetchOffers` already dedupes across paths via its `seen` set.
4. Field-verified a premium offer in a real browser: /kypr/severni-kypr/hotel-concorde-luxury-resort/?date=2026-09-12&duration=3&depCity=2&arrCity=1762&airline=Smartwings → page shows "Termín pobytu 12.09 - 15.09.2026", "Ultra All Inclusive", "2 dospělí", "Cena celkem 52 580 Kč" = 26 290 ppp exactly, "- 33 %". Matches the adapter's mapping of that node exactly. So sibling-page priceFrom is the same per-person semantic as /last-minute/, not a teaser or a total.
5. ROOT_QUERY menus reproduced verbatim: lastMinuteMenu [/last-minute/, /super-last-minute/], firstMinuteMenu [/first-minute/, /first-minute-exotika/], thematicHolidayMenu 12 entries. (Report says "16 more pages"; the actual count is 15 — immaterial overcount.)
6. Confirmed /last-minute/?page=2 is ignored server-side (d.query {"page":"2"} but Pagination.page still 1, byte-identical 10 hotels), and the SSR 10 are stable across fetches ~40 min after the auditor's. So 10 of 1072 offers, max 26 390, is a permanent ceiling — not a sampling artifact that rotates into exotika over time.
7. robots.txt allows all these paths (only /admin, /obj-*, /objednavka/*, /rezervace/*, /cestovni-*, /doplnkove-sluzby/*).

WHY THE FOUR FALSE-POSITIVE ESCAPES DON'T APPLY
(a) not a missing field — all required fields are present on the sibling pages.
(b) not a teaser/date mismatch — verified exact price+term+board+discount against the live detail page.
(c) not documented intent in the header comment — the comment (lines 5-9, 29-35) justifies skipping only the COUNTRY/REGION pages (/recko/, /egypt/) because their CheapestTerm nodes are partial teasers with no hotelName. I re-verified that reason is real, and I verified it does NOT hold for the thematic/first-minute landing pages, which serve fully-populated nodes. The comment is silent on them.
(d) not dedupe/overlap — /exoticka-dovolena/ shares only 2 of 10 with /last-minute/ (Pyramisa, Murdeira); /premiova-dovolena/ shares 0. Net +18 offers from two extra fetches.

ONE THING THE REPORTER MISSED, AND IT CUTS BOTH WAYS
docs/superpowers/specs/2026-07-04-dovolenky-design.md §16.2 explicitly lists bluestyle under "Vynecháno (zdůvodnění)" for the exotika expansion, with the reason "bluestyle (katalog ~10 nabídek)". So there IS a recorded decision — but it rests on a false premise: the ~10 is the per-page SSR cap, not Blue Style's catalog (1072 last-minute / 280 exotic terms). The same doc prescribes exactly the proposed fix for a sibling source ("skrz: LISTING_PATHS += /exoticka-dovolena"), and the exotika watch profile lists Maledivy, Zanzibar, Kapverdy — all of which /exoticka-dovolena/ hands over in one request. Whoever fixes this should correct that doc line too, otherwise the next reader re-applies the wrong reasoning.

SEVERITY DOWNGRADED CRITICAL → HIGH
Nothing the adapter emits is wrong, stale, or misleading; the 10 offers it does produce were field-verified as exact. This is a deterministic, structural coverage gap in 1 of 16 sources, and the project aggregates exotika from FIRO/dovolena.cz/dovolenkovani/skrz as well. That is high, not critical — but it is genuinely high: an entire price band (>26 390 CZK) and whole countries (Omán, Zanzibar, Maledivy, Kypr) are unreachable from this source, and the fix is one line with no parser work.

UNVERIFIED CLAIM: the reporter's flakiness observation (1 of 8 fetches returning HTTP 200 with empty apolloState → 0 offers). I got 5/5 well-formed responses and cannot confirm it. If real it is a separate defect from this one and needs its own evidence.
- **POTVRZENO** (medium): CONFIRMED as a real coverage gap, but HIGH is overstated — downgraded to MEDIUM.

WHAT I VERIFIED INDEPENDENTLY (not taken from the auditor):
1. Live curl of /last-minute/ (Chrome UA, HTTP 200, 1 175 335 B): apolloState has 1347 entries — CheapestTerm 10, ResultHotelTerm 30, ThematicHolidayHotel 10. Each ThematicHolidayHotel carries nearestTerms: [3 x ResultHotelTerm __ref] plus name, stars, countryName, destinationName. Confirmed.
2. Code path confirmed: collectCheapestTerms() (bluestyle.ts:60-73) pushes only nodes with __typename === 'CheapestTerm'; mapOffer() (line 107-108) returns null when hotelName is absent, and ResultHotelTerm never has hotelName/hotelStars/destinationName. All 30 are therefore discarded. parseBluestyle yields 10.
3. Field surplus confirmed by key-union dump. ResultHotelTerm keys: airlineCode, airlineName, arrCity, arrivalAirportCode, arrivalAirportName, boardingType, currency, dayCount, departureCity, departureDate, depCity, discountPrefix, isFirstMinute, isLastMinute, nights, percentageDiscount, priceFrom, returnDate, room, url. CheapestTerm lacks departureCity/depCity/arrivalAirport*/returnDate/airline*/isLastMinute entirely.
4. DECISIVE CHECK — I opened a DISCARDED term in a real browser: /egypt/hurghada/hotel-pyramisa-beach-resort/?date=2026-08-06&duration=4&depCity=2&arrCity=9&airline=Hello%20Jets. Page renders "Termin pobytu 06.08 - 10.08.2026", "All Inclusive", "Cena celkem 30 580 Kc" for "2 dospeli" => 15 290 ppp, "- 54 %". The discarded node says priceFrom 15290, percentageDiscount 54, nights 4. EXACT MATCH. So the discarded terms are genuine, bookable, correctly-priced offers, not teasers.
5. Durability: the 2026-07-04 test fixture (tests/fixtures/bluestyle/last-minute.html, 25 days older) has the identical shape — 1339 entries, 10 CheapestTerm, 30 ResultHotelTerm, 10 hotels x 3 nearestTerms, parent stars=STAR_5. Not a transient.

FALSE-POSITIVE CHECKS, ALL FAIL TO REFUTE:
(a) "field the source does not publish" — no; the identity fields (name, stars as STAR_5/STAR_4_PLUS enums matching STAR_MAP, countryName, destinationName) sit on the parent node in the SAME payload.
(b) "teaser is a different term/date" — no; I verified a discarded term's own deep-link resolves to exactly its stated price/date/board/discount.
(c) "intentional design in the header comment" — no. The header (lines 5-10, 29-36) documents only why country pages are dropped and why partial CheapestTerm teasers are skipped. Nothing addresses nearestTerms/ResultHotelTerm. The spec (docs/superpowers/specs/2026-07-04-dovolenky-design.md row 5) names CheapestTerm-* as the parse target and §16.2 skips bluestyle from the exotika expansion citing "katalog ~10 nabidek" — that is a mistaken premise about catalog size (Pagination says totalItems 1073 / pageCount 108), not a deliberate rejection of nearestTerms.
(d) "expected dedupe/overlap" — only partial. Live: 1 of 30 nearestTerms is the same term as its hotel's CheapestTerm (Aqua Hotel Aquamarina 2026-08-29 n=4, identical URL and price) => 29 net-new, not 30. Fixture: 4 of 30 duplicate => 26 net-new.

WHY MEDIUM, NOT HIGH:
- No incorrect output. Everything the adapter emits is accurate; this is a missed-yield/enhancement gap, not a data-correctness bug.
- Across BOTH snapshots (60 nearestTerms total), ZERO are cheaper than their own hotel's CheapestTerm (live: 29 pricier, 1 equal). The adapter therefore never misses a hotel's best price — the discarded set is strictly the more expensive alternative dates. For a deal board this is materially lower-value than "30 usable offers" implies.
- The discarded terms add zero new hotels, countries or localities — same 10 hotels. Only a discount-percentage-ranked view gains anything (a few discarded terms do carry a higher claimed pct: Aquamarina -56% vs -45%, Sighientu -51%/-50% vs -35%, Pyramisa -54% vs -53%), which is real but modest value.
- The dominant coverage limit is pagination, not nearestTerms: Pagination-75657803 = {itemsPerPage 10, page 1, pageCount 108, totalItems 1073}. Fixing this takes 10 -> ~39 offers while still covering 10 of 1073 items.
- The fix is not a one-line filter widening: it needs a parent-aware __ref-resolving walk.

ERRORS IN THE REPORT TO CORRECT WHEN FIXING:
1. The parent field is `stars` (values STAR_5, STAR_4_PLUS, STAR_3_PLUS...), NOT `hotelStars` as the report claims. hotelStars is undefined on all 10 ThematicHolidayHotel nodes.
2. "30 usable offers" is 29 net-new live / 26 in the fixture after collapsing the nearestTerm that duplicates the CheapestTerm.
3. ResultHotelTerm uses `nights`, while mapOffer reads `term.nightCount` — reusing mapOffer unchanged would silently emit nights:null, corrupting offerKeyHash and disabling the per-night hotel/locality/market discount rungs in discount.ts.
4. ResultHotelTerm also lacks destinationName and roomType (it has a `room` __ref), so locality must come from the parent too.
5. Missed upside the report did not mention: ResultHotelTerm.departureCity (Praha/Ostrava/Brno) would populate departureAirport, which bluestyle.ts:150 currently hardcodes to null for every offer.
