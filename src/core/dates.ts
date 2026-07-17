const PRAGUE_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Formats a Date as a Y-M-D string (YYYY-MM-DD) in the Europe/Prague calendar day. */
export function pragueDayString(d: Date): string {
  return PRAGUE_DAY_FORMATTER.format(d);
}

/**
 * True when an offer's departure day already passed (Europe/Prague calendar).
 * A departed offer can no longer be bought, so it must not surface on the board,
 * in the digest, or in notifications — some sources keep listing departed terms,
 * which keeps them active in the DB. Departing TODAY is not departed (same-day
 * last-minute is still bookable); a null date is unknown, not departed.
 */
export function hasDeparted(departureDate: string | null, now: Date): boolean {
  return departureDate != null && departureDate < pragueDayString(now);
}

/** Number of calendar days from `fromYmd` to `toYmd` (both YYYY-MM-DD strings). */
export function dayDiff(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  const fromMs = Date.UTC(fy!, fm! - 1, fd!);
  const toMs = Date.UTC(ty!, tm! - 1, td!);
  return Math.round((toMs - fromMs) / DAY_MS);
}
