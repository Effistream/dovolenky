import { describe, it, expect, vi } from 'vitest';
import { HttpClient, SourceBlockedError } from '../src/core/http.js';

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, init?: { status?: number; statusText?: string }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    statusText: init?.statusText,
  });
}

/** Flushes the microtask queue repeatedly so chained promise `.then()`s
 * (queue tail -> gap wait -> sleepImpl -> fetch) all get a chance to run,
 * without relying on fake/real timers. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('HttpClient', () => {
  it('scenario 1: adds the User-Agent header to every request', async () => {
    const fetchImpl = vi.fn(async () => textResponse('ok'));
    const client = new HttpClient({ minGapMs: 50, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.text('https://example.com/a');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('User-Agent')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
  });

  it('allows overriding the User-Agent header', async () => {
    const fetchImpl = vi.fn(async () => textResponse('ok'));
    const client = new HttpClient({
      minGapMs: 50,
      userAgent: 'custom-agent/1.0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.text('https://example.com/a');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('User-Agent')).toBe('custom-agent/1.0');
  });

  it('scenario 2: second request to the same host waits at least minGapMs', async () => {
    const fetchImpl = vi.fn(async () => textResponse('ok'));
    const client = new HttpClient({ minGapMs: 50, fetchImpl: fetchImpl as unknown as typeof fetch });

    const t0 = Date.now();
    await client.text('https://example.com/a');
    await client.text('https://example.com/b');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('scenario 3: requests to different hosts do not wait for each other', async () => {
    const fetchImpl = vi.fn(async () => textResponse('ok'));
    const client = new HttpClient({ minGapMs: 5000, fetchImpl: fetchImpl as unknown as typeof fetch });

    const t0 = Date.now();
    await client.text('https://example.com/a');
    await client.text('https://another-host.com/b');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000);
  });

  it('scenario 4: retries twice on 500 with injected backoff, then throws', async () => {
    const fetchImpl = vi.fn(async () => textResponse('server error', { status: 500, statusText: 'Internal Server Error' }));
    const sleepCalls: number[] = [];
    const sleepImpl = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
    const client = new HttpClient({
      minGapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.text('https://example.com/a')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // backoff waits for the 2 retries (rate-limit gap wait uses minGapMs:0, so
    // only the retry backoff sleeps should show up here, in increasing order)
    expect(sleepCalls).toEqual([500, 2000]);
  });

  it('scenario 4b: retries on network errors (fetch throws) then throws after exhausting retries', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network error');
    });
    const sleepImpl = vi.fn(async () => {});
    const client = new HttpClient({
      minGapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    await expect(client.text('https://example.com/a')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('scenario 4c: succeeds after a transient 500 followed by a 200', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return textResponse('error', { status: 500 });
      return textResponse('success');
    });
    const sleepImpl = vi.fn(async () => {});
    const client = new HttpClient({
      minGapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const result = await client.text('https://example.com/a');
    expect(result).toBe('success');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(500);
  });

  it('scenario 5: 403 throws SourceBlockedError immediately without retry', async () => {
    const fetchImpl = vi.fn(async () => textResponse('forbidden', { status: 403 }));
    const sleepImpl = vi.fn(async () => {});
    const client = new HttpClient({
      minGapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const err = await client.text('https://example.com/a').catch((e) => e);
    expect(err).toBeInstanceOf(SourceBlockedError);
    expect((err as SourceBlockedError).status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('scenario 5b: 429 throws SourceBlockedError immediately without retry', async () => {
    const fetchImpl = vi.fn(async () => textResponse('too many requests', { status: 429 }));
    const sleepImpl = vi.fn(async () => {});
    const client = new HttpClient({
      minGapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const err = await client.text('https://example.com/a').catch((e) => e);
    expect(err).toBeInstanceOf(SourceBlockedError);
    expect((err as SourceBlockedError).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('scenario 6: hostGapOverrides is respected via gapForHost(url)', () => {
    const client = new HttpClient({
      minGapMs: 3000,
      hostGapOverrides: { 'last-minute.zajezdy.cz': 5000 },
    });

    expect(client.gapForHost('https://last-minute.zajezdy.cz/deals')).toBe(5000);
    expect(client.gapForHost('https://other-host.cz/deals')).toBe(3000);
  });

  it('json() parses the response body as JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: 'world' }));
    const client = new HttpClient({ minGapMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });

    const data = await client.json<{ hello: string }>('https://example.com/a');
    expect(data).toEqual({ hello: 'world' });
  });

  it('defaults minGapMs to 3000 when not provided', () => {
    const client = new HttpClient();
    expect(client.gapForHost('https://example.com')).toBe(3000);
  });

  it('scenario 7: concurrent requests to the same host are fully serialized', async () => {
    // Deferred resolvers let us control exactly when each fetch call completes,
    // so we can assert ordering deterministically instead of racing timers.
    const deferred: Array<{ resolve: (r: Response) => void }> = [];
    const callOrder: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      callOrder.push(`fetch:${url}`);
      return new Promise<Response>((resolve) => {
        deferred.push({ resolve });
      });
    });
    const sleepCalls: number[] = [];
    const sleepImpl = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });

    const client = new HttpClient({
      minGapMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const p = Promise.all([
      client.text('https://example.com/a1'),
      client.text('https://example.com/a2'),
    ]);

    // Let microtasks flush. Only the first request's fetch should have been
    // invoked so far — the second must wait on the queue, not fire in parallel.
    await flushMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);

    // Resolve the first fetch; the second must still not have been invoked
    // until the gap sleep for the host has been requested and awaited.
    deferred[0]!.resolve(textResponse('first'));
    await flushMicrotasks();
    expect(sleepCalls).toContain(50);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    deferred[1]!.resolve(textResponse('second'));
    const [r1, r2] = await p;

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(callOrder).toEqual(['fetch:https://example.com/a1', 'fetch:https://example.com/a2']);
  });

  it('scenario 8: concurrent requests to different hosts do not gap-wait each other', async () => {
    const fetchImpl = vi.fn(async () => textResponse('ok'));
    const sleepImpl = vi.fn(async () => {});
    const client = new HttpClient({
      minGapMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const [r1, r2] = await Promise.all([
      client.text('https://host-a.example.com/a'),
      client.text('https://host-b.example.com/b'),
    ]);

    expect(r1).toBe('ok');
    expect(r2).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Neither host had a prior request, so no gap sleep should occur for either.
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('headers: merges a Headers instance with the default User-Agent', async () => {
    const fetchImpl = vi.fn(async () => textResponse('ok'));
    const client = new HttpClient({ minGapMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });

    const customHeaders = new Headers();
    customHeaders.set('X-Custom', 'custom-value');

    await client.text('https://example.com/a', { headers: customHeaders });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Custom')).toBe('custom-value');
    expect(headers.get('User-Agent')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
  });

  it('headers: merges a tuple-array headers input with the default User-Agent', async () => {
    const fetchImpl = vi.fn(async () => textResponse('ok'));
    const client = new HttpClient({ minGapMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.text('https://example.com/a', { headers: [['X-Custom', 'tuple-value']] });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Custom')).toBe('tuple-value');
    expect(headers.get('User-Agent')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
  });

  it('scenario 9: 404 throws immediately without retry', async () => {
    const fetchImpl = vi.fn(async () => textResponse('not found', { status: 404, statusText: 'Not Found' }));
    const sleepImpl = vi.fn(async () => {});
    const client = new HttpClient({
      minGapMs: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    });

    const err = await client.text('https://example.com/a').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SourceBlockedError);
    expect((err as Error).message).toContain('404');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });
});
