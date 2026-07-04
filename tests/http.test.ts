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
});
