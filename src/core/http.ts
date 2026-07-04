const DEFAULT_MIN_GAP_MS = 3000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const RETRY_BACKOFF_MS = [500, 2000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1; // 1 initial try + retries

export class SourceBlockedError extends Error {
  status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Blocked by source, status ${status}`);
    this.name = 'SourceBlockedError';
    this.status = status;
  }
}

/**
 * Internal marker for non-retryable HTTP error statuses (any `!response.ok`
 * that isn't handled by `SourceBlockedError` or the 5xx retry path, e.g.
 * 404/400). Thrown immediately with no retry; unwrapped back to a plain
 * `Error` before leaving `doFetchWithRetry` so callers see a normal Error.
 */
class NonRetryableHttpError extends Error {}

export interface HttpClientOptions {
  minGapMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  hostGapOverrides?: Record<string, number>;
  sleepImpl?: (ms: number) => Promise<void>;
}

export class HttpClient {
  private readonly minGapMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly hostGapOverrides: Record<string, number>;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly lastRequestAt = new Map<string, number>();
  private readonly hostQueues = new Map<string, Promise<void>>();

  constructor(opts: HttpClientOptions = {}) {
    this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.hostGapOverrides = opts.hostGapOverrides ?? {};
    this.sleepImpl = opts.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  gapForHost(url: string): number {
    const host = new URL(url).host;
    return this.hostGapOverrides[host] ?? this.minGapMs;
  }

  async text(url: string, init?: RequestInit): Promise<string> {
    return this.runOnHostQueue(url, () => this.doFetchWithRetry(url, init));
  }

  async json<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const body = await this.text(url, init);
    return JSON.parse(body) as T;
  }

  /**
   * Serializes all requests to the same host through a per-host promise
   * queue. Each request chains onto the host's tail promise: it waits for
   * the previous request (fetch included) to settle, then waits out the
   * politeness gap, then runs its own fetch. This guarantees no two
   * requests to the same host are ever in flight (or gap-waiting)
   * concurrently, while different hosts remain fully independent.
   *
   * The queue tail is a `.catch(() => {})`-guarded promise so a failed
   * request never poisons the chain for subsequent requests, and the map
   * entry is replaced (not appended to indefinitely) so memory stays O(1)
   * per host regardless of request count.
   */
  private runOnHostQueue<T>(url: string, task: () => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    const previousTail = this.hostQueues.get(host) ?? Promise.resolve();

    const result = previousTail.then(async () => {
      await this.waitForHostGap(host);
      try {
        return await task();
      } finally {
        // Recorded after the fetch completes (success or failure), so the
        // next request's gap wait is measured from when this one actually
        // finished, not from when it started.
        this.lastRequestAt.set(host, Date.now());
      }
    });

    // The next request should wait for this one to fully settle (success or
    // failure) before it starts its own gap wait. Swallow the error here so
    // the queue tail itself never rejects and past requests don't pile up
    // in memory — this replaces the map entry rather than chaining onto it.
    const nextTail = result.then(
      () => undefined,
      () => undefined,
    );
    this.hostQueues.set(host, nextTail);

    return result;
  }

  private async doFetchWithRetry(url: string, init?: RequestInit): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const headers = new Headers(init?.headers);
        if (!headers.has('user-agent')) {
          headers.set('User-Agent', this.userAgent);
        }

        const response = await this.fetchImpl(url, {
          ...init,
          headers,
        });

        if (response.status === 403 || response.status === 429) {
          throw new SourceBlockedError(response.status, `Request to ${url} blocked with status ${response.status}`);
        }

        if (response.status >= 500) {
          lastError = new Error(`Request to ${url} failed with status ${response.status} ${response.statusText}`);
          const backoff = RETRY_BACKOFF_MS[attempt];
          if (backoff !== undefined) {
            await this.sleepImpl(backoff);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          throw new NonRetryableHttpError(`HTTP ${response.status} for ${url}`);
        }

        return await response.text();
      } catch (err) {
        if (err instanceof SourceBlockedError) {
          throw err;
        }
        if (err instanceof NonRetryableHttpError) {
          throw new Error(err.message);
        }
        lastError = err;
        const backoff = RETRY_BACKOFF_MS[attempt];
        if (backoff !== undefined) {
          await this.sleepImpl(backoff);
          continue;
        }
        throw lastError;
      }
    }

    // Unreachable, but keeps TypeScript happy about the return type.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async waitForHostGap(host: string): Promise<void> {
    const gap = this.hostGapOverrides[host] ?? this.minGapMs;
    const last = this.lastRequestAt.get(host);
    const now = Date.now();

    if (last !== undefined) {
      const elapsed = now - last;
      if (elapsed < gap) {
        await this.sleepImpl(gap - elapsed);
      }
    }
  }
}
