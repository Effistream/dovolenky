import { describe, it, expect } from 'vitest';
import { createSleepWatch } from '../src/core/sleep-watch.js';

const TICK_MS = 5000;
const GAP_MS = 60000;
const FIFTEEN_MIN = 15 * 60 * 1000;

/**
 * A fully injected clock + interval: the test decides when each tick fires and what `now()`
 * reads at that moment. A tick that fires late (clock jumped further than one period) is what
 * a frozen process looks like from inside — the event loop never ran during the sleep.
 */
function fakeTimers() {
  let clock = 0;
  let callback: (() => void) | null = null;
  let unrefCalls = 0;
  const handle = {
    unref() {
      unrefCalls += 1;
    },
  };
  const cleared: unknown[] = [];
  const registered: number[] = [];
  return {
    now: () => clock,
    setInterval(fn: () => void, ms: number): unknown {
      callback = fn;
      registered.push(ms);
      return handle;
    },
    clearInterval(h: unknown): void {
      cleared.push(h);
    },
    /** Move the clock to `t` and fire the interval callback (a tick observed at time t). */
    tickAt(t: number): void {
      clock = t;
      if (!callback) throw new Error('interval not registered');
      callback();
    },
    /** Move the clock without a tick (the process was frozen, or stop() is about to be called). */
    jumpTo(t: number): void {
      clock = t;
    },
    handle,
    cleared,
    registered,
    unrefCalls: () => unrefCalls,
  };
}

function watchWith(t: ReturnType<typeof fakeTimers>) {
  return createSleepWatch({
    now: t.now,
    tickMs: TICK_MS,
    gapMs: GAP_MS,
    setIntervalImpl: t.setInterval,
    clearIntervalImpl: t.clearInterval,
  });
}

describe('createSleepWatch', () => {
  it('case 1: ticks arriving on schedule (and a little late) add up to 0 frozen ms', () => {
    const t = fakeTimers();
    const w = watchWith(t);
    w.start();
    // Normal scheduling jitter: a few hundred ms late is NOT a sleep.
    t.tickAt(5000);
    t.tickAt(10300);
    t.tickAt(15100);
    t.tickAt(20000);
    t.jumpTo(21000);
    expect(w.stop()).toBe(0);
    expect(t.registered).toEqual([TICK_MS]);
  });

  it('case 2: one tick that fires 15 min late counts ~15 min of frozen time', () => {
    const t = fakeTimers();
    const w = watchWith(t);
    w.start();
    t.tickAt(5000);
    t.tickAt(10000);
    // The process froze right after the 10 s tick; the next tick only runs once it thaws.
    t.tickAt(10000 + TICK_MS + FIFTEEN_MIN);
    t.tickAt(10000 + TICK_MS + FIFTEEN_MIN + TICK_MS);
    t.jumpTo(10000 + TICK_MS + FIFTEEN_MIN + TICK_MS + 1000);
    expect(w.stop()).toBe(FIFTEEN_MIN);
  });

  it('case 3: a gap that opens AFTER the last tick is still counted by stop()', () => {
    const t = fakeTimers();
    const w = watchWith(t);
    w.start();
    t.tickAt(5000);
    t.tickAt(10000);
    // Frozen from 10 s until stop() — no tick ever observed the gap, so stop() must.
    t.jumpTo(10000 + TICK_MS + FIFTEEN_MIN);
    expect(w.stop()).toBe(FIFTEEN_MIN);
  });

  it('case 4: stop() clears the interval it registered and is idempotent', () => {
    const t = fakeTimers();
    const w = watchWith(t);
    w.start();
    t.tickAt(5000);
    t.jumpTo(6000);
    expect(w.stop()).toBe(0);
    expect(t.cleared).toEqual([t.handle]);
    // A second stop() neither clears again nor re-measures (the clock may have moved on since).
    t.jumpTo(6000 + FIFTEEN_MIN);
    expect(w.stop()).toBe(0);
    expect(t.cleared).toEqual([t.handle]);
  });

  it('unrefs the interval so the watch never keeps the process alive', () => {
    const t = fakeTimers();
    const w = watchWith(t);
    w.start();
    expect(t.unrefCalls()).toBe(1);
    w.stop();
  });

  it('stop() before start() is a no-op returning 0', () => {
    const t = fakeTimers();
    const w = watchWith(t);
    expect(w.stop()).toBe(0);
    expect(t.cleared).toEqual([]);
  });

  it('start() after stop() begins a fresh measurement (the watch is reusable)', () => {
    const t = fakeTimers();
    const w = watchWith(t);
    w.start();
    t.tickAt(5000);
    t.jumpTo(5000 + TICK_MS + FIFTEEN_MIN);
    expect(w.stop()).toBe(FIFTEEN_MIN);
    // Second session: no freeze → 0, not the previous 15 min carried over.
    w.start();
    const t0 = t.now();
    t.tickAt(t0 + TICK_MS);
    t.jumpTo(t0 + TICK_MS + 500);
    expect(w.stop()).toBe(0);
  });

  it('a gap just under gapMs is ignored; exactly gapMs is counted (boundary)', () => {
    const under = fakeTimers();
    const wUnder = watchWith(under);
    wUnder.start();
    under.tickAt(TICK_MS + GAP_MS - 1);
    under.jumpTo(TICK_MS + GAP_MS);
    expect(wUnder.stop()).toBe(0);

    const at = fakeTimers();
    const wAt = watchWith(at);
    wAt.start();
    at.tickAt(TICK_MS + GAP_MS);
    at.jumpTo(TICK_MS + GAP_MS + 1);
    expect(wAt.stop()).toBe(GAP_MS);
  });
});
