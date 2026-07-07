# Dovolenky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Osobní hlídač zájezdů — 9 scraperů českých CK/agentur, cenová historie v SQLite, výpočet reálné slevy, Telegram notifikace.

**Architecture:** Jeden TypeScript worker (ESM, Node 24, tsx). Adaptery zdrojů implementují společné rozhraní `SourceAdapter` a vracejí `NormalizedOffer[]`; core vrstvy (ingest → discount → filters → notify) jsou čisté moduly nad libsql/Drizzle DB. CLI `scan` orchestruje vše; lokálně spouští launchd každé 2 h.

**Tech Stack:** Node 24, TypeScript (strict), tsx, vitest, cheerio, zod, yaml, drizzle-orm + @libsql/client (file: URL lokálně), raw Telegram Bot API přes fetch.

**Spec:** `docs/superpowers/specs/2026-07-04-dovolenky-design.md` — čti pro kontext (zejména §3 tabulku zdrojů).

## Global Constraints

- Node >= 24, `"type": "module"` (ESM), TypeScript strict; spouštění výhradně `tsx` (žádný build krok).
- DB výhradně přes `DATABASE_URL` env, default `file:./data/dovolenky.db`. Žádná přímá závislost na `better-sqlite3`.
- Žádný headless browser. Jen `fetch` (přes `HttpClient`).
- Politeness: min. 3000 ms mezi requesty na týž host (Zajezdy.cz 5000 ms; requesty na zajezdy.cz jen 08–24 h lokálního času), User-Agent `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`.
- Čedok: nikdy nevolat cesty `/api*`. Zajezdy: nikdy `/api/` ani `?page=`. Skrz: nikdy `/koupit/` ani sort/filter URL varianty.
- Peníze vždy CZK, celé číslo (zaokrouhleno). Datum vždy ISO `YYYY-MM-DD` string.
- Všechny testy: `npx vitest run <file>`; před commitem `npx tsc --noEmit` musí projít.
- Commit po každém tasku, message `feat: …` / `test: …` / `chore: …`, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Fixtures se pořizují živým curl (příkaz v tasku) do `tests/fixtures/<source>/` a commitují se. Po pořízení fixture otevři soubor a doplň do testu očekávané hodnoty prvního offeru z reálných dat (počty, ceny) — testy nesmí zůstat jen na „length > 0".
- Pokud se živá odpověď liší od recon poznámek ve spec §3 (weby se mění), přizpůsob parser realitě fixture a poznamenej odchylku do commit message.

---

### Task 1: Scaffold + core typy + normalizační helpery

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/core/types.ts`, `src/core/normalize.ts`
- Test: `tests/normalize.test.ts`

**Interfaces:**
- Consumes: —
- Produces: typy `NormalizedOffer`, `Board`, `Transport`, `SourceAdapter`, `SourceContext`; funkce `normalizeBoard(raw): Board`, `normalizeTransport(raw): Transport`, `normalizeCountry(raw): string|null`, `parseCzk(raw): number|null`, `parseCzDate(raw): string|null`, `offerKeyHash(parts: (string|number|null|undefined)[]): string`.

- [ ] **Step 1: Scaffold**

```bash
npm init -y
npm pkg set type=module engines.node=">=24" private=true \
  scripts.scan="tsx src/cli/scan.ts" scripts.digest="tsx src/cli/digest.ts" \
  scripts.telegram:setup="tsx src/cli/telegram-setup.ts" scripts.db:push="drizzle-kit push" \
  scripts.test="vitest run" scripts.typecheck="tsc --noEmit"
npm i zod yaml cheerio drizzle-orm @libsql/client
npm i -D typescript tsx vitest drizzle-kit @types/node
mkdir -p src/core/db src/sources src/cli tests/fixtures config ops/launchd data logs
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "types": ["node"], "resolveJsonModule": true
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

`.gitignore`:
```
node_modules/
data/
logs/
.env
```

`.env.example`:
```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DATABASE_URL=file:./data/dovolenky.db
```

- [ ] **Step 2: `src/core/types.ts`**

```ts
export type Board = 'AI' | 'FB' | 'HB' | 'BB' | 'none' | 'unknown';
export type Transport = 'flight' | 'own' | 'bus' | 'unknown';

export interface NormalizedOffer {
  source: string;
  sourceOfferKey: string;
  title: string;
  country: string | null;
  locality: string | null;
  stars: number | null;
  board: Board;
  transport: Transport;
  departureAirport: string | null;
  departureDate: string | null; // ISO YYYY-MM-DD
  nights: number | null;
  pricePerPerson: number;       // CZK, integer
  priceTotal: number | null;
  claimedOriginalPrice: number | null;
  claimedDiscountPct: number | null;
  omnibusLowestPrice: number | null;
  tourOperator: string | null;
  url: string;
}

import type { HttpClient } from './http.js';

export interface SourceContext {
  http: HttpClient;
  adults: number;               // z config scan.adults
  log: (msg: string) => void;
}

export interface SourceAdapter {
  name: string;
  fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]>;
}
```

(Import `./http.js` bude existovat od Tasku 4; do té doby vytvoř prázdný stub `src/core/http.ts` s `export class HttpClient {}`, Task 4 ho nahradí.)

- [ ] **Step 3: Failing test `tests/normalize.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeBoard, normalizeTransport, normalizeCountry, parseCzk, parseCzDate, offerKeyHash } from '../src/core/normalize.js';

describe('normalize', () => {
  it('board', () => {
    expect(normalizeBoard('All inclusive')).toBe('AI');
    expect(normalizeBoard('all-inclusive')).toBe('AI');
    expect(normalizeBoard('Ultra All Inclusive')).toBe('AI');
    expect(normalizeBoard('Polopenze')).toBe('HB');
    expect(normalizeBoard('Snídaně')).toBe('BB');
    expect(normalizeBoard('Plná penze')).toBe('FB');
    expect(normalizeBoard('Bez stravy')).toBe('none');
    expect(normalizeBoard(null)).toBe('unknown');
  });
  it('transport', () => {
    expect(normalizeTransport('Letecky')).toBe('flight');
    expect(normalizeTransport('letecky-praha')).toBe('flight');
    expect(normalizeTransport('Vlastní doprava')).toBe('own');
    expect(normalizeTransport('Autobusem')).toBe('bus');
    expect(normalizeTransport(undefined)).toBe('unknown');
  });
  it('country', () => {
    expect(normalizeCountry('Řecko')).toBe('Řecko');
    expect(normalizeCountry('recko')).toBe('Řecko');
    expect(normalizeCountry('Egypt / Hurghada')).toBe('Egypt');
    expect(normalizeCountry('Albánie, Vlora')).toBe('Albánie');
    expect(normalizeCountry('chorvatsko')).toBe('Chorvatsko');
    expect(normalizeCountry('')).toBeNull();
  });
  it('parseCzk', () => {
    expect(parseCzk(' 16 781 Kč')).toBe(16781);
    expect(parseCzk('od 7 990 Kč')).toBe(7990);
    expect(parseCzk('75 100 Kč')).toBe(75100);
    expect(parseCzk('nesmysl')).toBeNull();
  });
  it('parseCzDate', () => {
    expect(parseCzDate('15.07.2026')).toBe('2026-07-15');
    expect(parseCzDate('15. 7. 2026')).toBe('2026-07-15');
    expect(parseCzDate('2026-07-15')).toBe('2026-07-15');
    expect(parseCzDate('blbost')).toBeNull();
  });
  it('offerKeyHash stable', () => {
    const a = offerKeyHash(['Hotel X', '2026-07-15', 7, 'AI']);
    expect(a).toBe(offerKeyHash(['Hotel X', '2026-07-15', 7, 'AI']));
    expect(a).not.toBe(offerKeyHash(['Hotel Y', '2026-07-15', 7, 'AI']));
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });
});
```

- [ ] **Step 4: Run — expect FAIL** (`npx vitest run tests/normalize.test.ts` → module not found)

- [ ] **Step 5: `src/core/normalize.ts`**

```ts
import { createHash } from 'node:crypto';
import type { Board, Transport } from './types.js';

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function normalizeBoard(raw: string | null | undefined): Board {
  if (!raw) return 'unknown';
  const s = strip(raw);
  if (s.includes('all') && s.includes('inclusive')) return 'AI';
  if (s.includes('plna penze') || s === 'fb') return 'FB';
  if (s.includes('polopenze') || s === 'hb') return 'HB';
  if (s.includes('snidan') || s === 'bb') return 'BB';
  if (s.includes('bez strav')) return 'none';
  return 'unknown';
}

export function normalizeTransport(raw: string | null | undefined): Transport {
  if (!raw) return 'unknown';
  const s = strip(raw);
  if (s.includes('letec') || s.includes('flight')) return 'flight';
  if (s.includes('vlastni') || s.includes('own')) return 'own';
  if (s.includes('autobus') || s.includes('bus')) return 'bus';
  return 'unknown';
}

// Kanonické názvy zemí; klíč = stripped varianta/slug.
const COUNTRIES = ['Řecko','Turecko','Egypt','Španělsko','Kypr','Bulharsko','Chorvatsko','Itálie','Tunisko','Malta','Portugalsko','Albánie','Černá Hora','Maroko','Spojené arabské emiráty','Thajsko','Zanzibar','Kapverdy','Dominikánská republika','Mexiko','Kuba','Maledivy','Mauricius','Seychely','Srí Lanka','Indonésie','Vietnam','Madeira','Kanárské ostrovy','Slovinsko','Francie','Rakousko','Maďarsko','Slovensko','Česká republika','Gruzie','Jordánsko','Izrael','Omán','Katar'];
const COUNTRY_BY_KEY = new Map(COUNTRIES.map(c => [strip(c), c]));
COUNTRY_BY_KEY.set('sae', 'Spojené arabské emiráty');
COUNTRY_BY_KEY.set('emiraty', 'Spojené arabské emiráty');
COUNTRY_BY_KEY.set('cerna hora', 'Černá Hora');

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(/[\/,–-]/)[0]?.trim() ?? '';
  if (!first) return null;
  const hit = COUNTRY_BY_KEY.get(strip(first));
  if (hit) return hit;
  // fallback: Title-case první token tak jak přišel
  return first;
}

export function parseCzk(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/[   ]/g, '').match(/(\d{3,})(?:Kč|CZK|$|[^\d])/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseCzDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const cz = raw.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/);
  if (!cz) return null;
  const [, d, mo, y] = cz;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function offerKeyHash(parts: (string | number | null | undefined)[]): string {
  return createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
}
```

Pozn.: `parseCzk` musí ignorovat mezery/nbsp uvnitř čísla — po replace je „16781Kč". Regex bere první číselnou skupinu ≥3 číslic (ceny zájezdů; vyhne se „od 2 osob").

- [ ] **Step 6: Run — expect PASS**; `npx tsc --noEmit` PASS
- [ ] **Step 7: Commit** `feat: scaffold project, core types and normalize helpers`

---

### Task 2: Config loader

**Files:**
- Create: `src/core/config.ts`, `config/watch.yaml`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `loadConfig(opts?: {configPath?: string; env?: Record<string,string|undefined>}): AppConfig` kde `AppConfig = { profiles: Record<string, Profile>; notifications: NotifCfg; scan: ScanCfg; telegramToken: string|null; telegramChatId: string|null; databaseUrl: string }`; `Profile = { enabled: boolean; countries: string[]; transport?: 'flight'|'own'|'bus'; board: Board[]; departureMonths: number[]; departureWithinDays: number|null; maxPricePerPerson: number|null; minRealDiscountPct: number; notifyNewOffers: boolean }`; `NotifCfg = { priceDropPct: number; renotifyDropPct: number; renotifyAfterDays: number; maxMessagesPerRun: number; digestHour: number }`; `ScanCfg = { adults: number; minRequestGapMs: number }`.

- [ ] **Step 1: `config/watch.yaml`** — přesně obsah ze spec §8.
- [ ] **Step 2: Failing test** — načti reálný `config/watch.yaml`, ověř: `profiles['leto-more'].board` = `['AI']`, `departureMonths` = `[6,7,8,9]`, `minRealDiscountPct` = 15, `profiles['last-minute'].departureWithinDays` = 14, `notifications.digestHour` = 8, `scan.adults` = 2; defaulty: `databaseUrl` = `file:./data/dovolenky.db` když env prázdné; chybějící soubor → throw se srozumitelnou hláškou; neznámý klíč v YAML → throw (zod `.strict()`).
- [ ] **Step 3: Implement** — zod schéma (snake_case YAML klíče → camelCase přes `.transform`), `yaml.parse`, env přes parametr (testovatelné bez mutace `process.env`). YAML klíče: `departure_months`, `departure_within_days`, `max_price_per_person`, `min_real_discount_pct`, `notify_new_offers`, `price_drop_pct`, `renotify_drop_pct`, `renotify_after_days`, `max_messages_per_run`, `digest_hour`, `min_request_gap_ms`. Chybějící volitelné → smysluplné defaulty (countries `[]`, `departureWithinDays` null, `maxPricePerPerson` null, `notifyNewOffers` false, board `[]` = všechny).
- [ ] **Step 4: Run PASS, typecheck, Commit** `feat: config loader with zod validation`

---

### Task 3: DB schéma + ingest

**Files:**
- Create: `src/core/db/schema.ts`, `src/core/db/index.ts`, `drizzle.config.ts`, `src/core/ingest.ts`
- Test: `tests/ingest.test.ts`

**Interfaces:**
- Consumes: `NormalizedOffer` (Task 1)
- Produces: `openDb(url: string): Db` (typ `Db = LibSQLDatabase<typeof schema>`); tabulky `offers, priceSnapshots, notificationsLog, sourceRuns` (sloupce dle spec §5 + `offers.misses: integer default 0`); `ensureSchema(db): Promise<void>` (CREATE TABLE IF NOT EXISTS — runtime bootstrap, ať scan nepadá bez drizzle-kit push); `ingestOffer(db, offer, now?: Date): Promise<{offerId: number; isNew: boolean; snapshotWritten: boolean; previousPrice: number|null}>`; `markMissedOffers(db, source: string, seenKeys: string[], now?: Date): Promise<void>` (nespatřené → misses+1; misses>=2 → active=false; spatřené → misses=0, lastSeenAt=now, active=true).

- [ ] **Step 1: Failing test** — in-memory DB (`openDb(':memory:')` → libsql `file::memory:`), `ensureSchema`; scénáře:
  1. nový offer → isNew true, snapshot zapsán;
  2. stejná cena, tentýž den → snapshotWritten false, lastSeenAt updated;
  3. stejná cena po 25 h (`now` param) → snapshot zapsán (heartbeat);
  4. změněná cena → snapshot zapsán, previousPrice = stará cena;
  5. markMissedOffers: klíč mimo seen 2× po sobě → active=false; znovu spatřen → active=true, misses=0.
- [ ] **Step 2: Implement.** `priceSnapshots` sloupce: `id, offerId (FK), capturedAt (ISO text), pricePerPerson (int), priceTotal, claimedOriginalPrice, claimedDiscountPct (real), omnibusLowestPrice`. `notificationsLog`: `id, offerId (nullable — digest), type (text), sentAt, priceAtSend`. `sourceRuns`: `id, source, startedAt, finishedAt, offersFound, snapshotsWritten, errorCount, status, errorSample`. Unique index `(source, source_offer_key)` na offers. `ingestOffer`: upsert dle unique klíče; snapshot pravidlo dle spec §5.
- [ ] **Step 3: Run PASS, typecheck, Commit** `feat: db schema and ingest with snapshot dedup`

---

### Task 4: HTTP client

**Files:**
- Create: `src/core/http.ts` (nahrazuje stub)
- Test: `tests/http.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `class HttpClient { constructor(opts?: {minGapMs?: number; userAgent?: string; fetchImpl?: typeof fetch; hostGapOverrides?: Record<string, number>}); text(url: string, init?: RequestInit): Promise<string>; json<T = unknown>(url: string, init?: RequestInit): Promise<T>; }`; `class SourceBlockedError extends Error { status: number }`.

- [ ] **Step 1: Failing test** — mock `fetchImpl`:
  1. přidává User-Agent header;
  2. dva requesty na týž host → druhý počká ≥ minGap (test s minGapMs 50, měř `Date.now()`);
  3. různé hosty se nečekají;
  4. 500 → retry ×2 (celkem 3 pokusy, backoff 100/400 ms v testu přes injektovaný `sleep`), pak throw;
  5. 403 a 429 → okamžitě `SourceBlockedError` bez retry;
  6. `hostGapOverrides: {'last-minute.zajezdy.cz': 5000}` respektováno (ověř přes vnitřní `gapForHost(url)` — exportuj jako metodu).
- [ ] **Step 2: Implement.** Per-host `Map<string, number>` last-request time; `json()` = `text()` + `JSON.parse`; backoff default 500/2000 ms, injektovatelný `sleepImpl` pro testy. Redirect follow default.
- [ ] **Step 3: Run PASS, typecheck, Commit** `feat: polite http client with per-host rate limiting`

---

### Task 5: Discount engine

**Files:**
- Create: `src/core/discount.ts`
- Test: `tests/discount.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `computeRealDiscount(input: { current: number; ownSnapshots: {price: number; at: string}[]; omnibus: number|null; marketPrices: number[]; claimedPct: number|null; now?: Date }): DiscountResult`; `DiscountResult = { realPct: number|null; reference: 'own'|'omnibus'|'market'|null; baseline: number|null; fake: boolean }`; helper `median(xs: number[]): number`.

- [ ] **Step 1: Failing test** — případy:
  1. own: 5 snapshotů za posledních 10 dní, medián 20000, current 15000 → realPct 25, reference 'own';
  2. own nedostatečné (2 snapshoty NEBO 4 snapshoty v rozpětí 3 dnů) + omnibus 18000, current 15000 → reference 'omnibus', realPct ≈ 17 (round);
  3. bez own/omnibus, marketPrices 8 hodnot medián 16000, current 12000 → 'market', 25;
  4. market < 8 hodnot → reference null, realPct null, fake false;
  5. zdražení: baseline 10000, current 12000 → realPct −20;
  6. fake: claimedPct 45, realPct 22 → fake true; claimedPct 30, realPct 22 → false; claimedPct null → false;
  7. own snapshoty starší 30 dnů a dnešní se ignorují (`now` fixní).
- [ ] **Step 2: Implement** přesně dle spec §6 (≥3 snapshoty, rozpětí ≥5 dní, okno 30 dní bez dneška; priorita own > omnibus > market; fake při rozdílu ≥15 p.b.). `realPct = Math.round((baseline - current) / baseline * 100)`.
- [ ] **Step 3: Run PASS, typecheck, Commit** `feat: real discount engine with own/omnibus/market baselines`

---

### Task 6: Profile filters

**Files:**
- Create: `src/core/filters.ts`
- Test: `tests/filters.test.ts`

**Interfaces:**
- Consumes: `NormalizedOffer`, `AppConfig` (Task 2)
- Produces: `matchProfiles(offer: NormalizedOffer, profiles: Record<string, Profile>, now?: Date): {name: string; profile: Profile}[]`.

- [ ] **Step 1: Failing test** — helper `mkOffer(overrides)`; profily z `loadConfig` nad testovacím YAML stringem (leto-more + last-minute ze spec §8):
  1. Řecko, AI, flight, odlet 2026-07-20, 11990 → matchne leto-more;
  2. board HB → nematchne leto-more (board [AI]);
  3. odlet za 10 dní (relativně k `now`), sleva irelevantní pro match → matchne last-minute (countries []);
  4. cena 26000 → nematchne leto-more (max 25000);
  5. odlet měsíc 5 → nematchne leto-more (months 6–9);
  6. `enabled: false` profil nikdy nematchne;
  7. offer s `departureDate: null` matchne jen profily bez date podmínek.
- [ ] **Step 2: Implement.** Pravidla: countries prázdné = všechny (porovnání přes `normalizeCountry`); board prázdné = všechny; transport undefined = všechny; `departureMonths` proti měsíci z departureDate; `departureWithinDays` proti `now`; null cena/datum u offeru → podmínka na ně selže (kromě profilů, které ji nemají).
- [ ] **Step 3: Run PASS, typecheck, Commit** `feat: watch profile matching`

---

### Task 7: Telegram client + formátování zpráv

**Files:**
- Create: `src/core/telegram.ts`, `src/core/format.ts`
- Test: `tests/format.test.ts`, `tests/telegram.test.ts`

**Interfaces:**
- Consumes: `NormalizedOffer`, `DiscountResult`
- Produces: `class Telegram { constructor(token: string, chatId: string, fetchImpl?: typeof fetch); send(html: string): Promise<void>; }` (POST `https://api.telegram.org/bot<token>/sendMessage`, body `{chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true}`; non-ok response → throw s popisem). `formatOffer(kind: 'hot_deal'|'price_drop'|'new_offer', offer: NormalizedOffer, d: DiscountResult, extra?: {previousPrice?: number}): string`; `formatDigest(items: {offer: NormalizedOffer; d: DiscountResult}[], stats: {activeOffers: number; newLast24h: number}): string`; `escapeHtml(s: string): string`.

- [ ] **Step 1: Failing tests** — format: emoji dle typu (🔥/📉/🆕), obsahuje escapnutý title, hvězdy `★`.repeat, cena `12 990 Kč/os.` (formátování `toLocaleString('cs-CZ')` + nbsp fix), řádek reálné slevy jen když `realPct != null` (jinak text „reálná sleva: sbírám historii"), ⚠️ jen když `fake`, u price_drop řádek `↓ z 15 000 Kč`; digest max 10 položek + patička se stats; escapeHtml escapuje `<>&`. Telegram: mock fetch — správná URL, body, throw na `{ok:false}`.
- [ ] **Step 2: Implement** dle formátu ve spec §7. Reference labely: own → `30denní medián`, omnibus → `zákonné 30denní minimum`, market → `medián trhu`.
- [ ] **Step 3: Run PASS, typecheck, Commit** `feat: telegram client and message formatting`

---

### Task 8: Notification decision engine

**Files:**
- Create: `src/core/notify.ts`
- Test: `tests/notify.test.ts`

**Interfaces:**
- Consumes: Db + schema (Task 3), `DiscountResult` (5), `Profile` (2), `NormalizedOffer`
- Produces: `evaluateOffer(input: { offerId: number; offer: NormalizedOffer; isNew: boolean; previousPrice: number|null; discount: DiscountResult; matches: {name: string; profile: Profile}[]; cfg: NotifCfg }): {type: 'hot_deal'|'price_drop'|'new_offer'; profile: string}[]` (čistá funkce, bez DB); `filterAgainstLog(db, candidates: Candidate[], cfg: NotifCfg, now?: Date): Promise<Candidate[]>` kde `Candidate = {offerId: number; offer: NormalizedOffer; discount: DiscountResult; type: NotificationType; profile: string}`; `recordSent(db, c: Candidate, now?: Date): Promise<void>`; `capMessages(cands: Candidate[], max: number): {send: Candidate[]; overflow: number}` (řadí dle realPct desc, null poslední).

- [ ] **Step 1: Failing test** — evaluateOffer: hot_deal jen když realPct ≥ profile.minRealDiscountPct; price_drop když previousPrice a pokles ≥ cfg.priceDropPct; new_offer jen isNew ∧ profile.notifyNewOffers; jeden offer může vrátit víc typů, ale max 1× od typu (nejsilnější profil). filterAgainstLog (in-memory DB): už poslaný hot_deal → znovu jen když cena klesla o ≥renotifyDropPct od priceAtSend NEBO uplynulo ≥renotifyAfterDays; new_offer poslaný → nikdy znovu. capMessages: 25 kandidátů, max 20 → send 20, overflow 5.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run PASS, typecheck, Commit** `feat: notification decisions with dedup and cap`

---

### Task 9: Adapter Čedok (referenční, SSR + cheerio)

**Files:**
- Create: `src/sources/cedok.ts`
- Test: `tests/cedok.test.ts`, fixture `tests/fixtures/cedok/last-minute-p1.html`

**Interfaces:**
- Consumes: `SourceAdapter`, `SourceContext`, normalize helpery, `HttpClient`
- Produces: `export const cedok: SourceAdapter` + `export function parseCedokListing(html: string): NormalizedOffer[]` (parser oddělený od fetche — testovatelný na fixture; STEJNÝ vzor dodrž u všech adapterů: `parse<Source>…(raw)` exportovaná čistá funkce).

- [ ] **Step 1: Capture fixture**

```bash
curl -sL --max-time 30 -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" \
  "https://www.cedok.cz/last-minute/?page=1&order=priceAsc" -o tests/fixtures/cedok/last-minute-p1.html
```

Otevři fixture, ověř přítomnost `data-testid="offer-list-item"`, spočítej karty, vyber první kartu a poznamenej si její hodnoty pro test.

- [ ] **Step 2: Failing test** — načti fixture, `parseCedokListing(html)`: délka = reálný počet karet (≈50); první offer: konkrétní title/country/price z fixture (doplň reálné hodnoty); všechny offery: `pricePerPerson > 1000`, `url` začíná `https://www.cedok.cz/`, `source === 'cedok'`; karty s `base-price` mají `claimedOriginalPrice > pricePerPerson`.
- [ ] **Step 3: Implement parser** — cheerio; selektory dle spec §3 ř. 4: karta `[data-testid="offer-list-item"]`, cena `[data-testid="current-price"]` → `parseCzk`, přeškrtnutá `[data-testid="base-price"]`, destinace `[data-testid="offer-list-item-destination"]` → `normalizeCountry` + locality (část za čárkou), hotel + URL z detail linku (`a[href*="/dovolena/"]`; title z img alt nebo textu linku), datum `\d{2}\.\d{2}` `–` `\d{2}\.\d{2}\.\d{4}` + `(N dní)` → nights = N−1, doprava/strava z textu karty (`Letecky`/`Vlastní`, `All inclusive`…), hvězdy: počet `★` ikon nebo z class. `claimedDiscountPct` dopočti z base vs current. `sourceOfferKey`: kód hotelu z URL (`,VLO2ORI/` segment), jinak `offerKeyHash([title, departureDate, nights, board])`. `fetchOffers`: stránky 1–4 (`?page=N&order=priceAsc`, 3 s gap zajistí HttpClient), spoj, zaloguj počet.
- [ ] **Step 4: Run PASS, typecheck**
- [ ] **Step 5: Live smoke** `npx tsx -e "…fetchOffers s reálným HttpClient…"` — vypiš počet + první 2 offery, vizuálně zkontroluj smysluplnost.
- [ ] **Step 6: Commit** `feat: cedok adapter (SSR listing parser)` — fixture commitni také.

---

### Task 10: Adapter Blue Style (`__NEXT_DATA__`)

**Files:** Create `src/sources/bluestyle.ts`; Test `tests/bluestyle.test.ts`, fixture `tests/fixtures/bluestyle/last-minute.html`

**Interfaces:** Produces `export const bluestyle: SourceAdapter`, `export function parseBluestyle(html: string): NormalizedOffer[]`.

- [ ] **Step 1: Fixture** — `curl -sL … "https://www.blue-style.cz/last-minute/" -o tests/fixtures/bluestyle/last-minute.html`; ověř `<script id="__NEXT_DATA__"`.
- [ ] **Step 2: Failing test** — jako u Čedoku: počet offerů dle fixture (≈50), první offer s reálnými hodnotami, invarianty (cena, url absolutní `https://www.blue-style.cz…`, source `bluestyle`), offery s `percentageDiscount` mají `claimedDiscountPct` a dopočtený `claimedOriginalPrice = Math.round(price / (1 - pct/100))`.
- [ ] **Step 3: Implement** — vytáhni `__NEXT_DATA__` JSON (cheerio nebo regex `<script id="__NEXT_DATA__"[^>]*>(.*?)</script>`), projdi `props.pageProps` apolloState, vezmi objekty s `__typename === 'CheapestTerm'` (rekurzivní sběr přes celý objekt — struktura se může hnout). Mapování: hotelName→title, hotelStars `STAR_5`→5, destinationName→normalizeCountry, boardingType→normalizeBoard, departureDate→parseCzDate, nightCount→nights, priceFrom→pricePerPerson, percentageDiscount→claimedDiscountPct (+ dopočet original), url→absolutní. `sourceOfferKey = offerKeyHash([hotelName, departureDate, nightCount, boardingType])`. `fetchOffers`: `/last-minute/` + 2–3 country stránky (`/recko/`, `/turecko/`, `/egypt/`).
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: bluestyle adapter (__NEXT_DATA__ parser)`

---

### Task 11: Adapter Skrz (RSC `deals` JSON)

**Files:** Create `src/sources/skrz.ts`; Test `tests/skrz.test.ts`, fixtures `tests/fixtures/skrz/dovolena-more-recko.html`, `tests/fixtures/skrz/pobyty-chorvatsko.html`

**Interfaces:** Produces `export const skrz: SourceAdapter`, `export function parseSkrz(html: string): NormalizedOffer[]`.

- [ ] **Step 1: Fixtures** — `curl -sL … "https://skrz.cz/dovolena-more/destinace:recko" -o …` a `"https://skrz.cz/pobyty/destinace:chorvatsko"`.
- [ ] **Step 2: Failing test** — počty (≈24/stránku), první deal s reálnými hodnotami; invarianty; `tourOperator` = serverTitle (tj. „Slevomat", „Blue-style.cz"…); u zájezdů s `?dt=` v detailUrl je `departureDate` vyplněno; voucher pobyty mají `departureDate null` a `nights` z days/nights polí; `pricePerPerson = Math.round(priceFinal / persons)` když `persons ≥ 1`, jinak priceFinal.
- [ ] **Step 3: Implement** — najdi v raw HTML escaped `\"deals\":[`; extrahuj JSON: nejrobustnější je najít všechny `self.__next_f.push(...)` payloady, spojit, unescapovat (`JSON.parse('"' + chunk + '"')` po kusech) a v každém zkusit lokalizovat `"deals":[…]` balancovaným počítáním závorek; pak `JSON.parse`. Mapování: title→title, merchant.title (hotel) preferuj jako title když je, merchant.stars→stars, breadcrumbs.links → country/locality, board→normalizeBoard, transport→normalizeTransport, deptPlace→departureAirport, nights→nights, priceFinal+persons→ceny, discountInPercent→claimedDiscountPct + dopočet original, detailUrl→url (absolutní), `?dt=` z detailUrl→departureDate, hash→sourceOfferKey (+ `dt` v klíči když je). `fetchOffers`: fixní sada 6–10 listing URL (recko, turecko, egypt, chorvatsko, bulharsko + /pobyty varianty).
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: skrz adapter (RSC deals payload)`

---

### Task 12: Adapter Zajezdy.cz (`window.searchData`)

**Files:** Create `src/sources/zajezdy.ts`; Test `tests/zajezdy.test.ts`, fixture `tests/fixtures/zajezdy/recko.html`

**Interfaces:** Produces `export const zajezdy: SourceAdapter`, `export function parseZajezdy(html: string): NormalizedOffer[]`, `export function zajezdyAllowedNow(now?: Date): boolean` (true jen 08:00–24:00 lokálně).

- [ ] **Step 1: Fixture** — `curl -sL … "https://last-minute.zajezdy.cz/recko/" -o tests/fixtures/zajezdy/recko.html`; ověř `window.searchData`.
- [ ] **Step 2: Failing test** — parse: 10 tourResults; první offer reálné hodnoty; departures[] → jeden NormalizedOffer per departure (offer = hotel+termín!), `departureDate` z `odjezdPrijezd` („St 15. 7. – St 22. 7." — rok odvodit: měsíc < aktuální měsíc → příští rok; nights z rozdílu dat), board ze `strava`, letiště z `letiste`, cena `totalAdultPrice.amount`; `claimedDiscountPct` z `poSleve` („po slevě 30 %" → 30, `&nbsp;` handled); `zajezdyAllowedNow(new Date('2026-07-04T07:00'))` false, `T09:00` true.
- [ ] **Step 3: Implement** — regex `window\.searchData\s*=\s*({.*?});` (s DOTALL, pozor na `</script>`), JSON.parse. `sourceOfferKey = offerKeyHash([tourId||title, departureDate, nights])` (tourId z detail URL `z<id>` když je). `fetchOffers`: slugy `['recko','turecko','egypt','chorvatsko','bulharsko','all-inclusive','letecky-praha']`; když `!zajezdyAllowedNow()` → vrať `[]` a zaloguj skip. Host gap 5000 ms (hostGapOverrides — nastaví orchestrator, viz Task 18).
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: zajezdy adapter (searchData, time window)`

---

### Task 13: Adapter Invia (ajax-boxes + JWT)

**Files:** Create `src/sources/invia.ts`; Test `tests/invia.test.ts`, fixture `tests/fixtures/invia/ajax-boxes.json`

**Interfaces:** Produces `export const invia: SourceAdapter`, `export function parseInviaBoxes(json: {customData: {boxes: string}}): NormalizedOffer[]`, `export function decodeOfferJwt(sOfferId: string): Record<string, unknown>|null` (base64url decode payload části JWT, bez verifikace).

- [ ] **Step 1: Capture fixture** — POST s CSRF double-submit:

```bash
TOKEN=$(uuidgen | tr -d '-')
curl -s "https://www.invia.cz/search-results/ajax-boxes" \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $TOKEN" \
  -H "Cookie: __Host-csrf-token_$TOKEN=csrf-token" \
  -A "Mozilla/5.0 …Chrome/126…" \
  --data '{"nl_country_id":[28],"nl_occupancy_adults":2,"sort":"c_price","nl_length_from":7,"nl_length_to":14,"s_holiday_target":"tours","base_url":"https://www.invia.cz/dovolena/"}' \
  -o tests/fixtures/invia/ajax-boxes.json
```

Ověř `customData.boxes` obsahuje offer karty. Pokud endpoint odmítne (změna od reconu), fallback: `curl -sL https://www.invia.cz/dovolena/last-minute/recko/ -o tests/fixtures/invia/last-minute-recko.html` a parsuj SSR karty — stejný parser vzor, zaznamenej do commit message.

- [ ] **Step 2: Failing test** — z fixture: počet karet (≈15); první offer reálné hodnoty; GA4 JSON atributy dávají title/cenu/CK/destinaci; JWT z `s_offer_id` linku dekódovaný → checkInDate/checkOutDate → departureDate + nights, departureAirport, mealId→board (slovníček dle hodnot ve fixture), hotelId+termId → `sourceOfferKey`; badge `Sleva - 40%` → claimedDiscountPct 40 + dopočet original.
- [ ] **Step 3: Implement** — `parseInviaBoxes`: cheerio nad `customData.boxes`; karty dle `data-testid`/tříd ve fixture; GA4 JSON z `data-ga-click-data-value` (HTML-entity unescape → JSON.parse). `decodeOfferJwt`: split '.', payload `Buffer.from(p, 'base64url')`. `fetchOffers`: 2 dotazy (léto-moře country set: Řecko 28 + Turecko/Egypt ID zjisti z fixture/URL parametrů; last-minute: sort `c_price`, `d_start_to` +14 dní) × 2 stránky přes offsets cursor; CSRF tokeny generuj per run (`crypto.randomUUID()`).
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: invia adapter (ajax-boxes, GA4 attrs, offer JWT)`

---

### Task 14: DER helper + adapter eTravel (Omnibus!)

**Files:** Create `src/sources/der.ts`, `src/sources/etravel.ts`; Test `tests/etravel.test.ts`, fixture `tests/fixtures/etravel/getsearchresult.json`

**Interfaces:**
- Produces: `der.ts`: `export interface DerTour { … }` (tvar `tours[]` prvku dle fixture: hotel {name, breadcrumbs}, tour {date, price}, nightsCount, detailUrl…), `export function mapDerTours(tours: unknown[], source: string, baseUrl: string): NormalizedOffer[]` — sdílené mapování pro etravel (a Task 15/16 pokud se tvary shodují; pokud ne, každý adapter mapuje sám a der.ts drží jen společné kusy — rozhodni podle reálných fixtures).
- `export const etravel: SourceAdapter`.

- [ ] **Step 1: Fixture** — nejdřív `curl -s "https://www.etravel.cz/api/searchfilter/getfilter" -A "…" -o /tmp/etravel-filter.json` a vyber destination IDs (Řecko, Turecko, Egypt); pak `curl -s "https://www.etravel.cz/api/searchapi/getsearchresult?ds=0&tt=1&d=<ID>&dd=<dnes>&rd=<dnes+60d>&er=0&isss=0&nn=7%7C8%7C9%7C10%7C11%7C12%7C13%7C14&ac1=2&kc1=0&ic1=0" -o tests/fixtures/etravel/getsearchresult.json`. GET only (HEAD 404).
- [ ] **Step 2: Failing test** — tours[] → offery; první reálné hodnoty; **`omnibusLowestPrice` = `tour.price.lowestPrice`** (klíčové pole!); `pricePerPerson = tour.price.adultPrice`; claimed sleva z `tour.price.discount` (absolutní Kč → pct dopočet vs adultPrice+discount).
- [ ] **Step 3: Implement**; `sourceOfferKey` z detailUrl/hotel id + date. `fetchOffers`: 3 destinace × 1 request (60denní okno pokryje last-minute i sezónu; toursCount stačí první stránka ~20).
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: etravel adapter with Omnibus lowestPrice`

---

### Task 15: Adapter Fischer

**Files:** Create `src/sources/fischer.ts`; Test `tests/fischer.test.ts`, fixtures `tests/fixtures/fischer/last-minute.html`, `tests/fixtures/fischer/getTourHotelList.json`

**Interfaces:** Produces `export const fischer: SourceAdapter`, `export function parseFischerHydration(html: string): {documentGuid: string; tours: unknown[]}`, `export function mapFischerHotels(hotels: unknown[], tourMeta: {departureDate: string|null; nights: number|null; destination: string|null}): NormalizedOffer[]`.

- [ ] **Step 1: Fixtures** — `curl -sL … https://www.fischer.cz/last-minute -o tests/fixtures/fischer/last-minute.html`; z hydration JSON (`div[data-component-name="appTourList"] script[type="application/json"]`) vyber documentGuid + první tour.searchFilter; `curl -s -X POST https://www.fischer.cz/api/TourList/getTourHotelList -H "Content-Type: application/json" --data '{"searchFilter":"<filter>","searchSettings":{"sortBy":"ByDefault","sortOrder":"asc","searchFromIndex":0,"hotelsCountToGet":20}}' -o tests/fixtures/fischer/getTourHotelList.json`.
- [ ] **Step 2: Failing test** — hydration parse vrací guid + tours (≥1); mapFischerHotels: hotel name, stars (rating), meal→board, adultPrice.amount→pricePerPerson, detailUrl→url absolutní; první hotel reálné hodnoty z fixture.
- [ ] **Step 3: Implement** `fetchOffers`: GET /last-minute → hydration tours (každý = destinace+termín) → pro top ~10 tours POST getTourHotelList (5 hotelů/tour) → mapuj s tour metadaty (departureDate, nightsCount, location). Původní cenu ve v1 vynech (vyžaduje další request /searchresult/getsearch per hotel — poznamenáno v backlogu), `claimedOriginalPrice/Pct` nech null — reálná sleva jede z historie/marketu.
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: fischer adapter (hydration + TourList API)`

---

### Task 16: Adapter Exim

**Files:** Create `src/sources/eximtours.ts`; Test `tests/eximtours.test.ts`, fixtures `tests/fixtures/eximtours/last-minute.html`, `tests/fixtures/eximtours/getsearch.json`

**Interfaces:** Produces `export const eximtours: SourceAdapter`, `export function parseEximSeeds(html: string): {name: string; searchUrl: string}[]` (z GroupSearch2 JSON), `export function parseEximSearch(json: {HTML: string}): NormalizedOffer[]`.

- [ ] **Step 1: Fixtures** — `curl -sL … https://www.eximtours.cz/last-minute -o …/last-minute.html`; z GroupSearch2 blobu vyber searchUrl pro Řecko/Egypt; `curl -s "https://www.eximtours.cz/searchresult/getsearch?<params z searchUrl>" -o …/getsearch.json`.
- [ ] **Step 2: Failing test** — seeds: ≥5 destinací se searchUrl; parseEximSearch: karty z `HTML` pole — hotel (link text), země/resort, dates `11.07.2026 - 18.07.2026` → departureDate+nights, `js-roomPrice-adult0`→pricePerPerson, `js-roomPrice-originalPrice`→claimedOriginalPrice, discount dopočet; první karta reálné hodnoty.
- [ ] **Step 3: Implement** — cheerio nad `HTML` polem; NBSP v cenách řeší parseCzk. `sourceOfferKey = offerKeyHash([title, departureDate, nights])`. `fetchOffers`: 3 destinace × 1 request (20 karet each). GET only.
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: eximtours adapter (getsearch HTML payload)`

---

### Task 17: Adapter Dovolena.cz

**Files:** Create `src/sources/dovolena.ts`; Test `tests/dovolena.test.ts`, fixture `tests/fixtures/dovolena/tripListing.json`

**Interfaces:** Produces `export const dovolena: SourceAdapter`, `export function parseDovolena(json: unknown, requestUrl: string): NormalizedOffer[]`.

- [ ] **Step 1: Fixture** — destination ID: `curl -sL … https://dovolena.cz/recko -o /tmp/dov-recko.html` a najdi trip-listing linky/`__NEXT_DATA__` s destination id; pak `curl -s "https://dovolena.cz/api/trip-listing/tripListing?destination=<id>&adult=2&page=1" -o tests/fixtures/dovolena/tripListing.json`.
- [ ] **Step 2: Failing test** — hotels[] → offery: title, noStars→stars, destinations→country/locality, additionalInfo.boarding→board, additionalInfo.transport→transport, priceInfo.regular.amount→pricePerPerson, priceInfo.group.amount→priceTotal; claimed* vždy null (zdroj nemá); URL slož z hotelId/slug (ověř tvar ve fixture — jinak requestUrl jako fallback); první hotel reálné hodnoty.
- [ ] **Step 3: Implement**; `sourceOfferKey = String(hotelId)` (nabídka = hotel bez termínu u tohoto zdroje → departureDate null). `fetchOffers`: 2–3 destinace × page 1–2. Nízká frekvence — jen tyto ~6 requestů.
- [ ] **Step 4–6:** PASS, live smoke, Commit `feat: dovolena.cz adapter (tripListing API)`

---

### Task 18: Scan orchestrator + registry + health alerty

**Files:**
- Create: `src/sources/index.ts`, `src/cli/scan.ts`, `src/core/run.ts`
- Test: `tests/run.test.ts`

**Interfaces:**
- Consumes: všechny adaptery, celý core
- Produces: `src/sources/index.ts`: `export const adapters: SourceAdapter[]` (všech 9). `src/core/run.ts`: `runScan(deps: {db: Db; cfg: AppConfig; http: HttpClient; telegram: Telegram|null; adapters: SourceAdapter[]; now?: Date; log?: (s: string) => void; dryRun?: boolean}): Promise<ScanSummary>` kde `ScanSummary = {perSource: {source: string; status: 'ok'|'partial'|'failed'; offersFound: number; error?: string}[]; notificationsSent: number; digestSent: boolean}`. CLI jen parsuje argv (`--source=X --dry-run --no-notify`) a volá runScan.

- [ ] **Step 1: Failing test `tests/run.test.ts`** — fake adaptery (happy/throwing/blocked), in-memory DB, telegram mock (sbírá zprávy):
  1. throwing adapter → status failed, ostatní běží dál, source_runs zapsané;
  2. offery projdou ingest → discount → filters → notify → telegram.send volán pro hot_deal (fake adapter vrátí offer s vysokou slevou vs. market seed — pre-seeduj DB 8 offery koše);
  3. dryRun → žádný send, žádný notifications_log zápis, ale summary hlásí co BY se poslalo;
  4. 3. selhání zdroje v řadě (pre-seed 2 failed source_runs) → pošle se 🛠 alert, při 4. už ne (alert jen na přechodu 2→3);
  5. digest: now 08:15, žádný digest dnes → digest poslán + zalogován (type 'digest'); druhý běh týž den → neposlán.
- [ ] **Step 2: Implement `run.ts`** — flow: pro každý adapter (sekvenčně — sdílený HttpClient řeší gaps; allSettled semantika přes try/catch): source_run start → fetchOffers → per offer: ingest → (načti ownSnapshots + marketPrices koše z DB) → computeRealDiscount → matchProfiles → evaluateOffer → kandidáti; markMissedOffers; source_run finish. Pak: filterAgainstLog → capMessages → send (formatOffer) + recordSent; overflow zpráva („… a dalších N nabídek"); digest check (`digestHour`, poslední 'digest' log < dnešek) → digest z top 10 aktivních dle realPct; health alerty. Market koš: SQL group dle spec §6 (země, měsíc departureDate, pásmo nocí, board, stars) přes aktivní offery + jejich poslední snapshot.
- [ ] **Step 3: `src/sources/index.ts` + `src/cli/scan.ts`** — CLI: dotenv-like load `.env` (ručně, 10 řádků, bez závislosti), `openDb`+`ensureSchema`, HttpClient s `hostGapOverrides: {'last-minute.zajezdy.cz': 5000}`, Telegram jen když token+chatId, jinak warn + dry-run. Exit code 0 i při partial (jen failed all → 1).
- [ ] **Step 4: Run PASS, typecheck**
- [ ] **Step 5: Celý testsuite** `npx vitest run` — vše zelené.
- [ ] **Step 6: Commit** `feat: scan orchestrator with health alerts and digest`

---

### Task 19: Digest builder + CLI

**Files:**
- Create: `src/core/digest.ts`, `src/cli/digest.ts`
- Test: `tests/digest.test.ts`

**Interfaces:**
- Consumes: Db, format (Task 7), discount (5)
- Produces: `buildDigest(db, cfg: AppConfig, now?: Date): Promise<{html: string; itemCount: number}|null>` (null když žádné aktivní offery). Použito v run.ts (refactor: digest logika z Task 18 se přesune sem, run.ts volá buildDigest) a v `cli/digest.ts` (ruční okamžité poslání bez ohledu na hodinu).

- [ ] **Step 1: Failing test** — seed DB 15 offerů s historií (různé realPct), buildDigest → html obsahuje top 10 seřazených dle realPct desc, stats řádek (aktivních, nových za 24 h dle firstSeenAt), null případ.
- [ ] **Step 2: Implement + refactor run.ts** (import buildDigest).
- [ ] **Step 3: Run PASS (vč. run.test.ts), typecheck, Commit** `feat: digest builder + manual digest CLI`

---

### Task 20: telegram-setup CLI

**Files:** Create `src/cli/telegram-setup.ts`; Test: ruční (interaktivní CLI)

**Interfaces:** Consumes Telegram token z `.env`. Produces: CLI, které pollne `getUpdates` (long-poll timeout 25 s, do 2 minut), vypíše chat_id první příchozí zprávy a appendne/aktualizuje `TELEGRAM_CHAT_ID` v `.env`.

- [ ] **Step 1: Implement** — `https://api.telegram.org/bot<token>/getUpdates?timeout=25&offset=<last+1>`; instrukce na stdout: „Pošli svému botovi libovolnou zprávu…"; po nalezení: vypiš chat_id + jméno, uprav `.env` (zachovej ostatní řádky), vypiš potvrzení. Bez tokenu → srozumitelná chyba s návodem na @BotFather (krok za krokem: /newbot → jméno → token).
- [ ] **Step 2: Typecheck, ruční smoke jen pokud je token v .env (jinak přeskoč — ověří uživatel), Commit** `feat: telegram setup CLI`

---

### Task 21: launchd + README

**Files:** Create `ops/launchd/com.daniel.dovolenky.scan.plist`, `ops/install-launchd.sh`, `README.md`

- [ ] **Step 1: plist** — Label `com.daniel.dovolenky.scan`; ProgramArguments `[/bin/zsh, -lc, cd '/Users/daniel/Library/CloudStorage/OneDrive-Osobní/Effistream/dovolenky' && /usr/bin/env npx tsx src/cli/scan.ts >> logs/scan.log 2>&1]` (pozor: cesta s diakritikou — v plist XML je to OK, v shellu single-quote); StartCalendarInterval: pole 12 dictů `{Hour: 0|2|4|…|22, Minute: 5}`; `RunAtLoad false`.
- [ ] **Step 2: install skript** — zkopíruje plist do `~/Library/LaunchAgents/`, `launchctl unload` (ignore fail) + `launchctl load`; `--uninstall` varianta. `chmod +x`.
- [ ] **Step 3: README.md** — česky: co to je, setup (npm i → cp .env.example .env → BotFather návod → `npm run telegram:setup` → uprav `config/watch.yaml` → `npm run scan -- --dry-run` → `ops/install-launchd.sh`), příkazy, jak přidat zdroj (SourceAdapter kontrakt + fixture test), poznámka o studeném startu (~14 dní), backlog ze spec §12.
- [ ] **Step 4: Ověř** `plutil -lint ops/launchd/*.plist` → OK. Commit `chore: launchd schedule and README`

---

## Self-Review (provedeno)

- **Spec coverage:** §2 architektura→T1–4,18; §3 zdroje→T9–17 (9 adapterů ✓); §4 typy→T1; §5 DB→T3; §6 sleva→T5 (market koš v T18 SQL); §7 notifikace→T7,8,19 + setup T20; §8 config→T2; §9 politeness→T4 (gaps), T12 (okno), Global Constraints; §10 errors→T4 (SourceBlockedError), T18 (izolace, health alerty); §11 testy→všechny tasky TDD + fixtures; §12 backlog→README (T21). Fischer původní cena vědomě odložena (T15) — zapsat do backlogu v README.
- **Placeholders:** fixture-dependent hodnoty jsou označené jako „doplň reálné hodnoty z fixture" s přesným postupem — to je záměr (data neexistují před capture), ne TBD.
- **Type consistency:** `SourceAdapter.fetchOffers(ctx)` jednotné; `parse*` čisté funkce jednotný vzor; `Db` typ z T3 užíván v T8/18/19; `NotifCfg`/`Profile` názvy konzistentní T2↔T6↔T8.

---

### Task 22: Adapter Dovolenkovani.cz (CESYS platforma)

**Files:**
- Create: `src/sources/dovolenkovani.ts`
- Modify: `src/sources/index.ts` (registrace), `README.md` (tabulka zdrojů: 10. řádek)
- Test: `tests/dovolenkovani.test.ts`, fixtures `tests/fixtures/dovolenkovani/{dates-list.json,countries.json,accommodations-sample.xml}`

**Interfaces:**
- Consumes: `SourceAdapter`, `SourceContext`, `HttpClient` (`json` s init pro POST, `text` pro XML), normalize helpery (`normalizeBoard`, `normalizeCountry`, `isKnownCountry`, `offerKeyHash`).
- Produces: `export const dovolenkovani: SourceAdapter` (`name: 'dovolenkovani'`), `export function parseCesysDates(payload, maps): NormalizedOffer[]` (čistá), `export function parseAccommodationsSitemap(xml): Map<number, {name: string; url: string}>` (kód `6a` → id 6; jméno ze slugu: `kalia-beach` → `Kalia Beach`).

Strategie a všechny endpointy/pole: spec §3 řádek 10 (ověřeno živě 2026-07-07 přes Playwright + curl).

- [ ] **Step 1: Fixtures** — curl (standardní Chrome UA projektu, NIKDY Claude-identifikující — robots blokuje ClaudeBot jmenovitě): (a) POST dates-list s body ze spec (date from dnes, to +60d, rows_on_page 30) → dates-list.json; (b) GET mapping/countries → countries.json; (c) GET accommodations.xml → uložit PRVNÍCH ~50 `<url>` bloků jako accommodations-sample.xml (celý soubor necommitovat). Ověřit empiricky per-person vs. total u price_from.CZK: vzít jeden řádek s master_id, otevřít jeho detail URL (ze sitemapy) curl-em a porovnat s SSR „od X Kč" na kartě/detailu, případně porovnat dva dotazy adults:2 vs adults:1 na stejný hotel_id+termín (2 extra requesty povoleny). Zdokumentovat závěr.
- [ ] **Step 2: Failing testy** — parseAccommodationsSitemap: mapa id→{name,url} (reálné hodnoty z fixture, `6a`→6, jméno z slugu title-case); parseCesysDates: počet řádků, první offer reálné hodnoty (title z mapy nebo `Hotel <id>`, country přes mapping+isKnownCountry guard — nikdy syrové id, departureDate ISO, nights=duration_night, board, airport_code, pricePerPerson dle empirického závěru, source 'dovolenkovani'), discount_percent null-guard (0<pct<100), invarianty.
- [ ] **Step 3: Implementace** — `fetchOffers`: accommodations.xml (1 GET, ctx.http.text) → mapa; mapping/countries (1 GET) → mapa zemí; dates-list ×2 (POST přes ctx.http.json s init: query A léto-moře transport 1 + 60 dní, query B last-minute okno dnes→+14 dní; obě sort price asc, rows 30). Per-request izolace (SourceBlockedError stop; selhání sitemapy/mappingu NENÍ fatální — pokračovat s `Hotel <id>`/country null, ale selhání OBOU dates-list dotazů → rethrow dle vzoru fischer). Dedup: sourceOfferKey = offerKeyHash([master_id, date_from, duration_night, boarding_id]). url z mapy hotelů, fallback `https://dovolenkovani.cz/vyhledavani-zajezdu/`. transport: id 1 → 'flight', jinak normalizeTransport(transport). claimedDiscountPct z discount_percent + dopočet original; oboje null při mimo (0,100).
- [ ] **Step 4: Registrace + README** — přidat do `adapters` v src/sources/index.ts; README tabulka zdrojů +1 řádek (CESYS white-label, co dává: termíny+ceny+slevy přes API, jména hotelů ze sitemapy).
- [ ] **Step 5: Live smoke** — max 6 requestů, vypsat počty + 2 offery.
- [ ] **Step 6: Zelené testy + commit** — plný `npx vitest run` (286 stávajících zůstává zelených) + `npx tsc --noEmit`; commit `feat: dovolenkovani adapter (CESYS dates-list API)` vč. fixtures.

---

### Task 23: Cross-source match key (core)

**Files:**
- Modify: `src/core/normalize.ts` (+normalizeHotelName, +normalizeAirport), `src/core/db/schema.ts` + `src/core/db/index.ts` (ensureSchema: nové sloupce), `src/core/ingest.ts` (výpočet match_key)
- Test: `tests/normalize.test.ts` (rozšířit), `tests/ingest.test.ts` (rozšířit)

**Interfaces:**
- Produces: `normalizeHotelName(raw: string): string`; `normalizeAirport(raw: string|null|undefined): string|null`; `computeMatchKey(o: NormalizedOffer): string|null` (export z ingest.ts nebo normalize.ts — rozhodni dle závislostí, match_key = null když departureDate null či board unknown); `offers.match_key TEXT` (index, ne unique), `notifications_log.match_key TEXT` nullable.
- Migrace: ensureSchema přidá sloupce přes PRAGMA table_info check + ALTER TABLE ADD COLUMN (SQLite bez IF NOT EXISTS); backfill match_key pro existující offers řádky s NULL (jednorázově při startu, levné).

- [ ] Testy dle spec §13 (kanonizace jmen vč. „Blue Aegean Resort & Spa" → „blue aegean", letiště Praha→PRG, null pravidla) → implementace → plný suite zelený → commit `feat: cross-source match key`.

### Task 24: Cross-source dedup — konzumenti (notify, digest, market)

**Files:**
- Modify: `src/core/notify.ts` (grouping + log dedup na match_key), `src/core/run.ts` (předání match_key, market MIN na skupinu), `src/core/digest.ts` + `src/core/market.ts` (grouping), `src/core/format.ts` (řádek „Také: …")
- Test: `tests/notify.test.ts`, `tests/run.test.ts`, `tests/digest.test.ts`, `tests/format.test.ts` (rozšířit)

**Interfaces:**
- `Candidate` získá `matchKey: string|null` a `alternatives: {source: string; pricePerPerson: number; url: string}[]` (max 3, cena vzestupně, bez reprezentanta).
- `capMessages`/`filterAgainstLog` pracují nad seskupenými kandidáty; log dedup klíč = match_key ?? String(offerId).
- `formatOffer`: za cenový řádek přidá „Také: Invia 13 990 Kč · Skrz 14 200 Kč" jen když alternatives.length > 0.
- Market bucket (market.ts): GROUP BY match_key (NULL skupiny zůstávají per-offer), cena skupiny = MIN.

- [ ] Testy: dvojice offers ze dvou zdrojů se stejným match_key → 1 notifikace s „Také:", log dedup blokuje re-notifikaci druhého zdroje, digest top-10 bez duplicit, market bucket počítá MIN; NULL match_key beze změny chování → implementace → plný suite zelený → commit `feat: cross-source dedup in notifications, digest and market baseline`.

---

### Task 25: Web scaffold + Hono API

**Files:** Create `web/` (Vite React TS, Tailwind v4 s tokeny z design-system/MASTER.md, @fontsource-ibm-plex-mono + @fontsource/barlow), `src/web/server.ts` + `src/web/api.ts` (Hono: /api/offers, /api/offers/:id/history, /api/sources, /api/stats dle spec §14, in-memory cache 5 min), `package.json` scripts (`web`, `web:dev`, `web:build`); Test `tests/api.test.ts` (in-memory DB seed přes ingestOffer, všechny 4 endpointy — tvary, grouping s alternatives, cache hit).
- [ ] TDD API; frontend scaffold jen kostra (index.html, tokeny, fonty, prázdná App s „Terminál" hlavičkou); plný suite zelený; commit `feat: web scaffold and terminal API`.

### Task 26: Odletová tabule (board UI)

**Files:** `web/src/` komponenty: StatusLine, FilterChips, Board, BoardRow, Sparkline; fetch z /api/offers + /api/sources; Test: čisté helpery (formatCzk, discount barvy, grouping) vitest.
- [ ] Dle mockupu 1:1 (tokeny, mono labely, flap animace, reduced-motion); filtry fungují client-side nad API daty; commit `feat: terminal board UI`.

### Task 27: Detail + karty

**Files:** `web/src/` OfferDetail (SVG cenový graf: křivka, pásmo mediánu, čárkovaná „původní cena", DNES bod; fakta; verdikt; Otevřít CTA; „Také:" alternativy), MarketCard (TRH DNES z /api/stats), SourcesCard (/api/sources vč. backoff stavu); empty state.
- [ ] Graf z /api/offers/:id/history; copy dle MASTER.md (stop-slop); commit `feat: offer detail and status cards`.

### Task 28: Playwright smoke + integrace + finální review

**Files:** `tests/e2e/terminal.spec.ts` (Playwright: seed DB skriptem, start serveru, board render, filtr, detail expand, žádné console errors), README sekce „Dashboard", `.gitignore` web build.
- [ ] Smoke zelený lokálně; plný suite + tsc; whole-branch review fable → fix vlna → merge do main; commit `feat: terminal e2e smoke and docs`.

---

### Task 29: Filtr panel (propracované filtrování tabule)

Zadání od uživatele 2026-07-07: „Proč se tam nahoře dají vybrat jen některé destinace? Chybí mi propracované filtrování."

**Files:** web/src (FilterBar nahrazuje FilterChips; lib/filters.ts čisté predikáty; App URL-state sync), tests: web unit + úprava tests/e2e/terminal.spec.ts (filtr scénáře).

**Design (dle MASTER.md estetiky — chips + mono labely, žádné těžké dropdown knihovny):**
- **Země**: chips VŠECH zemí přítomných v datech s počty („Řecko 41"), řazené dle počtu, zobrazeno prvních ~8 + „+ dalších N" rozbalovací řádek (důvod dnešního omezení: chips se derivují z dat a řadí — doplnit počty a overflow).
- **Cena max/os.**: preset chips (10/15/20/25 tis. + vlastní input).
- **Noci**: pásma ≤5 · 6–8 · 9–12 · 13+ (multi).
- **Strava**: AI · HB · BB · bez stravy (multi).
- **Odlet**: letiště z dat (PRG/BRQ/OSR/…, multi) + „vlastní doprava".
- **Termín**: od–do date inputy.
- **Min. reálná sleva**: chips 0/10/15/25 %.
- **Zdroj**: multi z dat.
- **Řazení**: reálná sleva ↓ (default) · cena ↑ · odlet ↑.
- Aktivní filtry: počítadlo + „Vymazat vše"; stav synchronizovaný do URL query (sdílitelné/bookmarkovatelné); profil chip zůstává server-side param.
- Vše ostatní client-side nad načteným setem (API vrací kompletní aktivní set — ověřit, žádný cap).

- [ ] Čisté predikáty + testy (každý filtr + kombinace + URL round-trip); FilterBar UI dle tokenů; e2e: kombinace filtrů zúží tabuli + URL restore; plný suite + build zelené; commit `feat: terminal filter panel`.

---

### Task 30: hotel_key (identita hotelu pro referenční žebřík)

**Files:** normalize.ts (+computeHotelKey), db/schema.ts + db/index.ts (offers.hotel_key + index + ensureColumn + backfill — kopíruj match_key mašinérii z Tasku 23), ingest.ts (compute + refresh, sticky guard neovlivňuje). Test: normalize.test.ts, ingest.test.ts.
- [ ] `computeHotelKey(o): string|null` = offerKeyHash([normalizeHotelName(title), country]); null když normalizeHotelName prázdné NEBO country null. offers.hotel_key TEXT + index. ensureColumn (PRAGMA guard) + backfill NULL řádků. ingest ukládá na insert i update (z persistovaného title, konzistentně s match_key). Testy: dva termíny téhož hotelu (různá data) → stejný hotel_key; různé match_key; prázdné jméno/null země → null. Plný suite zelený → commit `feat: hotel_key identity for reference ladder`.

### Task 31: Discount engine v2 (per-noc, 5 příček)

**Files:** discount.ts (rozšířit vstup + DiscountResult.reference), types dle potřeby. Test: discount.test.ts (rozšířit).
- [ ] `computeRealDiscount` vstup rozšířit o `hotelTermPricesPN: number[]`, `localityPricesPN: number[]` (per-noc pole), a `nights` subjektu (pro per-noc přepočet current). `DiscountResult.reference` = 'own'|'omnibus'|'hotel'|'locality'|'market'|null. Žebřík dle spec §15: own(≥3,rozpětí≥5d) > omnibus > hotel(≥4) > locality(≥8) > market(≥8, per-noc). Vše per-noc: currentPN = round(current/nights). realPct = round((basePN−currentPN)/basePN×100). baseline v resultu = basePN × nights (ekvivalent). Guardy ≤0 → propadnout. fake ≥15 p.b. Testy: každá příčka vyhrává za správných podmínek, min-count gaty (hotel 3 vs 4, locality 7 vs 8, market 7 vs 8), per-noc math (různé délky srovnány férově), nights null → own/omnibus jen, fallthrough při prázdných polích. Commit `feat: per-night 5-tier discount reference ladder`.

### Task 32: Market dotazy v2 (hotel + lokalita + per-noc country)

**Files:** market.ts (+hotelTermPricesPN, +localityBucketPricesPN, country bucket → per-noc), run.ts + digest.ts (předat nové vstupy do computeRealDiscount). Test: market.test.ts (rozšířit), run.test.ts, digest.test.ts.
- [ ] `hotelTermPricesPN(db, offerId, offer)` = SELECT per-noc (price/nights) posledních snapshotů aktivních offers se stejným hotel_key, stejná strava, |nights−offer.nights|≤2, |dateDiff|≤30 dní, vyloučit offer.id i řádky se stejným match_key jako subjekt (twin-exclusion jako Task 24 fix), nights≥1. `localityBucketPricesPN(db, offerId, offer)` = koš locality×měsíc(departureDate)×board×stars, per-noc, twin+self exclusion. `marketBucketPrices` → vracet per-noc. run.ts processOffers + digest buildDigest: naplnit hotelTermPricesPN/localityPricesPN/nights a předat. Testy: hotel se 4 termíny → hotel příčka; lokalita koš ≥8 → locality; country per-noc opravuje jednonocový nesmysl (1noc pobyt už nevychází „levně" proti vícenocovým). Commit `feat: hotel/locality per-night market queries wired into scan+digest`.

### Task 33: Popisky reference (Telegram + web) + finální review

**Files:** format.ts (referenceLabel per stupeň + baseline jako ekvivalent), web/src (board REÁLNÁ buňka + detail verdikt: „vs. tento hotel" / „vs. Kréta" / „vs. Řecko"), api.ts pokud vrací reference (vrací — jen doplnit label mapu na FE). Test: format.test.ts, web unit.
- [ ] format.ts: `referenceLabel(reference, offer): string` (own „30denní medián", omnibus „Omnibus 30denní min.", hotel „tento hotel", locality → offer.locality, market → offer.country). Board buňka „−22 % vs. <label> <ekvivalent Kč>". Detail verdikt zmíní stupeň. Telegram formatOffer taktéž. Testy všech větví. Poté: whole-branch review (fable) → fix vlna → merge do main. Commit `feat: reference-tier labels in notifications and dashboard`.
