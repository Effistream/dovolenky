# Dovolenky — design system „Terminál"

Zdroj pravdy pro frontend. Mockup: `docs/design/terminal-mockup.html` (artifact „terminal-v1").
Koncept: osobní **odletová tabule** — deal feed jako departure board, zbytek stránky tichý a světlý.
Inspirace: Flighty (letecká přesnost, data-density), Going (deal feed s verdikty), split-flap tabule.

## Barvy

| Token | Hex | Použití |
|---|---|---|
| `--ink` | `#14161B` | tabule (jediná tmavá plocha na stránce), text nadpisů |
| `--ink-2` | `#1C1F26` | hover řádku, detail panel v tabuli |
| `--ink-3` | `#262A33` | bordery uvnitř tabule |
| `--paper` | `#F2F4F6` | pozadí stránky (chladná šedobílá — ne krémová) |
| `--card` | `#FFFFFF` | světlé karty |
| `--line` | `#E1E5EA` | bordery světlých karet |
| `--amber` | `#FFC24D` | akcent tabule (letištní jantar): nadpis tabule, primární CTA, mid-slevy |
| `--deal` / `--deal-board` | `#167A52` / `#43C48E` | reálná sleva (světlý/tmavý podklad) |
| `--warn` / `--warn-board` | `#C23B2E` / `#FF8A76` | flag NADSAZENÁ (světlý/tmavý podklad) |
| `--txt` / `--txt-muted` | `#23272F` / `#5B6572` | text na světlé |
| `--board-txt` / `--board-muted` | `#E9ECEF` / `#98A1AD` | text na tabuli |

Zásady: tmavá je JEN tabule. Sémantické barvy (deal/warn) nejsou akcent. Kontrast AA ověřen
pro obě plochy zvlášť.

## Typografie

- **IBM Plex Mono** 400/600 — tabule, čísla, labely (uppercase + letter-spacing 0.10–0.16em),
  status řádek. Vždy `font-variant-numeric: tabular-nums` u čísel.
- **Barlow** 400/600 — UI texty, tlačítka, popisy (DNA silničního/letištního značení, plná čeština).
- Nepoužívat: Inter, Space Grotesk (generické), B612 (nemá latin-ext → rozbité ěščřž).
- Načítání: latin + latin-ext subsety; v appce přes lokální woff2 (ne CDN v artifactech).

## Layout

1. Status řádek (mono 12px): poslední scan, zdroje N/N, digest.
2. Filtry: chips (profily = single-select, země = multi-select), práh vpravo.
3. **Tabule** (signature): grid řádky, sloupce DESTINACE / TERMÍN / ODLET / STRAVA / CENA/OS. /
   30 DNÍ (sparkline) / REÁLNÁ / UVÁDÍ / ZDROJ. Řazení podle reálné slevy. Klik na řádek →
   rozbalený detail (cenový graf + fakta + verdikt + CTA) uvnitř tabule.
4. Dvě tiché světlé karty: TRH DNES (3 čísla) a ZDROJE (status grid).
5. Žádný sidebar, žádné KPI hero karty, žádné gradienty.

Breakpoint 900px: tabule → stacked karty (skryté sloupce ODLET/STRAVA/spark), detail 1 sloupec.

## Komponenty & stavy

- **Reálná sleva**: zelená ≥15 %, jantarová 1–14 %, šedá „+X % zdražuje", šedá „SBÍRÁM HISTORII ·
  N. den z ~14" když chybí reference. Vždy s referencí: „vs. medián 19 400".
- **Flag NADSAZENÁ**: outline chip s trojúhelníkem, jen když uváděná − reálná ≥ 15 p. b.
- **Detail graf**: bílá cenová křivka, jantarové pásmo mediánu, červená čárkovaná „původní cena"
  s popiskem „ZA TU SE NEPRODÁVALO", zelený bod DNES. Popisky mono 10–11px.
- **Sparkline**: 7 bodů, zelená při poklesu, šedá jinak, tečka na konci.
- **CTA**: primární jantar na tabuli („Otevřít u Eximu"), ghost sekundární („Ztlumit na 7 dní").
- Ikony: inline SVG (žádná emoji), stroke 1.4–1.6.

## Motion

Jediný orchestrovaný moment: řádky tabule se při načtení „naklapou" (stagger 40ms, translateY,
380ms ease-out). Hover řádku 150ms. Vše za `prefers-reduced-motion: no-preference`.

## Copy (stop-slop pravidla)

- Konkrétní čísla místo přídavných jmen: „Proti reálnému trhu ušetříš 15 %", ne „skvělá nabídka".
- Aktivní rod, kontroly říkají co udělají: „Otevřít u Eximu", „Ztlumit na 7 dní".
- Verdikt fake slevy jmenuje aktéra: „Exim počítá slevu 52 % z ceny 34 300 Kč. Za tu se termín
  posledních 30 dní neprodával."
- Empty state = pozvánka k akci: „Nic tu není. Povol více zemí, nebo sniž práh slevy."
- Zákaz: „Vítejte", vykřičníky, „úžasné nabídky", pasivum, em-dash v UI textech.
