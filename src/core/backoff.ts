/** error_sample prefix marking a run that ended 'failed' because the source blocked us
 *  (403/429). Used by the 24h backoff (spec §9): a source blocked within the last 24h is
 *  skipped rather than re-hammered. */
export const BLOCKED_PREFIX = 'BLOCKED:';

/** error_sample marker written on the benign 'partial' row inserted when a source is skipped
 *  because it is still within its 24h block-backoff window. These rows are bookkeeping only:
 *  they must be transparent to both the block-history scan (backoffUntilFrom) and the
 *  consecutive-failure chain (maybeSendHealthAlert in run.ts), otherwise they mask the real
 *  state (I2 defect). Both consumers skip rows where error_sample === BACKOFF_MARKER. */
export const BACKOFF_MARKER = 'backoff';

export const BACKOFF_MS = 24 * 60 * 60 * 1000;

/** How many recent runs to scan back through when skipping backoff rows to find the last
 *  real (non-backoff) run. Generous enough to see past a long block-backoff streak at the
 *  scheduled 2h cadence (max ~12 backoff rows per 24h block window). Known limitation:
 *  frequent MANUAL reruns during an active block can push the blocked row past this window —
 *  backoff then fails safe (re-attempts early) but the health alert stays silent until the
 *  manual runs stop. */
export const RECENT_RUN_SCAN_LIMIT = 20;

/** True for a bookkeeping row inserted by the block-backoff skip (transparent to history). */
export function isBackoffRow(errorSample: string | null | undefined): boolean {
  return errorSample === BACKOFF_MARKER;
}

export interface BackoffRow {
  status: string | null;
  errorSample: string | null;
  startedAt: string;
}

/**
 * 24h backoff after a block (spec §9): given recent source_runs rows for a single source,
 * newest-first, finds the most recent REAL run (skipping the benign backoff-skip bookkeeping
 * rows this very mechanism inserts — otherwise a persistently blocked source would see its own
 * backoff row, decide there's no active block, and re-hammer the source every ~4h; I2 defect).
 * If that first non-backoff row ended 'failed' with a BLOCKED: error_sample within the last
 * BACKOFF_MS (relative to nowMs), returns the epoch ms the backoff lifts; otherwise null.
 *
 * The first non-backoff row decides. Backoff rows are our own bookkeeping and never a signal —
 * a more recent REAL (non-backoff) run, even an 'ok' one, supersedes an older BLOCKED failure.
 */
export function backoffUntilFrom(rows: BackoffRow[], nowMs: number): number | null {
  const last = rows.find((r) => !isBackoffRow(r.errorSample));
  if (!last || last.status !== 'failed' || !last.errorSample?.startsWith(BLOCKED_PREFIX)) return null;

  const blockedAt = new Date(last.startedAt).getTime();
  if (Number.isNaN(blockedAt)) return null;

  const liftsAt = blockedAt + BACKOFF_MS;
  return nowMs < liftsAt ? liftsAt : null;
}
