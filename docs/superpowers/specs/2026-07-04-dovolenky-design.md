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
