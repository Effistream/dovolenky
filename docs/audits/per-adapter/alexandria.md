# Audit: alexandria (high)

## Shrnutí

The adapter (/Users/daniel/Library/CloudStorage/OneDrive-Osobní/Effistream/dovolenky/src/sources/alexandria.ts) issues 9 requests per scan against https://bck-new.alexandria.cz/web-search: pages 1-2 of the unfiltered default feed (DEFAULT_FEED_PAGES = 2, 18 rows/page) plus one page each for 7 hardcoded EXOTIC_LOCATION_IDS (3175, 8288, 3030, 5899, 3163, 453555, 453246). Live it returned 46 offers. Field mapping is essentially correct — I verified two offers against their own detail pages and every money/date/board/country field matched the site exactly, including the site's own printed "Osoba za X Kč" line, which confirms the package_price/persons formula for both the in-house and the BV_/Worldee partner inventory. The problem is coverage: the default feed reports total = 1042 and the adapter reads 36 of those rows (3.5%), with a deterministic ordering (page 1 fetched twice minutes apart returned the identical 18 tour_ids in the identical order), so it is a fixed ~36-hotel window rather than a rotating sample. On top of that, 6 of the 7 hardcoded exotic location ids are not "seasonally empty" as the header comment assumes — they are retired: the site's own filter-location tree now marks them available:false and has moved the live exotic inventory to a new id block (460916-460954). Net effect: two-thirds of the request budget is spent on dead ids, and the entire sub-18k CZK price band, all self-drive offers, all cruises and sightseeing tours, and every live exotic destination except Bali never reach the board. Alexandria is present and correctly priced, but a large slice of what it actually sells is invisible.

## Nálezy k opravě

### 1.

COVERAGE, main issue: the adapter reads 36 of the default feed's 1042 rows (3.5%). https://bck-new.alexandria.cz/web-search?page=1 returns {"total": 1042} with 18 packages/page (~59 pages); DEFAULT_FEED_PAGES = 2 gives 36. The feed order is deterministic — I fetched page 1 twice minutes apart and got the identical 18 tour_ids ['4782','8369','10142','11390','313','10585','210','10576','11380','11164','10801','11376','9109','6269','8364','5300','350','10434'] in the identical order — so this is a fixed window, not a sample that drifts across scans. I also confirmed the API ignores limit/per_page/size/sort (all still return 18 rows), so widening coverage requires more page requests.

### 2.

COVERAGE: 6 of the 7 hardcoded EXOTIC_LOCATION_IDS are retired, not seasonally empty. Live now, each returns {"total": 0}: 3175 (Maledivy), 8288 (S.A. Emiráty), 3030 (Dominikánská republika), 5899 (Seychely), 3163 (Mexiko), 453555 (Srí Lanka). https://bck.alexandria.cz/filter-location marks the first five as "available": false, and 453555 does not appear in the tree at all. The tree now carries a NEW id block (460916-460954) that holds the live exotic inventory, and those ids do return offers: 460931 Maledivy (1), 460952 Srí Lanka (1), 460948 Mexiko (1), 460951 Mauricius (1), 460936 USA (20), 460918 Japonsko (2). Only 453246 (Bali, 10 offers) of the adapter's list still resolves. So 6 of the 9 requests per scan are wasted, and the exotic slice the comment says the adapter is holding open for winter will never flip on with these ids.

### 3.

COVERAGE: the entire cheap half of the catalogue is missing. The adapter's cheapest offer is 17,990 CZK/person (median 24,990). In a 12-page sample of the feed (167 rows) 53 rows (32%) price below 17,990 CZK/person, down to 3,776 (Rumunsko, 3 nights), 4,275 (Maďarsko), 5,252 (Srbsko), 5,390 (Itálie zima, self-drive), 7,076 (Kypr), 7,147 (Malta). Alexandria's own homepage "od" teasers (embedded in the page payload) are Itálie 3,790 / Bulharsko 9,280 / Řecko 13,790 / Albánie 15,914 / Turecko 17,990 / Černá Hora 18,323 / Španělsko 20,280 — i.e. every headline entry price the agency advertises except Španělsko sits below what the adapter can ever return. For a discount board this is the wrong half to lose.

### 4.

COVERAGE: whole destinations and product categories absent from the 46 offers. The output covers 8 countries (Řecko 14, Bulharsko 10, Indonésie 10, Turecko 6, Albánie 2, Itálie 2, Černá Hora 1, Španělsko 1). The 12-page feed sample alone contains 27 distinct country_name values; missing from the adapter output are Kypr, Chorvatsko, Portugalsko, Malta, Maledivy, Mauricius, Francie, Island, Norsko, Dánsko, Estonsko, Rumunsko, Srbsko, Maďarsko, Velká Británie, USA, Japonsko, plus 'Itálie (zima)'. Two whole product lines are also invisible: location=5864 'Plavby' (cruises, 3 offers, 59,980-211,980 CZK) and location=7963 'Poznávací zájezdy' (sightseeing tours, 5 offers, 45,980-85,560 CZK). The filter tree lists 62 top-level destinations.

### 5.

COVERAGE: transport and length-of-stay diversity collapsed. All 46 offers are transport='flight' and nights of only 7 or 10. In the feed sample, 22/167 rows (13%) are transport_name='Vlastní' (self-drive — mostly Itálie and Chorvatsko), and nights span 3,4,5,6,7,8,9,10,11,12,13,14. normalizeTransport handles 'Vlastní' -> 'own' correctly, so this is purely a consequence of which pages get fetched.

### 6.

FIELD: stars rounds a half-star category UP where the site rounds it down. https://www.alexandria.cz/hotel/9109-aguamarina-alexandria-club — API accommodation_category = 3.5 (also hotel_category:3.5 in the page's own payload), the site's H1 renders 'hotel Aguamarina Alexandria Club ***' (three stars), the adapter emits stars=4 via Math.round. Rare — 1 of 219 sampled rows had a fractional category — but it is a real one-star inflation on exactly the rows where star count is borderline.

### 7.

FIELD: the offer URL drops the term identifier, so the deep link can open a different departure date and a different price than the offer on the board. The site's own search-result links are /hotel/<detail>?ages=1_20%7C2_20&autofixes=<term> (e.g. autofixes=2910902 for Belvedere), and every API row already carries that `autofixes` value; the adapter emits a bare https://www.alexandria.cz/hotel/<detail>. Verified concretely: the adapter's Adi Dharma offer is 2026-08-03, 84,848 CZK total / 42,424 CZK per person, but opening https://www.alexandria.cz/hotel/BV_281-adi-dharma-hotel-kuta renders term '24.08. – 02.09.2026 (10 dní / 7 nocí)' at 'Celkem za 2 osoby 101 198 Kč / Osoba za 50 599 Kč' — a 19% higher price and a three-week-later departure than the board would show.

### 8.

FIELD (latent, does not affect today's 46 offers): country_name values like 'Itálie (zima)' fail isKnownCountry (normalizeCountry splits on /[\/,–-]/, which does not strip the parenthesis), so those rows get country=null. Since computeMatchKey and computeHotelKey both return null when country is null, those offers are silently opted out of cross-source matching and the hotel discount-reference rung. 10 of 167 sampled feed rows are 'Itálie (zima)'; none are in pages 1-2 today, so this only bites once coverage is widened.

## Důkazy z auditu

Ran the adapter live via a throwaway ./._audit_alexandria.mts (imported { alexandria } from './src/sources/alexandria.js' + HttpClient, ctx = { http, adults: 2, log }), executed with npx tsx, then deleted the script (confirmed gone; git status clean apart from other auditors' files). Result: 46 offers across 9 queries. Price per person min 17,990 / median 24,990 / max 103,656. Countries: Řecko 14, Bulharsko 10, Indonésie 10, Turecko 6, Albánie 2, Itálie 2, Černá Hora 1, Španělsko 1. Bands (per person): <5k 0, 5-10k 0, 10-20k 7, 20-40k 29, 40k+ 10. Departure dates 2026-07-31 to 2026-08-21. Zero null-country rows, zero fallback URLs.

Site probes (curl, Chrome UA, ~2s between requests; plus a browser render for the two price checks):
- https://bck-new.alexandria.cz/web-search?page=1 -> HTTP 200, total 1042, 18 packages. Same request repeated later -> identical tour_id order (deterministic feed).
- Pages 3, 5, 10, 15, 25, 30, 40, 45, 50, 58, 59 sampled -> 167 rows total, 27 distinct country_name values, per-person 3,776 to 115,290, 22 rows transport 'Vlastní'.
- limit=60 / per_page=60 / size=60 / sort=price_asc all still return 18 rows -> no way to widen a page.
- Each hardcoded exotic id: 3175/8288/3030/5899/3163/453555 -> total 0; 453246 -> total 10 (Indonésie).
- https://bck.alexandria.cz/filter-location -> 62 top-level entries; 3175 Maledivy, 8288 S.A. Emiráty, 3030 Dominikánská republika, 3163 Mexiko, 5899 Seychely all "available": false; new block 460916-460954 all "available": true.
- New ids probed: 460931 Maledivy total 1 (60,292 for 2), 460952 Srí Lanka total 1 (50,586), 460948 Mexiko total 1 (57,638), 460951 Mauricius total 1 (87,248), 460936 USA total 20, 460918 Japonsko total 2, 5864 Plavby total 3, 7963 Poznávací zájezdy total 5.

Field checks against the offers' own pages:
1) https://www.alexandria.cz/hotel/4782-belvedere-alexandria-club — site shows "Termín 02.08. – 09.08.2026 (8 dní / 7 nocí)", "Doprava Letecky - Praha", "Strava All Inclusive", "Původní cena 74 980 Kč", "Ušetříte celkem 27 000 Kč", "Celkem za 2 osoby 47 980 Kč", "Osoba za 23 990 Kč", breadcrumb Bulharsko / Primorsko, hotel_category 5. Adapter: departureDate 2026-08-02, nights 7, transport flight, board AI, priceTotal 47980, pricePerPerson 23990, claimedOriginalPrice 37490 (= 74980/2), claimedDiscountPct 36 (27000/74980 = 36.0%), country Bulharsko, locality Primorsko, stars 5. Exact match on every field.
2) https://www.alexandria.cz/hotel/BV_281-adi-dharma-hotel-kuta — site H1 "Adi Dharma Hotel Kuta ****", breadcrumb Indonésie / Bali, "Strava Bez stravy", "10 dní / 7 nocí", and prints "Celkem za 2 osoby 101 198 Kč / Osoba za 50 599 Kč" for its default term — i.e. the site itself computes per person = total/2, confirming the adapter's package_price/persons formula on the BV_/Worldee partner inventory too. The adapter's own row for this hotel (start 2026-08-03, package_price 84848, persons 2, original_price == package_price) maps to 42,424 CZK/person with claimedOriginalPrice/Pct null — arithmetically correct, but the URL it emits opens the 24.08. term at 50,599 CZK/person (see the URL finding).
3) https://www.alexandria.cz/hotel/9109-aguamarina-alexandria-club — API accommodation_category 3.5, site H1 renders three stars, adapter emits 4.

I did not click the cookie consent banner on alexandria.cz (that needs your approval); all price/date/board readings above came from the rendered DOM behind it or from the JSON API.

## Adversariální ověření

- **VYVRÁCENO — neopravovat** (none): REFUTED. The reporter's raw observations reproduce, but the inference they rest on ("retired, not seasonally empty") is contradicted by the source's own live frontend.

WHAT I REPRODUCED (all true): each of 3175/8288/3030/5899/3163/453555 returns total=0 today; 453246 returns 10 (Indonésie); filter-location marks the first five available:false and 453555 is absent from that tree; the 460916-460954 block returns offers (460931 Maledivy 1, 460952 Srí Lanka 1, 460936 USA 20, 460918 Japonsko 2).

WHY IT IS NOT A DEFECT — five independent disproofs of "retired":

1. Alexandria's own production Exotika page still queries exactly these ids. Fetching https://www.alexandria.cz/zajezdy/exotika shows the embedded RSC payload calling searchQuery.location = "3175|3030|453702|453225|3201|3163|8288|5899|453555|453226", and the homepage nav config carries the same list as the Exotika category's source_url. The operator's live frontend uses these ids today — including 453555. They are the current canonical exotika taxonomy, not retired ids.

2. The site defines what available:false means, and it is not "retired". Its own i18n bundle: search-form.location.disabled = "Všechny zájezdy v této destinaci jsou nyní vyprodané." ("All trips in this destination are now sold out.") — a transient no-inventory state.

3. Corroborated by other nodes: 1100 "Rakousko (zima)", 5459 "Rakousko" and 9329 "Slovinsko" are also available:false. Alexandria has plainly not retired Austrian skiing in July. Also, 3175 still carries its full 12-child atoll taxonomy in filter-location (Baa Atol, Dhaalu Atol, Severní Ari Atol, …) — a retired destination would not keep a live sub-tree.

4. Absence from filter-location proves nothing here: three of the site's own exotika nav ids (453702, 453555, 453226) are absent from the tree while the site actively queries them. That endpoint is not the authoritative id list.

5. ZERO coverage is actually lost. I ran the operator's own full exotika query (location=3175|3030|453702|453225|3201|3163|8288|5899|453555|453226) -> total=10, all Indonésie. That is exactly the 10 Bali rows the adapter already collects via 453246. The adapter captures 100% of Alexandria's currently sellable exotika inventory; the 6 empty ids are not hiding anything.

This is false-positive category (c), intentional documented design. alexandria.ts lines 12-16 state the exotic feeds are "often seasonally empty" in summer and are queried anyway because they are "cheap, bounded" so "coverage flips on automatically once the winter catalogue goes on sale"; verification note (b) at line 26 already recorded location=3175 -> total 0 on 2026-07-07 and labelled it "seasonally empty in July". Today is 2026-07-29 — still July. The 9-request budget is explicit at line 69.

THE 460xxx BLOCK IS MISCHARACTERIZED. All 39 nodes have worldee:true and foreign_id WORLDEE_XX_13 — a third-party partner marketplace, and mostly not exotic at all (Dánsko, Estonsko, Finsko, Belgie, Maďarsko, Rumunsko, Irsko, Norsko, Švédsko…). It is a separate product line newly resold by Alexandria, not "the new home of the exotic inventory". Its exotic entries are one-offer stubs (Maledivy 1, Srí Lanka 1, Mexiko 1, Mauricius 1). Wiring it in would be a coverage ENHANCEMENT costing ~39 extra requests (4x the documented budget), not a fix for a broken slice.

Only genuinely soft point: the reporter's counterexample that winter product is already on sale — location=147 "Itálie (zima)" does return 41 packages with Dec 2026 departures. That shows the winter catalogue is partly live while exotika is not. But Czech charter exotika has its own later sale cycle, and it does not override points 1-5: the operator itself is still pointing its Exotika category at these ids.

Cost of the status quo is 6 HTTP requests per scan that return {"total":0} — explicitly budgeted and accepted in the header comment, with no offers missed. No code change warranted.

Files: /Users/daniel/Library/CloudStorage/OneDrive-Osobní/Effistream/dovolenky/src/sources/alexandria.ts (header lines 12-16 and 26, EXOTIC_LOCATION_IDS line 70). No throwaway script was needed or created; repo working tree unchanged.
- **POTVRZENO** (medium): POTVRZENO (medium), i když jsem se to snažil vyvrátit hlavně přes „intentional design" a povedlo se to jen zpola.

Co jsem si sám ověřil (žádné převzaté číslo):
1) Fakta sedí. `GET https://bck-new.alexandria.cz/web-search?page=1` (Chrome UA) → HTTP 200, `total: 1042`, 18 packages. Poslední stránka je 59 (1 řádek). `DEFAULT_FEED_PAGES = 2` je na /Users/daniel/Library/CloudStorage/OneDrive-Osobní/Effistream/dovolenky/src/sources/alexandria.ts:65 a test tests/alexandria.test.ts:214 pinuje přesně 9 requestů (p1, p2 + 7 exotických location). Tedy 36 z 1042 řádků = 3,5 %.
2) Determinismus okna sedí. Refetch page 1 s odstupem vrátil identické pořadí tour_id — a je to týž seznam ['4782','8369','10142','11390','313','10585','210','10576','11380','11164','10801','11376','9109','6269','8364','5300','350','10434'], jaký hlásil auditor. Není to drift-sample, je to fixní okno.

Pokus o vyvrácení přes (c) intentional design — částečně obstojí: header komentář („two pages keep the request budget small while still surfacing the current-season deals the operator front-loads") i spec docs/superpowers/specs/2026-07-04-dovolenky-design.md §16.1 („Alexandria ~8-10" requestů/scan) tohle vědomě rozpočtují. A front-loading je REÁLNÝ: median claimed slevy klesá monotónně p1 40,5 % → p2 33 % → p3 23 % → p6 17,5 % → p12 17 % → p20 17 % → p30 0 % → p40 0 %. Zhruba polovina feedu (str. ~26-59) nemá slevu vůbec.

Proč to přesto padá — test proti vlastním profilům uživatele: pustil jsem `parseAlexandria` + `matchProfiles` s config/watch.yaml na živých stránkách (throwaway ./._verify_alexandria_9.mts, už smazán, git status čistý až na cizí soubory).
- str. 1-2 (co adapter čte): 21 profile matchů, cena/os 17 990-24 990.
- Samotné NEČTENÉ str. 3 a 6: taky 21 matchů, ale za 10 990-19 590 Kč/os s claimed slevou 15-36 %.
- Se str. 12/20/40 je to 27 matchů na 5 nečtených stránkách (z 57 nečtených).
Feed je řazený tak, že koreluje s claimed % na drahém 5* „Alexandria Club" produktu — tedy hlava feedu je zároveň ta nejdražší část, zatímco profily mají `max_price_per_person` 20 000 (last-minute) a 25 000 (leto-more). Okno tedy over-sampluje přesně to, co filtr odstřelí, a míjí levné bulharské last-minute řádky, na které je profil `last-minute` postavený. Ostatní false-positive kategorie neplatí: nejde o chybějící pole ani o jiný termín než teaser — auditorovy field checky (i moje data na p1) jsou po polích správně, každý emitovaný řádek je korektní.

Proč medium a ne high: není to correctness bug, jen recall. Adapter dělá, co je zdokumentováno a otestováno, respektuje politeness i per-source budget; část chybějící inventory může pokrývat některý z agregátorů v projektu (invia/zajezdy/dovolena/skrz prodávají i CK inventory) — to jsem neověřoval, a je to jediný důvod, proč to netlačím výš. Fix je jednořádkový (zvýšit DEFAULT_FEED_PAGES), cena je 3 s per-host gap na stránku + úprava rozpočtu v §16.1; API nepodporuje sort (na rozdíl od cedok.ts, který čte 4 stránky, ale s `order=priceAsc`, takže jeho okno je s produktovým filtrem srovnané), takže víc stránek je jediná páka.
- **POTVRZENO** (medium): POTVRZENO (s korekcí rétoriky a severity na medium). Ověřoval jsem nezávisle, vlastními curl requesty (Chrome UA, ~2-3 s odstup) a čtením /Users/daniel/Library/CloudStorage/OneDrive-Osobní/Effistream/dovolenky/src/sources/alexandria.ts; skript v repo rootu jsem nevytvářel (git status je beze změny), adapter jsem rekonstruoval z jeho vlastního query setu.

CO SEDÍ. `DEFAULT_FEED_PAGES = 2` (řádek 65) + 7 exotických location ids = 9 requestů. Moje fetche: page 1 a 2 → min cena/os. 17 990 na obou stránkách (medián ~23 990), location=453246 (Bali) → 10 řádků, min 42 424, location=3175 a 8288 → total 0. Adapter tedy skutečně nemůže vrátit nic pod 17 990, aniž bych ho musel spouštět; čísla auditora (46 nabídek, min 17 990) sedí. Feed má total 1042, adapter čte 36 řádků default feedu, tj. 3,5 %. Page 3 hned obsahuje 10 990 / 11 990 (3×) / 12 480 / 12 990 / 13 480 / 15 990; `?page=1&sort=price` (sort server-side FUNGUJE) vrací hlavu 3 351 / 3 495 / 3 776 (Rumunsko, 3 noci) / 4 275 (Maďarsko) / 5 252 (Srbsko) — přesně čísla z reportu.

PROČ TO NENÍ ARTEFAKT VZORKU. Medián claimed slevy podle stránky: p1 40,5 % / p2 33 / p3 23 / p6 18 / p12 17 / p30 0 / p58 0 — default feed je řazený zhruba podle „deal-ness". Levný inventář (Worldee city-breaky, 3 noci, `original_price == package_price`, tj. nulová sleva) se do tohoto řazení strukturálně nikdy nedostane na p1-2. Opakovaný fetch page 1 → identické pořadí tour_id (deterministické). Gap je tedy systematický, ne rotující.

MATERIALITA PROTI VLASTNÍMU configu. config/watch.yaml, profil `last-minute` (jediný s notify_new_offers: true): max_price_per_person 20000, min_real_discount_pct 25, departure_within_days 14. Z 36 řádků, které adapter čte, je ≤20k & claimed ≥15 % jen 6 řádků. Samotná page 3 jich má 10 (7 z nich ≥25 % a s odletem do 2026-08-12, tedy v okně), page 6 dalších 12. Slepé místo adapteru je přesně cenové pásmo, na které míří notifikující profil.

CO Z REPORTU NEBERU. (1) Srovnání s homepage „od" teasery je nepodložené — to jsou jiné termíny/produkty; hlava sort=price ukazuje, že nejlevnější tail jsou 3noční Worldee city-breaky s nulovou slevou, které by min_real_discount_pct stejně odfiltroval. Nález stojí sám na datech feedu. (2) „Celá levná polovina" je rétorika; naměřený podíl pod 17 990 je ~1/3 řádků.

PROČ NEOBSTOJÍ OBHAJOBA „ZÁMĚRNÝ DESIGN". Header komentář 2 stránky dokumentuje a jeho zdůvodnění („deals the operator front-loads") empiricky platí — p1-2 opravdu je špička žebříčku slev, to je reálná mitigace. Nepokrývá ale tvrdý cenový floor a rozpočtový argument neobstojí: spec §16.1 dává Alexandrii ~8-10 requestů/scan a 6 z současných 9 míří na trvale mrtvá location ids (3175, 8288 mnou ověřeny total 0). Přesměrování těch šesti na page 3-8, případně jeden `?sort=price` dotaz, stáhne floor na ~11k za nulový přírůstek requestů — coverage gap tedy není inherentní tradeoff, ale misalokace.

SEVERITY medium, ne high: jde o neúplnost, ne nesprávnost (mapování polí je korektní a špička slev z tohoto zdroje na board dorazí), a úplný spodní tail je nediskontovaný. Fix je ale levný a chybějící pásmo koliduje s cenovým stropem notifikujícího profilu.

BONUS (mimo tento nález, ale relevantní při prohloubení stránkování): u levných Worldee řádků je `detail` plná URL (https://alexandria.worldee.com/cz/trip/detail?tripId=...), takže mapPackage by vyrobil rozbité `https://www.alexandria.cz/hotel/https://alexandria.worldee.com/...`.
