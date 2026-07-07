/**
 * Pure formatters for the TERMÍN column (departure date range + nights line) and
 * the STRAVA / ODLET cells. Kept DOM-free and unit-tested (term.test.ts). All
 * copy is Czech per design-system/MASTER.md.
 */

/**
 * Formats a source-run/scan timestamp as Prague wall-clock time ("14:05"),
 * shared by StatusLine (SCAN) and MarketCards (ZDROJE run times) so both
 * report the same local time instead of StatusLine drifting to UTC.
 */
const pragueHhmmFormatter = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague',
  hour: '2-digit',
  minute: '2-digit',
});

/** ISO timestamp → Prague local "14:05". Returns "—" for a missing/invalid input. */
export function pragueHhmm(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return pragueHhmmFormatter.format(d);
}

/** "2026-08-15" → "15.08". Returns "—" for a missing/invalid date. */
export function formatDayMonth(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

/**
 * The TERMÍN top line: a start–end range like "08.07 – 15.07" derived from the
 * departure date + nights. With no date we show "volný termín" (matching the
 * mockup's date-less last-minute row). En-dash separator per the mockup.
 */
export function formatTermRange(
  departureDate: string | null | undefined,
  nights: number | null | undefined,
): string {
  if (!departureDate) return 'volný termín';
  const start = new Date(departureDate);
  if (Number.isNaN(start.getTime())) return 'volný termín';
  const startStr = formatDayMonth(departureDate);
  if (nights == null || !Number.isFinite(nights)) return startStr;
  const end = new Date(start.getTime() + nights * 24 * 60 * 60 * 1000);
  return `${startStr} – ${formatDayMonth(end.toISOString())}`;
}

/** Czech plural for "noc": 1 noc, 2–4 noci, 5+ nocí. */
export function nightsLabel(nights: number | null | undefined): string {
  if (nights == null || !Number.isFinite(nights)) return '';
  if (nights === 1) return '1 noc';
  if (nights >= 2 && nights <= 4) return `${nights} noci`;
  return `${nights} nocí`;
}

/** Human board label for the STRAVA cell. Unknown/none → "—". */
const BOARD_LABELS: Record<string, string> = {
  AI: 'All inclusive',
  UAI: 'Ultra all inclusive',
  FB: 'Plná penze',
  HB: 'Polopenze',
  BB: 'Snídaně',
  none: 'Bez stravy',
  unknown: '—',
};

export function boardLabel(board: string | null | undefined): string {
  if (!board) return '—';
  return BOARD_LABELS[board] ?? board;
}

/** ODLET cell: airport code uppercased, or "—" when transport isn't a flight. */
export function departureLabel(
  airport: string | null | undefined,
  transport: string | null | undefined,
): string {
  if (airport && airport.trim() !== '') return airport.toUpperCase();
  if (transport === 'own') return 'vlastní';
  if (transport === 'bus') return 'bus';
  return '—';
}

/**
 * The ZDROJ cell primary label: a source slug rendered in the mockup's caps.
 * Left as an uppercase transform of the source id (invia → INVIA); a display
 * map can be layered later without touching call sites.
 */
export function sourceLabel(source: string): string {
  return source.toUpperCase();
}
