/**
 * Detects that the host slept (froze this process) while a watch was running.
 *
 * WHY: the Mac fallback scanner (ops/launchd/com.daniel.dovolenky.scan.plist) is started by
 * launchd inside macOS *DarkWake* windows — `pmset -g log` on 2026-09-03 showed the machine
 * waking every ~15 min all night for 2–45 s. The scan starts in such a window, the Mac sleeps
 * seconds later, the process is frozen mid-fetch and its sockets die. On thaw every slow source
 * reports "fetch exceeded 420000ms budget" or Turso ECONNRESET, and sources that DID return
 * came back truncated (etravel 320/916, dovolena 200/419 in the log). Over 7 days ~57 % of Mac
 * runs were poisoned this way (dovolenkovani mac: 16 ok / 21 failed) — every one of them wrote
 * `failed` source_runs rows and fed 🛠 health alerts for sources that were perfectly healthy.
 *
 * HOW: a periodic tick records when it last ran. A live process ticks every `tickMs` (give or
 * take event-loop jitter); a frozen process cannot tick at all, so when a tick finally fires
 * `now() - last` is one period PLUS the whole time asleep. Any excess of at least `gapMs` is
 * accumulated as frozen time. This deliberately does NOT rely on a monotonic clock that
 * excludes sleep (macOS's does not, and Date.now is wall-clock anyway) — it measures that the
 * tick did not happen, which a frozen process cannot fake. stop() also accounts the tail (a
 * freeze after the last tick that no tick ever observed) and returns the total.
 *
 * The threshold `gapMs` is well above legitimate event-loop stalls in the fetch phase (network
 * wait; cheerio parsing a page is tens of ms), but the caller should stop the watch BEFORE any
 * CPU-heavy processing where a long synchronous stretch could look like a freeze.
 */

export interface SleepWatch {
  /**
   * Begins ticking and a FRESH measurement (a watch can be restarted after stop()). Calling it
   * while already running is a no-op.
   */
  start(): void;
  /**
   * Stops ticking, accounts the gap since the last tick, and returns the total milliseconds
   * the process was frozen while the watch ran. Idempotent: later calls return the same total
   * without re-measuring, until the next start(). Returns 0 if the watch was never started.
   */
  stop(): number;
}

export interface SleepWatchOptions {
  /** Wall-clock source (ms). Injectable for tests. */
  now?: () => number;
  /** Tick period. 5 s keeps the watch cheap while resolving sleeps far shorter than gapMs. */
  tickMs?: number;
  /** Minimum excess over one period that counts as "frozen". Below it is event-loop jitter. */
  gapMs?: number;
  /** setInterval stand-in. The returned handle is unref()'d when it supports it. */
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  /** clearInterval stand-in, given the handle setIntervalImpl returned. */
  clearIntervalImpl?: (handle: unknown) => void;
}

const DEFAULT_TICK_MS = 5000;
const DEFAULT_GAP_MS = 60000;

export function createSleepWatch(opts: SleepWatchOptions = {}): SleepWatch {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const setIntervalImpl = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let handle: unknown = null;
  let running = false;
  let last = 0;
  let frozenMs = 0;

  // Shared by the periodic tick and stop(): the excess of the elapsed time over one period is
  // the time no tick could run. Anything under gapMs is scheduling noise and ignored.
  function account(): void {
    const t = now();
    const gap = t - last - tickMs;
    if (gap >= gapMs) frozenMs += gap;
    last = t;
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      frozenMs = 0;
      last = now();
      handle = setIntervalImpl(account, tickMs);
      // The watch must never be the thing keeping the scan process alive: once the CLI is done
      // it should exit even if stop() was skipped by an exception path.
      const maybeUnref = (handle as { unref?: unknown } | null)?.unref;
      if (typeof maybeUnref === 'function') (handle as { unref: () => void }).unref();
    },
    stop(): number {
      if (!running) return frozenMs;
      running = false;
      clearIntervalImpl(handle);
      handle = null;
      // The tail: a freeze after the last tick fired is only visible from here.
      account();
      return frozenMs;
    },
  };
}
