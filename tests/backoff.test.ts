import { describe, it, expect } from 'vitest';
import { backoffUntilFrom, type BackoffRow } from '../src/core/backoff.js';

// All rows passed newest-first, mirroring the `orderBy(desc(sourceRuns.id))` query shape.

describe('backoffUntilFrom', () => {
  it('blocked 2h ago → returns the lift time (blockedAt + 24h)', () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const blockedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const rows: BackoffRow[] = [
      { status: 'failed', errorSample: 'BLOCKED:Request blocked with status 403', startedAt: blockedAt },
    ];

    const until = backoffUntilFrom(rows, now.getTime());
    expect(until).toBe(new Date(blockedAt).getTime() + 24 * 60 * 60 * 1000);
  });

  it('blocked, but a newer REAL ok run supersedes it → null (this is the reviewer-flagged divergence)', () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const rows: BackoffRow[] = [
      // Newest first: a real 'ok' run after the block lifts the hold immediately.
      { status: 'ok', errorSample: null, startedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() },
      {
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
        startedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      },
    ];

    expect(backoffUntilFrom(rows, now.getTime())).toBeNull();
  });

  it('blocked, with interleaved backoff bookkeeping rows → still returns the lift time', () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const rows: BackoffRow[] = [
      // Newest first: two backoff bookkeeping rows, then the real BLOCKED failure.
      { status: 'partial', errorSample: 'backoff', startedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() },
      { status: 'partial', errorSample: 'backoff', startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() },
      {
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
        startedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      },
    ];

    const blockedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).getTime();
    expect(backoffUntilFrom(rows, now.getTime())).toBe(blockedAt + 24 * 60 * 60 * 1000);
  });

  it('blocked 25h ago → backoff has lifted → null', () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const rows: BackoffRow[] = [
      {
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
        startedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      },
    ];

    expect(backoffUntilFrom(rows, now.getTime())).toBeNull();
  });

  it('no rows → null', () => {
    expect(backoffUntilFrom([], Date.now())).toBeNull();
  });

  it('newest non-backoff row is failed but NOT blocked (plain error) → null', () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const rows: BackoffRow[] = [
      { status: 'failed', errorSample: 'parser exploded', startedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() },
    ];

    expect(backoffUntilFrom(rows, now.getTime())).toBeNull();
  });
});
