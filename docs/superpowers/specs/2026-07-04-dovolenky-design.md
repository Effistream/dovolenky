# Dovolenky — osobní hlídač zájezdů (design spec)

Datum: 2026-07-04 · Stav: schváleno uživatelem (varianta A)

## 1. Cíl

Osobní aplikace, která pravidelně sleduje nabídky českých cestovních kanceláří a agentur,
ukládá cenovou historii, počítá **reálnou slevu** (vs. uváděnou „přeškrtnutou" slevu)
a posílá notifikace na Telegram. Uživatel: jeden (Daniel). Žádné UI ve v1 — konfigurace
souborem, výstup Telegram.

Sledované scénáře (watch profily):
1. **léto-moře** — letecké zájezdy k moři, all-inclusive, hlavní sezóna (červen–září).
2. **last-minute** — cokoliv výhodného s odletem ≤ 14 dní, klíčové kritérium vysoká reálná sleva.

## 2. Architektura

Jeden TypeScript projekt („scan worker"), bez frameworku:

- **Node 24 + TypeScript** (spouštění přes `tsx`), npm.
- **DB: libsql + Drizzle ORM** — lokálně `file:./data/dovolenky.db`; při přechodu na Vercel
  se jen přepne `DATABASE_URL` na Turso (stejný driver i dialekt, žádná migrace kódu).
- **HTTP: nativní `fetch`** + malý wrapper (retry s backoffem, rate-limit 3 s/host, browser UA).
- **Parsing: cheerio** (HTML zdroje) + ruční JSON parsing; **zod** validace normalizovaných nabídek.
- **Telegram: raw Bot API** přes `fetch` (sendMessage, HTML parse mode) — žádná bot knihovna.
- **Scheduler lokálně: launchd** — jeden job `scan` každé 2 h; digest se posílá z běhu scan,
  který proběhne v okně 7:30–9:30 a digest ještě nebyl ten den odeslán (není třeba druhý job).
- **Vercel (fáze 2, mimo scope v1):** cron route `api/cron/scan` importující tentýž core;
  DB Turso. Kód psát tak, aby core neměl závislost na fs/procesech mimo config load.

### Struktura projektu

```
src/
  core/
    types.ts          # NormalizedOffer, SourceResult…
    config.ts         # načtení + zod validace config/watch.yaml a .env
    db/schema.ts      # Drizzle schéma
    db/index.ts       # klient
    ingest.ts         # upsert nabídek + snapshoty
    discount.ts       # výpočet reálné slevy, fake-flag
    filters.ts        # vyhodnocení watch profilů
    notify.ts         # rozhodnutí co poslat (dedup) + fronta zpráv
    telegram.ts       # Bot API klient
    format.ts         # formátování zpráv (HTML)
    http.ts           # fetch wrapper (retry, rate-limit, UA)
  sources/
    index.ts          # registr zdrojů
    invia.ts  fischer.ts  eximtours.ts  cedok.ts  bluestyle.ts
    zajezdy.ts  dovolena.ts  etravel.ts  skrz.ts
    der.ts            # sdílený základ pro DER Touristik platformu (fischer/exim/etravel)
  cli/
    scan.ts           # npm run scan [--source=X] [--dry-run] [--no-notify]
    digest.ts         # npm run digest (ruční vyvolání)
    telegram-setup.ts # npm run telegram:setup (zjistí chat_id)
tests/
  fixtures/<source>/  # uložené reálné odpovědi (JSON/HTML)
  <source>.test.ts    # unit testy parserů (vitest)
config/watch.yaml
ops/launchd/          # plist + install.sh
data/                 # SQLite soubor (gitignored)
```

## 3. Zdroje dat (výsledek reconu 2026-07-04)

Všech 9 zdrojů v1 jde přes plain HTTP (žádný headless browser). Slevomat má Cloudflare
managed challenge → ve v1 jeho travel nabídky bereme přes Skrz.cz (agreguje je);
přímý adapter případně později.

| # | Zdroj | Strategie | Klíčové detaily |
|---|-------|-----------|-----------------|
| 1 | **Invia** | POST `https://www.invia.cz/search-results/ajax-boxes` (JSON body `nl_*` parametrů; double-submit CSRF: vygenerovat token, poslat header `X-CSRF-Token: <t>` + cookie `__Host-csrf-token_<t>=csrf-token`) | Odpověď `customData.boxes` = HTML ~15 karet; parsovat GA4 JSON z atributů `data-gtm`/`data-ga-click-data-value` (hotel, cena, CK, destinace, strava, doprava) + dekódovat JWT v `s_offer_id` linku (hotelId, termId, checkInDate/OutDate, mealId, departureAirport, tourOperatorId). Stránkování: `searchProps.offsets` cursor. Sleva jen badge „Sleva - X%" → původní cena dopočtem. Fallback: SSR `/last-minute/`, `/dovolena/last-minute/<zeme>/`. |
| 2 | **Fischer** | GET `/last-minute` → hydration JSON v `div[data-component-name="appTourList"] script[type="application/json"]` → `documentGuid`; POST `/api/TourList/getTourList` (paged), POST `/api/TourList/getTourHotelList` per tour | Ceny `adultPriceFrom.amount` / `adultPrice.amount` (CZK). Původní cena: GET `/searchresult/getsearch` → v `HTML` poli `js-roomPrice-originalPrice` (line-through), `js-roomPrice-discount`; nejčistší je embedded `dataLayer` ecommerce JSON (name, id, price, dimension4=cena/os, dimension15=strava, dimension18=hvězdy). HEAD vrací 404 → jen GET. |
| 3 | **Exim** | GET `/searchresult/getsearch?ds=0&tt=1&d=<ids>&dd=<od>&rd=<do>&nn=7|10|14&ac1=2…` — query stringy převzít z `searchUrl` hodnot v SSR `GroupSearch2` JSON na `/last-minute` | JSON s polem `HTML` (karty): `js-roomPrice-adult0`, `js-roomPrice-total`, `js-roomPrice-originalPrice` (přeškrtnutá), `js-totalDiscount--amount`. 20/str., `paging.RowsToSkip`. Sleva % se dopočítává (`discount/original*100`). |
| 4 | **Čedok** | GET `https://www.cedok.cz/last-minute/?page=N` — SSR, 50 karet/str. (~68 stran; řadit `&order=priceAsc`, příp. podcesty `/last-minute/recko/`) | Selektory dle `data-testid`: `offer-list-item`, `current-price`, `base-price` (přeškrtnutá, ~80 % karet), `offer-list-item-destination`; hotel z href detailu; datum/doprava/strava z textu karty. NEpoužívat `/api*` (robots disallow). Cloudflare pasivní — browser UA stačí. |
| 5 | **Blue Style** | GET `/last-minute/` + per-country stránky ze sitemap; parsovat `<script id="__NEXT_DATA__">` → apolloState, objekty `CheapestTerm-*` | Pole: hotelName, hotelStars, destinationName, boardingType, roomType, departureDate, dayCount/nightCount, priceFrom, percentageDiscount, url (deep-link). Původní cena neexistuje → dopočet `priceFrom/(1-pct/100)`. |
| 6 | **Zajezdy.cz** | GET `https://last-minute.zajezdy.cz/<slug>/` pro sadu destinačních slugů (recko, egypt, chorvatsko, all-inclusive, letecky-praha…); parsovat `window.searchData` JSON | `tourResults[]` (10/str.): startingPrice.amount, departures[] (totalAdultPrice, odjezdPrijezd, strava, letiste), label `poSleve` („po slevě 30 %"). Robots: /api/ a ?page= zakázané → jen top-10 z více listing URL. **Crawl-delay 5 s, requesty jen 08–24 h.** |
| 7 | **Dovolena.cz** | GET `https://dovolena.cz/api/trip-listing/tripListing?destination=<id>&adult=2&page=N…` (10/str.; provozuje Student Agency) | `hotels[].priceInfo.regular.amount` (za os.) + `.group.amount`; strava/doprava v additionalInfo; sleva jen label `discounticon` — původní cena neexistuje. ⚠️ robots.txt zakazuje `/api/` — akceptováno pro osobní použití při 1×/2 h a malém počtu dotazů (vědomé rozhodnutí, viz §9). |
| 8 | **eTravel** | GET `/api/searchapi/getsearchresult?d=<id>&dd=&rd=&nn=&ac1=2&ilm=1…`; číselníky destinací z `/api/searchfilter/getfilter` | `tours[]`: hotel.name, breadcrumbs (země/destinace), date.from/to, price.total, price.adultPrice, price.discount, **price.lowestPrice = Omnibus 30denní minimum**, discountPill. Bez auth, robots permisivní. |
| 9 | **Skrz** | GET fixní sada listing URL (`/dovolena-more/destinace:<slug>`, `/pobyty/destinace:<slug>` ze sitemap.xml); parsovat escaped `"deals":[…]` JSON z RSC payloadu | Pole: title, **serverTitle (zdrojový portál, vč. „Slevomat")**, priceFinal, discountInPercent, breadcrumbs (země>region>město), board, days/nights, persons, transport, deptPlace, merchant{title=hotel, stars}, detailUrl (`?dt=` = datum odjezdu u zájezdů). 24 nabídek/URL, offset nefunguje → pokrytí šířkou URL. Vyhnout se `/koupit/`, sort/filter variantám (robots). |
| 10 | **Dovolenkovani.cz** (přidáno 2026-07-07) | White-label platformy **CESYS** (TRAVEL Group s.r.o.). Hybrid: (a) GET `https://dovolenkovani.cz/accommodations.xml` → mapa hotel id→{slug, URL} (kód `6a` → id 6); (b) GET `https://api-ng.cesys.eu/online/v1.4/cs/mapping/countries?client_id=12274&lang=cs` → id→země; (c) POST `https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12274&lang=cs` (Content-Type application/json, **bez auth** — ověřeno curl) s body {page, date{from,to}, duration{from,to}, composition{adults:2,children:[]}, price{from,to}, transport_id:["1"], rows_on_page:30, sort:["price asc","date_from asc"], client_id:"12274", customer_id:"2119"} — funguje i bez hotel_id (cross-hotel). | Odpověď `data.dates[]`: master_id (hotel id), date_from/date_to (ISO), duration_night, boarding ("All inclusive"), boarding_id, transport ("Letecká"), airport/airport_code (PRG), price_from.CZK (float — **ověřit per-person vs total pro adults:2!**), discount + discount_percent (ve vzorcích null — guard), country (číselné id → mapping), destination (id, ve v1 nemapovat), rating (hvězdy float), tour_operator.name (agreguje Čedok aj.), last_minute (bool), package_id. Jméno hotelu jen číselně → doplnit ze sitemap mapy, jinak „Hotel <id>". ⚠️ robots.txt dovolenkovani.cz jmenovitě blokuje ClaudeBot aj. — používat výhradně standardní Chrome UA projektu; api-ng.cesys.eu je interní API třetí strany → vědomá odchylka dle §9, max ~6 requestů/běh. |

Politeness pravidla společná: ≥3 s mezi requesty na tentýž host (Zajezdy 5 s), Chrome UA,
1 běh / 2 h, cíl ~50–150 requestů/běh celkem. Fischer/Exim/eTravel sdílejí platformu
DER Touristik → společný helper `der.ts`.

## 4. Normalizovaná nabídka

```ts
interface NormalizedOffer {
  source: string;             // 'invia' | 'fischer' | …
  sourceOfferKey: string;     // stabilní klíč v rámci zdroje (nativní ID, jinak hash(title+datum+noci+strava))
  title: string;              // název hotelu/nabídky
  country: string | null;     // normalizovaný název země
  locality: string | null;
  stars: number | null;
  board: 'AI' | 'FB' | 'HB' | 'BB' | 'none' | 'unknown';
  transport: 'flight' | 'own' | 'bus' | 'unknown';
  departureAirport: string | null;
  departureDate: string | null;  // ISO
  nights: number | null;
  pricePerPerson: number;        // CZK — hlavní sledovaná cena
  priceTotal: number | null;
  claimedOriginalPrice: number | null;  // přeškrtnutá, je-li
  claimedDiscountPct: number | null;    // uváděná sleva
  omnibusLowestPrice: number | null;    // jen eTravel
  tourOperator: string | null;
  url: string;
}
```

Mapování stravy/dopravy/zemí: malé slovníky v `core/normalize.ts` (české názvy → enum).

## 5. Datový model (Drizzle / libsql)

- **offers**: id, source, source_offer_key (unique per source), title, country, locality,
  stars, board, transport, departure_airport, departure_date, nights, tour_operator, url,
  first_seen_at, last_seen_at, active (bool — nabídka zmizela ze zdroje → false).
- **price_snapshots**: id, offer_id → offers, captured_at, price_per_person, price_total,
  claimed_original_price, claimed_discount_pct, omnibus_lowest_price.
  Zápis: jen když se cena změnila proti poslednímu snapshotu, NEBO poslední snapshot > 24 h
  (denní heartbeat). Jinak jen update offers.last_seen_at.
- **notifications_log**: id, offer_id, type ('hot_deal'|'price_drop'|'new_offer'|'digest'),
  sent_at, price_at_send.
- **source_runs**: id, source, started_at, finished_at, offers_found, snapshots_written,
  error_count, status ('ok'|'partial'|'failed'), error_sample.

## 6. Reálná sleva

Reference (od nejsilnější, použije se první dostupná; u výsledku se uvádí, která to byla):

1. **Vlastní historie nabídky**: medián price_per_person ze snapshotů téže nabídky za
   posledních 30 dní (bez dneška), pokud existují ≥3 snapshoty s rozpětím ≥5 dní.
2. **Omnibus** (jen eTravel): `lowestPrice` = zákonné 30denní minimum.
3. **Tržní baseline**: medián price_per_person aktivních nabídek ve stejném koši
   (země × měsíc odletu × pásmo nocí [≤5, 6–8, 9–12, 13+] × strava × hvězdy),
   pokud koš má ≥8 nabídek napříč zdroji. Pokrývá nabídky viděné poprvé.

`realDiscountPct = (baseline − current) / baseline × 100` (může být záporná = zdražení).

**Fake-sleva flag**: `claimedDiscountPct − realDiscountPct ≥ 15` p. b. → ⚠️ „nadsazená sleva".

**Studený start** (~prvních 14 dní): dokud není dostupná žádná reference, notifikace
uvádějí jen uváděnou slevu s poznámkou „reálná sleva: sbírám historii".

## 7. Notifikace (Telegram)

Typy a podmínky (vyhodnocuje se po každém scanu):

| Typ | Podmínka | Default práh |
|---|---|---|
| 🔥 hot_deal | nabídka odpovídá profilu ∧ realDiscount ≥ práh profilu | 15 % (léto-moře), 25 % (last-minute) |
| 📉 price_drop | existující nabídka odpovídající profilu klesla vs. předchozí snapshot | ≥ 10 % |
| 🆕 new_offer | nově objevená nabídka odpovídá profilu (vypínatelné per profil) | zapnuto |
| ☀️ digest | 1× denně ~8:00: top 10 aktivních nabídek dle realDiscount napříč profily + mini-statistika (počet aktivních nabídek, počet nových za 24 h, medián ceny per profil) | — |

**Dedup**: tatáž nabídka + typ se znovu pošle jen když cena klesla o dalších ≥5 %
od `price_at_send`, nebo po 7 dnech. new_offer se posílá max 1× za život nabídky.
Rate-limit: max ~20 zpráv/běh; přebytek se shrne („+ dalších N nabídek splnilo podmínky").

**Formát zprávy** (HTML parse mode):

```
🔥 Hotel Peniscola Plaza ★★★★ — Španělsko, Peñíscola
🗓 15.07.–22.07. (7 nocí) · ✈️ Praha · All inclusive
💰 16 990 Kč/os. (uvádí slevu −45 %)
📊 Reálná sleva −22 % vs. 30denní medián 21 800 Kč ⚠️ nadsazená sleva
🔗 <odkaz> · zdroj: Fischer
```

**Setup**: uživatel založí bota u @BotFather → `TELEGRAM_BOT_TOKEN` do `.env`;
`npm run telegram:setup` počká na zprávu botovi a vypíše/uloží `TELEGRAM_CHAT_ID`.
Admin alerty (rozbitý scraper) jdou do téhož chatu s prefixem 🛠.

## 8. Konfigurace (`config/watch.yaml`)

```yaml
profiles:
  leto-more:
    enabled: true
    countries: [Řecko, Turecko, Egypt, Španělsko, Kypr, Bulharsko, Chorvatsko, Itálie]
    transport: flight
    board: [AI]
    departure_months: [6, 7, 8, 9]
    max_price_per_person: 25000
    min_real_discount_pct: 15
    notify_new_offers: false
  last-minute:
    enabled: true
    countries: []            # prázdné = všechny
    departure_within_days: 14
    min_real_discount_pct: 25
    max_price_per_person: 20000
    notify_new_offers: true
notifications:
  price_drop_pct: 10
  renotify_drop_pct: 5
  renotify_after_days: 7
  max_messages_per_run: 20
  digest_hour: 8
scan:
  adults: 2
  min_request_gap_ms: 3000
```

## 9. Compliance & etika

- Frekvence 1×/2 h, ~50–150 requestů/běh celkem přes 9 hostů — hluboko pod běžným
  provozem jednoho návštěvníka.
- Respektujeme robots.txt kde to jde (Čedok bez /api*, Zajezdy bez /api/ a ?page=,
  Skrz bez /koupit/ a filter variant, Invia primárně přes čisté LM cesty).
- Vědomé odchylky (osobní použití, minimální zátěž): Invia ajax-boxes endpoint,
  Dovolena.cz tripListing API. Pokud zdroj začne vracet 403/429, adapter se automaticky
  odmlčí (backoff na 24 h) a pošle admin alert.
- Žádné obcházení captchy/anti-botu ve v1 (proto Slevomat jen přes Skrz).

## 10. Error handling

- Každý zdroj běží izolovaně (Promise.allSettled) — pád jednoho neshodí scan.
- HTTP wrapper: 2 retry s exponenciálním backoffem na 5xx/network; 403/429 → okamžitě
  vzdát zdroj pro tento běh a zapsat do source_runs.
- Zdroj selže 3 běhy po sobě → 🛠 admin alert na Telegram (jednou, ne opakovaně).
- Parser dostane neočekávaný tvar → zaloguje vzorek do source_runs.error_sample,
  vrátí co šlo (partial), nespadne.
- Nabídka nespatřená 2 běhy po sobě → active=false (nevymazává se — historie zůstává).

## 11. Testy

- **Unit testy parserů (vitest)**: každý adapter má uložené reálné fixtures
  (JSON odpovědi / HTML stránky pořízené při implementaci) a test, že z nich vyparsuje
  očekávané NormalizedOffer[] (počty, vzorové hodnoty, ceny).
- **discount.test.ts**: výpočet reálné slevy vč. edge cases (žádná historie, zdražení,
  fake-flag, koš s <8 nabídkami).
- **filters.test.ts**: matchování profilů.
- **Dry-run**: `npm run scan -- --source=X --dry-run` — vypíše nabídky a zamýšlené
  notifikace do konzole, nic nezapisuje/neposílá. Slouží i k ručnímu ověření živého zdroje.

## 12. Mimo scope v1 (backlog)

- Přímý Slevomat adapter (headless + stealth) — obsah zatím přes Skrz.
- Cross-source dedup (týž hotel+termín u více zdrojů) — v1 je každý zdroj samostatná nabídka.
- Vercel deploy (cron routes + Turso) — architektura na to připravena.
- Telegram příkazy (/top, /pause), web UI, více uživatelů.

## 13. Cross-source dedup (přidáno 2026-07-07)

Stejný fyzický zájezd (hotel × termín × strava × odlet) prodává více zdrojů (Invia, Dovolenkovani,
Skrz… agregují tytéž CK). Bez dedupu hrozí vícenásobné notifikace, duplicitní digest a nadvážení
tržního mediánu.

**Match key** (uložen jako `offers.match_key`):
`sha1[canonName, country, departureDate, nights, board, airportNorm]` kde
- `canonName` = normalizeHotelName(title): lowercase, bez diakritiky, odstranit stopslova
  (hotel, resort, spa, aparthotel, apartments, wellness, &, and, „★"), zkolabovat mezery;
- `airportNorm` = normalizeAirport(departureAirport): město/kód → IATA (Praha→PRG, Brno→BRQ,
  Ostrava→OSR, Pardubice→PED, Vídeň→VIE, Bratislava→BTS, Budapešť→BUD, Katovice→KTW,
  Krakov→KRK, Wroclaw→WRO), null → `*`;
- pokud `departureDate` null nebo `board` unknown → match_key = null (žádné cross-source
  párování; konzervativní: chybné sloučení je horší než nesloučení).

**Konzumenti:**
1. **Notifikace**: kandidáti se před odesláním seskupí podle match_key; posílá se jeden
   (nejlevnější) s řádkem „Také: <zdroj> <cena> Kč" pro alternativy (max 3, seřazené).
   Dedup v `notifications_log` přechází z (offerId, type) na (match_key ?? offerId, type) —
   nový sloupec `match_key` v logu; re-notify pravidla (−5 % / 7 dní) platí pro skupinu.
2. **Digest**: top-10 po seskupení podle match_key (reprezentant = nejlevnější).
3. **Tržní baseline**: v koši se bere MIN(cena) na match_key skupinu (nenadvažovat
   agregovaný inventář).

Fuzzy matching jmen (Levenshtein/token overlap) je mimo scope — jen kanonizace + exact match;
zdokumentovat míru sloučení v testu na reálných fixtures.

## 14. Frontend „Terminál" (přidáno 2026-07-07)

Lokální web dashboard dle schváleného vizuálního návrhu (design-system/MASTER.md,
docs/design/terminal-mockup.html — závazné: tokeny, typografie, layout, copy pravidla).

**Stack:** Vite + React + TypeScript (adresář `web/`), Tailwind v4 s tokeny z MASTER.md
přes @theme; fonty IBM Plex Mono + Barlow lokálně (@fontsource, žádné CDN). API server:
**Hono** (`src/web/server.ts`, `npm run web`, port 4141) — čte stejnou SQLite přes existující
core moduly, servíruje i build frontendu. Fáze Vercel: Hono routes + statický build beze změn
architektury.

**API** (JSON, read-only):
- `GET /api/offers` — aktivní nabídky seskupené podle match_key (reprezentant + alternatives),
  s realPct/reference/fake z computeRealDiscount (own+omnibus+market přes market.ts),
  query params: profile, country, source, minRealPct. In-memory cache 5 min TTL
  (výpočet je N+1 nad koši — lokálně přijatelné, cache to kryje).
- `GET /api/offers/:id/history` — price_snapshots řady + baseline pásmo (medián 30 d)
  + claimed original pro graf.
- `GET /api/sources` — poslední source_runs per zdroj (status, čas, počty, backoff).
- `GET /api/stats` — aktivní počet, nové za 24 h, medián per profil (TRH DNES karta).

**UI komponenty** (dle mockupu 1:1): status řádek, filtr chips (profily single, země multi),
odletová tabule (řádky, sparklines, REÁLNÁ vs UVÁDÍ, NADSAZENÁ flag, „Také:" alternativy),
rozbalený detail (SVG cenový graf s pásmem mediánu, červenou čárkovanou „původní cenou",
fakta, verdikt — bez CTA „Ztlumit" ve v1, jen „Otevřít u <zdroj>"), karty TRH DNES + ZDROJE,
flap animace při načtení (prefers-reduced-motion). Empty state dle MASTER.md copy pravidel.

**Testy:** API endpoints vitest nad in-memory DB (seed přes ingestOffer); frontend jednotkově
jen čisté helpery (formátování, seskupení) — UI se ověřuje Playwright smoke testem
(board se vyrenderuje, filtr filtruje, detail se rozbalí) proti dev serveru se seed DB.

**Mimo scope:** auth (localhost only), mutace (ztlumení nabídek), mobilní aplikace.

## 15. Reálná sleva v2 — žebřík referencí + per-noc (přidáno 2026-07-07, na požadavek uživatele)

Kritika uživatele: srovnávat reálnou slevu proti mediánu příliš hrubého koše (jen země) je
nespravedlivé; medián má být pro podobné hotely/hvězdy v podobné destinaci, a různě dlouhé
pobyty se nesmí míchat.

**Normalizace na cenu za osobu a noc — jen napříč nabídkami.** Cross-offer stupně (hotel/locality/
market) srovnávají jinak dlouhé pobyty, takže se počítají na `pricePerNight = round(pricePerPerson
/ nights)` (nights ≥ 1; při nights null nelze normalizovat → daný stupeň se přeskočí). own a
omnibus naproti tomu srovnávají **stejný termín se stejným počtem nocí** na obou stranách (vlastní
historie téhož termínu / zákonné minimum téhož termínu) — dělení nocemi se v poměru odečte, takže
srovnání na celkové ceně je matematicky totožné s per-noc a zároveň se vyhne zbytečnému dvojímu
zaokrouhlení (round na per-noc cenu, pak zpět na ekvivalent). own a omnibus proto zůstávají na
**celkové ceně za osobu** (jako v1); jen hotel/locality/market jsou nově per-noc. Sledovaná cena
v notifikaci/UI zůstává vždy celková za osobu; u cross-offer stupňů se zobrazená baseline ukazuje
jako **ekvivalent na délku této nabídky** = `baselinePerNight × offer.nights` (stejná jednotka
jako cena nabídky), aby bylo srovnání čitelné. `realPct` se počítá z téhož páru hodnot, který
stupeň vyhrál (celková cena pro own/omnibus, per-noc pro hotel/locality/market) — u cross-offer
stupňů díky dvojímu zaokrouhlení (baseline i realPct se zaokrouhlují nezávisle) se zobrazená
baseline a realPct mohou lišit o ≤1 p.b. od hypotetického přepočtu jedna z druhé; akceptováno.

**Identita hotelu (nová):** `hotelKey = sha1[normalizeHotelName(title), country]` — bez termínu
a nocí (na rozdíl od `matchKey`, který termín má). Null když jméno prázdné nebo země null.
Sloupec `offers.hotel_key` (index, backfill, výpočet v ingest — stejná mašinérie jako match_key).

**Žebřík referencí (priorita, první dostupná vyhrává; `reference` v DiscountResult):**
1. **own** — medián vlastní historie *téhož termínu* (≥3 snapshoty, rozpětí ≥5 dní, 30denní okno
   bez dneška). Beze změny; srovnání na celkové ceně (týž termín na obou stranách, viz výše).
2. **omnibus** — zákonné 30denní minimum (jen eTravel). Srovnání na celkové ceně (týž termín).
3. **hotel** (NOVÉ) — medián `pricePerNight` ostatních aktivních termínů **téhož hotelu**
   (`hotel_key`), stejná strava, nights ±2, departureDate ±30 dní; vyloučit subjekt i jeho
   cross-source dvojčata (`match_key`); min. 4 termíny. „Je tenhle termín levný na tenhle hotel?"
   Per-noc (různé nights v koši).
4. **locality** (NOVÉ) — medián `pricePerNight` koše `locality × měsíc odletu × strava × hvězdy`
   (aktivní nabídky, poslední snapshot, per-noc, vyloučit subjekt+dvojčata); min. 8. Per-noc.
5. **market** (dnešní koš, upravený) — `country × měsíc × pásmo nocí × strava × hvězdy`, ale nově
   **per-noc**; min. 8. Poslední záchrana.

Pro own/omnibus: `realPct = round((baseline − current) / baseline × 100)` na celkové ceně za
osobu. Pro hotel/locality/market: `realPct = round((baselinePN − currentPN) / baselinePN × 100)`
na per-noc ceně; zobrazená baseline je ekvivalent `baselinePN × nights`. Fake flag ≥15 p.b. beze
změny. Guardy: baseline ≤ 0 → stupeň neplatný, propadnout dál. Žádná reference → realPct null +
„sbírám historii".

**Popisky reference (UI i Telegram):** own → „30denní medián", omnibus → „Omnibus 30denní min.",
hotel → „tento hotel", locality → „<lokalita>" (např. „Kréta"), market → „<země>" (např. „Řecko").
Board buňka i detail-verdikt vždy uvedou, se kterým stupněm se srovnává, aby uživatel viděl sílu.

Mimo scope v2: fuzzy matching jmen hotelů (jen kanonizace + exact hotel_key).

## 16. Exotika — 6 nových zdrojů + rozšíření dotazů + profil (přidáno 2026-07-07, na požadavek uživatele)

Uživatel: „A taky mi tam chybí nějaká víc exotika… bylo by potřeba přidat další kolo cestovek
a agentur." Schváleno (AskUserQuestion): všech 6 kandidátů z reconu + rozšíření dotazů
stávajících zdrojů + nový watch profil `exotika`. Recon 2026-07-07 (10 paralelních agentů,
plný výstup v transkriptu): **zamítnuti** marcopolo.cz (mrtvá/parkovaná doména),
kilroy.cz (přesměrování na anglický kilroy.net, konzultativní model bez ceníků),
blueskytravel.cz (marginální katalog ~20-60 nabídek, MagicWare/ASP.NET — backlog).
exotika.cz je 301 alias esotravel.cz (jeden adapter).

### 16.1 Nové zdroje (řádky 11–16 tabulky §3)

| # | Zdroj | Strategie | Klíčové detaily |
|---|-------|-----------|-----------------|
| 11 | **FIRO Travel** (www.firotravel.cz; firotour.cz je mrtvá doména) | Klon CESYS platformy řádku 10 přes sdílenou factory: POST `https://api-ng.cesys.eu/online/v1.4/cs/cesys/dates-list?client_id=12352&lang=cs`, body jako řádek 10 s client_id "12352", customer_id "3593"; GET `/mapping/countries?client_id=12352`; sitemap `https://www.firotravel.cz/accommodations.xml`; detail-redirect fallback jmen hotelů (ověřit URL pattern živě — CESYS variant 11). | Ověřeno živě: price_from.CZK = per-person (adults:1 == adults:2 pro týž master_id). `country_id:["220",…]` v body FILTRUJE server-side; exotické CESYS ids (globální napříč klienty): Thajsko 220, Maledivy 131, Mauricius 138, SAE 198, Dominikánská 46, Mexiko 142, Seychely 192, Srí Lanka 215, Tanzanie 219, Kuba 112, Vietnam 239, Kapverdy 102, Egypt 48. Agreguje Coral Travel, Čedok, TUI, Fischer CK, Rainbow Tours. ⚠️ `sort:["discount desc"]` → server 500, jen price/date_from sorty. discount_percent zpravidla null → guard jako řádek 10. ⚠️ robots.txt jmenovitě blokuje ClaudeBot → výhradně standardní Chrome UA (vědomá odchylka §9, stejná jako řádek 10). |
| 12 | **Alexandria** (alexandria.cz) | Čisté JSON API bez HTML: GET `https://bck-new.alexandria.cz/web-search?page=N[&location=<id>]` → `{packages[], total}`; ~18/str. Exotika je sezónní (zima) → dotazovat exotické location ids + default feed. Location ids ověřené živě: Bali 453246, Maledivy 3175, Emiráty 8288, Dominikánská 3030, Seychely 5899, Mexiko 3163, Srí Lanka 453555. Strom destinací: GET `https://bck.alexandria.cz/filter-location` (jednorázově, ids hardcodovat). | `packages[]`: tour_name (hotel), detail (slug pro URL), country_name/state_name/destination_name, start/end (ISO), days/nights, board_name, transport_name, departure_location_name, accommodation_category (hvězdy), rooms[], persons. **package_price = celková cena za skupinu (2 os.), original_price = přeškrtnutá** → pricePerPerson = package_price/persons; sleva z original_price (0/null → guard). Žádný anti-bot, robots permisivní, otevřené CORS. Bespoke backend (žádná platforma k reuse). |
| 13 | **Deluxea** (deluxea.cz) | SSR Nette: GET country listingy (`/hotely-<slug>/`, slugs ověřit živě ze sitemap; ~8-12 exotických stránek/scan, 8 hotelů/str.). Karta nese **kompletní offer JSON v atributu `data-json`** na `<form class="offline-data hotel-comparator-form">` — HTML-entity-unescape → JSON.parse. Viditelné ceny v DOM jsou „-" placeholdery (hydratace client-side z data-json) → NIKDY neparsovat text DOM. | data-json: price = per-person od-cena klíčovaná nights (`{"7":"37 690"}`, mezera = tisíce), total, total_per_night, old_price/old_total (přeškrtnutá; == price když bez slevy), diff_total (CZK delta, 0 = bez slevy), meal (Snídaně/Polopenze/All Inclusive), full_date („10. 09. - 19. 09. 2026")/date_from/date_to, tickets_company_name (aerolinka). Sleva % dopočtem diff_total/old_price. Jméno hotelu, hvězdy (span.beutystar), země (span.destination-name), lokalita — ze statického HTML karty. Sitemap 1760 URL, drtivě long-haul (Maledivy 113, Emiráty 110, Mauricius 68…). robots: ClaudeBot NEblokován, cílové cesty povolené. |
| 14 | **ESO travel** (esotravel.cz; exotika.cz = 301 alias) | SSR PHP: GET `/dovolena/{country}/zajezdy/` pro exotické země + `/last-minute/zajezdy/` (~10-15 stránek/scan, 15-30 karet/str.; „Načíst další" jen odkrývá už-přítomné `.hidden` karty — žádný další request). | Karta: h2 = název (okruh/hotel), .tour-type span = země, .detail-date = termín, span.days = „15 dní / 12 nocí", div.price strong = od-cena/os. (oddělovač U+00A0!), a[href] s `?termin={id}` = klíč+URL. **Žádná přeškrtnutá cena ani sleva % nikde na webu** (ESO staví na absolutních „od X Kč") → claimed* vždy null; price-drop tracking čistě z našich snapshotů. Board na listingu není → 'unknown'. robots plně permisivní (`Disallow:` prázdné). |
| 15 | **Adventura** (adventura.cz) | SSR PHP+AngularJS (hydratováno server-side): (a) GET `/sitemap.xml` → 969 `/zajezdy/{id}-{slug}/` detail URL; filtr exotických slugů (tokeny zemí) → deterministický bounded výběr; (b) GET až **25 detail stránek/scan**; parsovat `table.date-list` — jeden řádek = jeden termín. ⚠️ NIKDY nepoužívat `?druh=`/`?destinace=` filtr URL (client-side only + částečně robots-blocked `Disallow: /zajezdy/?*&*`). | Detail řádek: td.range span.term („11. 11. – 23. 11. 2026"), td.length („13 dní"), span.price-value strong (aktuální CZK), span.discount-percentage („-2%"), small.line-through.original-price (přeškrtnutá), td.code (kód zájezdu → sourceOfferKey). Země z titulku/p.sub přes isKnownCountry (multi-country okruhy „Réunion a Mauricius" → konzervativně první známá/null). Doprava/strava regex z prózy div.graybox.terms (letecky/snídaně…). Cloudflare pasivní (200 na Chrome UA). ⚠️ robots jmenovitě blokuje ClaudeBot + Content-Signal ai-train=no → výhradně Chrome UA, nízká kadence (odchylka §9). |
| 16 | **Datour** (datour.cz; anchoice.cz whitelabel, agency_id 88) | Čisté JSON API: **GET `https://search.anchoice.cz/web-search?page=N&location=<id>&package=0`** (+ header `Referer: https://datour.cz/`) → `{total, total_docs, packages[]}`, 18/str. Param `location` odchycen živě z frontendu 2026-07-07 (Playwright; URL `/vyhledavani?page=1&location=30182`). Country location ids ověřené živě: Maledivy 30182, Thajsko 29828, Zanzibar 452587, Mauricius 451780, Dominikánská 28824, SAE 30594, Kuba 28796, Vietnam 29920, Seychely 28075, Srí Lanka 450831, Indonésie 29632, Mexiko 29011, Keňa 27990, Filipíny 29724. (POST `/search` z reconu má nefunkční filtr — nepoužívat.) | `packages[]`: tour_name, country_name/country_id, state_name, destination_name, start/end (ISO), nights/days, board_name, transport_name, **unit_price = za osobu** (package_price bývá 0.0 → nepoužívat), original_price + package_discount (často 0 → guard→null), accommodation_category ("3.0" → int hvězdy), provider_name (Čedok, Coral…→ tourOperator), trip_advisor, detail (slug), item_id. Agreguje 23k+ nabídek napříč CK. ⚠️ robots jmenovitě blokuje „claudebot" → výhradně Chrome UA (odchylka §9). ⚠️⚠️ Klientský bundle leakuje Elastic Cloud credentials (index anchoice_live151_2 + heslo) — **IGNOROVAT, nikdy nepoužít**; jediná legitimní plocha je REST API výše. |

Politeness: každý nový zdroj = jiný host → per-host 3s gap platí; rozpočty/scan: FIRO ~4-6
requestů (jako ř. 10), Alexandria ~8-10, Deluxea ~10-12, ESO ~10-15, Adventura ~26 (1 sitemap +
25 detailů), Datour ~8-14. Celkem projekt zůstává v cíli ~50-250 requestů/běh.

### 16.2 Rozšíření dotazů stávajících zdrojů

Exotika je u stávajících zdrojů dostupná, jen se na ni neptáme. Okno dotazů: exotická sezóna
je zima → `date.to` +270 dní (ne +60):

- **zajezdy.cz**: do `SLUGS` přidat živě ověřené exotické slugy (kandidáti: `exotika`,
  `spojene-arabske-emiraty`, `thajsko`, `maledivy`, `zanzibar`, `dominikanska-republika`,
  `mauricius`, `kapverdy`); strop celkem ~12 slugů (5s gap → ~60 s/scan).
- **eximtours**: `TARGET_DESTINATIONS` += SAE, Zanzibar, Maledivy, Thajsko, Dominikánská
  republika, Mauricius, Kuba, Mexiko, Kapverdy (graceful skip „no seed found" už existuje).
- **etravel**: `TARGET_COUNTRIES` += exotické názvy dle číselníku getfilter (discovery by name,
  graceful skip existuje).
- **dovolena.cz**: `DESTINATIONS` += živě ověřená exotická id (metoda discovery v module doc);
  neověřené id NEshipovat (precedens invia).
- **skrz**: `LISTING_PATHS` += `/exoticka-dovolena` a/nebo `destinace:` exotické slugy — jen
  živě ověřené.
- **dovolenkovani**: třetí dates-list query `exotika` přes CESYS factory (country_id exotický
  seznam ř. 11, okno +270 d, duration 7-22, minNights 6).
- **Vynecháno** (zdůvodnění): invia (country ids nelze bez rizika ověřit, last-minute query už
  je country-agnostická), fischer (vlastní /last-minute feed; exotiku od Fischer CK agreguje
  FIRO ř. 11), cedok (last-minute stránky jsou country-agnostické, exotika projde sama),
  bluestyle (katalog ~10 nabídek).

### 16.3 Watch profil `exotika` (config/watch.yaml)

```yaml
exotika:
  enabled: true
  countries: [Thajsko, Maledivy, Mauricius, Spojené arabské emiráty,
              Dominikánská republika, Mexiko, Kuba, Seychely, Srí Lanka,
              Zanzibar, Tanzanie, Vietnam, Indonésie, Kapverdy, Keňa,
              Filipíny, Réunion, Nepál, Peru, Japonsko, Kambodža,
              Madagaskar, Namibie, Jihoafrická republika]
  transport: flight
  board: []               # exotika: BB u Malediv běžná, nefiltrovat stravu
  departure_months: []    # celoročně — hlavní sezóna je zima
  max_price_per_person: 60000
  min_real_discount_pct: 15
  notify_new_offers: false
```

Revize 2026-07-07 (po review Tasku 39): countries rozšířeno o expediční země Adventury
(Nepál, Peru, Japonsko, Kambodža, Madagaskar, Namibie, Jihoafrická republika) — celkem 24;
matchesCountry(null)=false, takže okruhy s nekanonickou zemí stále nenotifikují (konzervativní).

Nové kanonické země v `COUNTRIES` (normalize.ts): Tanzanie, Keňa, Réunion, Filipíny, Kambodža,
Nepál, Peru, Japonsko, Jihoafrická republika, Madagaskar, Namibie. Nové aliasy:
`bali` → Indonésie, `dominikana` → Dominikánská republika.

### 16.4 Compliance shrnutí (doplněk §9)

firotravel.cz, adventura.cz a datour.cz jmenovitě blokují ClaudeBot v robots.txt (deluxea,
esotravel a alexandria nikoliv). Projekt vědomě pokračuje se standardním Chrome UA na
interních JSON API / SSR stránkách při kadenci 1×/2 h (stejná odchylka jako ř. 10, osobní
použití). Datour Elastic credentials z bundle se NIKDY nepoužijí.
