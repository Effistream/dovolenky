# Dovolenky

## Co to je

Osobní hlídač zájezdů. Každé 2 hodiny stahuje nabídky z 16 českých cestovních zdrojů,
ukládá cenovou historii a počítá **reálnou slevu**: skutečný rozdíl proti vlastní
historii nabídky nebo proti trhu, ne přeškrtnutou cenu, kterou napíše zdroj. Když
nabídka splní prahy nastavené v `config/watch.yaml`, pošle zprávu na Telegram;
jednou denně navíc souhrnný digest top 10 nabídek.

## Zdroje

| Zdroj | Co z něj bereme |
|---|---|
| Invia | `ajax-boxes` výpis last-minute karet, GA4 data atributy + JWT z detail linku (hotel, termín, strava, doprava) |
| Fischer | hydration → TourList/TourHotelList API; ceny za osobu, bez přeškrtnuté ceny (odloženo, viz níže) |
| Exim | `getsearch` HTML payload s cenami i přeškrtnutou cenou a dopočtenou slevou v % |
| Čedok | SSR výpis `/last-minute/?order=priceAsc`, přeškrtnutá cena na ~80 % karet |
| Blue Style | `__NEXT_DATA__` JSON, cena po slevě + uváděné %; původní cena dopočtená |
| Zajezdy.cz | `window.searchData` JSON z sady destinačních stránek, jen v okně 08–24 h (robots) |
| Dovolena.cz | `tripListing` API (provozuje Student Agency); hotel-level ceny, bez konkrétních termínů |
| eTravel | `getsearchresult` API; jediný zdroj s oficiálním Omnibus 30denním minimem (`lowestPrice`) |
| Dovolenkovani.cz | CESYS white-label API (`dates-list`) — termíny, ceny za osobu i uváděné slevy; jména hotelů dopočtená ze sitemapy (`accommodations.xml`) |
| FIRO Travel | CESYS white-label API (`dates-list`, stejná továrna jako Dovolenkovani.cz) — exotické lety, agreguje mj. zájezdy Fischer CK |
| Alexandria | `bck-new` JSON API (`web-search`) — dotazy na exotické location id; cena za skupinu → dopočet na osobu, sleva z `original_price` |
| Deluxea | Nette `data-json` embedded v HTML — nabídky přímo ze stránky, bez API |
| ESO travel | SSR HTML listingy; 100% letecký operátor, karty bez markeru dopravy (transport `unknown`) |
| Adventura | okružní a expediční zájezdy (Nepál, Peru, Madagaskar aj.); část karet bez markeru dopravy |
| Datour | `anchoice.cz` white-label JSON API (`web-search`) — termíny za osobu (`unit_price`), agreguje 23k+ nabídek napříč CK |
| Slevomat | přímo neběží (Cloudflare) — nabídky bereme přes **Skrz.cz**, který je agreguje |

## Setup krok za krokem

1. `npm install`
2. `cp .env.example .env`
3. Založ Telegram bota:
   1. Otevři Telegram, najdi `@BotFather`, pošli `/newbot`.
   2. Zadej jméno bota a username (musí končit na `bot`).
   3. BotFather vrátí token — vlož ho do `.env` jako `TELEGRAM_BOT_TOKEN=...`.
4. `npm run telegram:setup` — počká na první zprávu botovi (pošli mu cokoliv) a
   uloží `TELEGRAM_CHAT_ID` do `.env` automaticky.
5. Uprav `config/watch.yaml`:
   - **profily** (`leto-more`, `last-minute`, můžeš přidat další) — každý má vlastní
     filtry (země, měsíc odletu, strava, doprava) a vlastní práh `min_real_discount_pct`.
   - **prahy** v `notifications` řídí, kdy se posílá zpráva o poklesu ceny
     (`price_drop_pct`), kdy se stejná nabídka připomene znovu (`renotify_drop_pct`,
     `renotify_after_days`) a v kolik hodin jde denní digest (`digest_hour`).
6. `npm run scan -- --dry-run` — ověří, že zdroje odpovídají a config je platný;
   neposílá na Telegram ani neoznačuje zmizelé nabídky, ale nabídky a cenové
   snapshoty do DB zapisuje (sbírá historii).
7. `ops/install-launchd.sh` — zaregistruje pravidelný běh (viz níže). Skript si
   spouští uživatel sám, až je připravený.

## Příkazy

| Příkaz | Co dělá |
|---|---|
| `npm run scan` | proběhne všemi zdroji, zapíše do DB, pošle notifikace/digest |
| `npm run scan -- --source=invia` | jen jeden zdroj (jméno viz `src/sources/index.ts`) |
| `npm run scan -- --dry-run` | neposílá zprávy, nezapisuje notifikace a neoznačuje zmizelé nabídky; nabídky a cenové snapshoty do DB ukládá (sbírá historii) |
| `npm run scan -- --no-notify` | zapíše do DB, ale neposílá na Telegram |
| `npm run digest` | ruční vyvolání denního digestu (mimo běžný rozvrh) |
| `npm run telegram:setup` | zjistí a uloží `TELEGRAM_CHAT_ID` |
| `npm test` | spustí testy (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:push` | promítne Drizzle schéma do SQLite |

## Jak to počítá reálnou slevu

Pro každou nabídku se hledá referenční cena, od nejsilnější k nejslabší: vlastní
historie nabídky (medián cen ze snapshotů za posledních 30 dní, pokud existují
aspoň 3 s rozpětím ≥5 dní), pak Omnibus 30denní minimum (jen u eTravel), a nakonec
tržní medián — cena aktivních nabídek ve stejném koši (země × měsíc odletu × pásmo
nocí × strava × hvězdy), pokud v koši je aspoň 8 nabídek napříč zdroji.

`realDiscountPct` je rozdíl mezi referenční cenou a aktuální cenou. Když uváděná
sleva (ta na přeškrtnuté ceně) převyšuje reálnou slevu o 15 procentních bodů a víc,
nabídka dostane flag ⚠️ „nadsazená sleva". Zdroj tím slevu nadhodnocuje vůči tomu,
za co se termín reálně prodává.

Prvních ~14 dní provozu žádná reference není (databáze se teprve plní historií).
V tomto období notifikace uvádí jen deklarovanou slevu s poznámkou, že reálná se
zatím sbírá.

## Jak přidat zdroj

1. Vytvoř `src/sources/<jmeno>.ts` s exportem, který splňuje `SourceAdapter`
   z `src/core/types.ts`:

   ```ts
   export interface SourceAdapter {
     name: string;
     fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]>;
   }
   ```

   `fetchOffers` dostane `ctx.http` (rate-limitovaný fetch wrapper), `ctx.adults`
   a `ctx.log`; musí vrátit pole `NormalizedOffer` (viz stejný soubor pro tvar).
   Chyby zdroje nechej probublat — `runScan` prochází zdroje sekvenčně a každý
   izoluje v samostatném try/catch (pád jednoho zdroje neshodí ostatní).
   Když `fetchOffers` vrátí prázdné pole, zdroj se označí jako `partial` a
   `markMissedOffers` se pro něj přeskočí (nula nabídek nikdy neznamená „trh je prázdný").

2. Ulož reálnou odpověď zdroje (HTML/JSON) do `tests/fixtures/<jmeno>/` a napiš
   `tests/<jmeno>.test.ts`, který z fixture vyparsuje očekávané nabídky — vzor viz
   `tests/cedok.test.ts` nebo kterýkoliv jiný existující test zdroje.

3. Zaregistruj adaptér v `src/sources/index.ts` (přidej do importu a do pole
   `adapters`).

Pokud zdroj sdílí platformu s DER Touristik (Fischer/Exim/eTravel), použij společný
helper `src/sources/der.ts` místo psaní parseru od nuly.

## Známá omezení & backlog

- **eTravel Omnibus** — pole `lowestPrice` je v živých datech zatím konzistentně
  `null` (ověřeno na stovkách vzorků); jakmile se začne plnit, reálná sleva pro
  eTravel automaticky přejde na tuto referenci.
- **Fischer, Dovolena.cz** — bez přeškrtnuté/původní ceny v datech zdroje; reálná
  sleva se u nich počítá jen z vlastní historie nebo tržního mediánu, nikdy
  z uváděné slevy.
- **Dovolena.cz** — nabídky jsou hotel-level, ne term-level; `departureDate`
  a `nights` jsou vždy `null` (zdroj termíny na detail nabídky nevystavuje).
- **Zajezdy.cz** — scan respektuje robots.txt okno 08:00–24:00 Europe/Prague;
  běhy mimo toto okno zdroj přeskočí beze zpracování.
- **Čedok** — pokrytí jde přes `order=priceAsc` na hlavním `/last-minute/` výpisu;
  country-specific podcesty (`/last-minute/recko/` apod.) jsou kandidát na rozšíření
  pokrytí, zatím nejsou zapojené.
- **Slevomat** — přímý adaptér vyžaduje headless prohlížeč kvůli Cloudflare
  managed challenge; odloženo. Ve v1 se jeho nabídky berou přes Skrz.cz.
- **Cross-source dedup** — stejný hotel/termín u více zdrojů se ve v1 eviduje jako
  samostatné nabídky, bez sloučení.
- **Vercel deploy** — cron route (`api/cron/scan`) + Turso DB je mimo scope v1;
  core je bez závislosti na fs/procesech mimo config load, takže přechod je jen
  o přepnutí `DATABASE_URL` a přidání route.
- **Telegram příkazy** (`/top`, `/pause`), web UI, více uživatelů — mimo scope v1.

## Dashboard „Terminál"

Lokální webový přehled nabídek — odletová tabule s reálnou slevou, cenový graf
v detailu řádku a dvě souhrnné karty (TRH DNES, ZDROJE). Čte přímo ze stejné
SQLite DB, kterou plní scan; sám nic nestahuje ani neposílá (read-only, spec §14).

**Spuštění (produkční režim):**

1. `npm run web:build` — sestaví frontend do `web/dist` (vite build v `web/`).
2. `npm run web` — nastartuje Hono server na portu **4141**; obsluhuje API
   (`/api/offers`, `/api/offers/:id/history`, `/api/sources`, `/api/stats`)
   i sestavený SPA ze stejného originu. Port lze přepsat přes `PORT`. Server
   poslouchá jen na `127.0.0.1` (localhost), ne na všech rozhraních; přepsat
   lze přes `HOST`.
3. Otevři `http://localhost:4141`.

Když `web/dist` neexistuje, server místo SPA vrátí textovou hlášku „spusť
`npm run web:build`", takže chybějící build selže hlasitě, ne 404.

**Vývoj frontendu:** `npm run web:dev` spustí Vite dev server (port 5173)
s hot-reloadem; ten proxuje `/api` na `:4141`, takže vedle sebe běží
`npm run web` (API) a `npm run web:dev` (UI) bez CORS.

**E2E smoke:** `npm run test:e2e` (Playwright, chromium). Config
`playwright.config.ts` si sám sestaví frontend, naseeduje throwaway SQLite DB
(`tests/e2e/seed.ts`, deterministická data přes reálný ingest pipeline),
nastartuje server a projede board render, filtry (země/profil), rozbalení
detailu s grafem, cross-source alternativy a stav karet — plus kontrolu, že
během běhu nespadne žádná console chyba. Prohlížeč se instaluje jednorázově:
`npx playwright install chromium`. Root unit testy (`npm test`) e2e adresář
nesbírají (jiný runner).

Design tokeny a pravidla copy jsou v `design-system/MASTER.md`, referenční
mockup v `docs/design/terminal-mockup.html`.
