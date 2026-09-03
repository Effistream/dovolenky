# Source health: proč dovolenkovani „svítí červeně" a co s tím

**Datum:** 2026-09-03 · **Symptom:** karta ZDROJE ukazuje dovolenkovani + firo červeně
(`fetch exceeded 420000ms budget`), přestože nabídky jsou čerstvé (617 aktivních,
`last_seen` 10:40 dnes).

## Kořenové příčiny (změřeno, ne odhadnuto)

1. **Cloud (GitHub Actions) CESYS zdroje neumí — nikdy.** Datacentrová IP je na
   dovolenkovani.cz / firotravel.cz / api-ng.cesys.eu zahazována na úrovni spojení
   (`fetch failed` u sitemapy, mapping/countries i všech 11 dates-list dotazů). 7denní
   statistika `source_runs` (2026-08-27 → 09-03): **dovolenkovani 0/55 ok, firo 0/55,
   zajezdy 0/56** (34× partial s 0 nabídkami + 22× failed). Přesto cloud každé 2 h zapíše
   `failed` řádek a živí 🛠 health alerty.
2. **Mac fallback (launchd, :40) běží i během spánku.** `pmset -g log` ukazuje celou noc
   *DarkWake* cykly po ~15 min (2–45 s bdění). launchd scan nastartuje uvnitř takového okna,
   Mac za pár sekund usne, proces zmrzne, síť umře → všech 7 pomalých zdrojů
   „fetch exceeded 420000ms budget" nebo Turso `ECONNRESET` (`loadPriorTitles`). Dnes tak
   dopadly běhy 02:41, 04:56, 06:40, 08:40 místního času; jediný zdravý byl 10:40 (Mac
   vzhůru od 09:05). Za 7 dní je ~57 % Mac běhů takto otrávených (dovolenkovani mac:
   16 ok / 21 failed). Komentář v plistu „StartCalendarInterval sloučí zmeškané sloty do
   JEDNOHO běhu po probuzení" platí jen pro plné probuzení, ne pro DarkWake.
3. **Dashboard ukazuje poslední POKUS, ne zdraví zdroje.** `buildSources` bere nejnovější
   řádek dle `id`. Dnešní cloud běh začal 10:29 (GitHub ho zpozdil o 29 min — drift je
   dokumentovaně 1,8–4,5 h) a trval 26 min → `failed` pro dovolenkovani zapsal v 10:51,
   11 min PO Macově `ok` z 10:40. Kdo zapíše poslední, vyhrává; komentář v plistu „okna se
   nepřekrývají" neplatí.

## Opravy (tři nezávislé, malé)

### A. Dashboard: zdraví podle stáří posledních DAT, ne podle posledního pokusu

**Soubory:** `src/web/api.ts` (`buildSources`), `web/src/lib/types.ts`,
`web/src/lib/history.ts`, `web/src/components/MarketCards.tsx`,
`web/src/components/StatusLine.tsx`; testy `tests/api.test.ts`, `web/src/lib/history.test.ts`.

- `/api/sources` položka dostane `lastOkAt: string | null` a `lastOkOffers: number | null`:
  `startedAt`/`offersFound` NEJNOVĚJŠÍHO řádku (pořadí id desc) se `status === 'ok'` NEBO
  (`status === 'partial'` a `offersFound > 0`) — tj. běh, který přinesl použitelná data.
  Počítá se nad TÝMIŽ ≤1000 řádky, které buildSources už načítá (žádný další dotaz — Turso
  rows-read kvóta). `null` = žádný použitelný běh v okně. Stávající pole zůstávají.
- `history.ts`: nová čistá funkce
  `sourceHealth(s: { status: string; backoff: boolean; lastOkAt: string | null }, nowMs: number)
   → { tone: 'ok' | 'partial' | 'failed'; note: string | null }`
  s konstantami `FRESH_MS = 5 h` (pokrývá naměřený drift GH cronu 4,5 h) a `STALE_MS = 24 h`:
  - `backoff` → `partial`, note `v pauze` (beze změny významu).
  - `lastOkAt == null` → `failed`, note `zatím bez dat`.
  - stáří > 24 h → `failed`, note `bez dat ${h} h` (h = celé hodiny).
  - stáří ≤ 5 h: `status === 'ok'` → `ok` (note null); jinak → `partial`, note
    `poslední pokus selhal` (status failed) / `částečný běh` (partial).
  - 5 h < stáří ≤ 24 h → `partial`, note `před ${h} h`.
  - Skrz: `vč. Slevomatu` jen když jiná note není. `sourceDotTone`/`sourceViaNote` nahradit
    (testy přepsat na `sourceHealth`), nic nenechávat mrtvé.
- `MarketCards.tsx`: tone + note ze `sourceHealth(s, Date.now())`; `<time>` = `pragueHhmm(lastOkAt)`
  (kdy naposledy přišla data), `—` když null; `title` atribut s posledním pokusem
  (`poslední pokus HH:MM · <status> · <errorSample>`), ať je chyba dohledatelná hoverem.
- `StatusLine.tsx`: `ZDROJE ok/total` počítá `tone === 'ok'`; warn dot když je někdo v backoffu
  NEBO červený. `SCAN` čas zůstává = nejnovější pokus.
- Testy: api — (1) novější failed + starší ok → `status: failed`, `lastOkAt` = starší ok;
  (2) partial s nabídkami se počítá, partial s 0 ne; (3) jen failed → `lastOkAt: null`.
  history — tabulka všech větví výše včetně hranic (přesně 5 h, přesně 24 h).

### B. Cloud přestane zkoušet zdroje, které z datacentra nikdy nedá

**Soubory:** `src/cli/select-sources.ts`, `src/cli/scan.ts`, `.github/workflows/scan.yml`,
`README.md`; test `tests/select-sources.test.ts`.

- `selectSources(all, raw, excludeRaw?)` → `{ adapters, unknown, excluded }`; exclude se
  aplikuje PO inkluzi; neznámá jména z obou seznamů jdou do `unknown`; `excluded` = jména
  skutečně vyřazená (pro log). Sémantika prázdného vstupu beze změny.
- `scan.ts`: `--exclude=a,b` (CLI vítězí) nebo env `SCAN_EXCLUDE_SOURCES`; log
  `Excluding source(s): …`; 0 adaptérů po vyřazení = chyba jako dnes.
- `scan.yml`: `SCAN_EXCLUDE_SOURCES: dovolenkovani,firo,zajezdy` + komentář s měřením
  (0/55, 0/55, 0/56 za 7 dní; pokrývá Mac fallback z rezidenční IP; vratné smazáním řádku).
- README: řádek v tabulce příkazů + věta u fallbacku.

### C. Mac fallback zahodí běh, který hostitel prospal

**Soubory:** nový `src/core/sleep-watch.ts`, `src/core/run.ts`, `src/cli/scan.ts` (tisk),
`ops/launchd/com.daniel.dovolenky.scan.plist` (jen komentář); testy `tests/sleep-watch.test.ts`,
`tests/run.test.ts`.

- `createSleepWatch({ now = Date.now, tickMs = 5000, gapMs = 60000, setIntervalImpl,
  clearIntervalImpl })` → `{ start(): void; stop(): number }`. Každý tick: `gap = now() - last -
  tickMs`; `gap >= gapMs` → přičti (proces byl zmrzlý). `stop()` započte i poslední mezeru a
  vrátí součet ms. Interval `unref()`, ať nedrží proces. Nezávisí na tom, zda monotónní hodiny
  na macOS počítají spánek — měří se, že se tick NEODEHRÁL, což zmrzlý proces nemůže obejít.
- `runScan`: `deps.sleepWatch?: SleepWatch` (default reálný). Start před fetch fází, `stop()`
  hned po `Promise.all` (fáze zpracování je CPU-heavy, tam by tick mohl zpozdit i bdělý proces).
  `frozenMs >= HOST_SLEEP_VOID_MS (60 s)` → **celý běh je neplatný**: nic se neingestuje,
  nezapíše (ani `source_runs`, ani backoff řádky), neposílá (notifikace, digest, health alert);
  log `host slept ~Ns during the fetch phase — discarding this run …`; vrátí
  `perSource` se `status: 'skipped'` pro každý adaptér (nový člen unionu `SourceSummary.status`),
  `notificationsSent: 0`, `digestSent: false`. Proč celý běh a ne jen selhavší zdroje: zdroj,
  který během spánku vrátil ořezanou sklizeň (etravel 320/916, dovolena 200/419 v logu), by přes
  `markMissedOffers` započítal miss dvěma třetinám svých nabídek — data z prospaného běhu
  nejsou důvěryhodná ani když „prošla".
- `scan.ts`: `skipped` se tiskne v summary; exit 0 (`skipped` ≠ `failed`).
- Plist: opravit dva neplatné předpoklady v komentáři (překryv s cloudem nastává — drift GH
  cronu; DarkWake spouští job a Mac usne). Nainstalovaná kopie v `~/Library/LaunchAgents` se
  nemusí přegenerovat (mění se jen komentář).
- Testy: sleep-watch — injektované hodiny + fake interval: (1) ticky bez mezer → 0;
  (2) jeden tick s mezerou 15 min → ~15 min; (3) mezera až po posledním ticku se započte ve
  `stop()`; (4) `stop()` zruší interval. run — fake watch vracející 900 000 → žádné řádky
  v `source_runs`, žádné `offers`, žádné Telegram zprávy, všechny `perSource` `skipped`;
  fake vracející 0 → chování beze změny (stávající testy).

## Omezení a co zůstává

- Spánek během FÁZE ZPRACOVÁNÍ (po fetchi) hlídač nechytá — může nechat část zdrojů
  nezapsaných / s `failed` řádkem z `ECONNRESET`. Vzácnější případ; s opravou A už nebarví
  kartu červeně. Zdokumentováno, neřešeno.
- Kdyby CESYS někdy datacentrovou IP pustil, cloud si toho nevšimne (B). Vratné jedním řádkem.
- Mac fallback dál pokrývá CESYS jen když je Mac vzhůru; A to zobrazí poctivě (oranžová
  „před N h", po 24 h červená), C přestane vyrábět falešné alerty.

## Pravidla pro implementaci

- TDD: nejdřív selhávající test, pak kód. `npx vitest run <soubor>`; root `npx tsc --noEmit`;
  web testy `cd web && npx vitest run`. Plnou sadu (884 testů) spouští integrátor.
- Každý task sahá JEN na své soubory. Necommitovat — commituje integrátor po review.
- Copy v UI česky, konkrétní čísla, bez vykřičníků (design-system/MASTER.md).
