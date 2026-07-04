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
    await this.waitForHostGap(url);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            'User-Agent': this.userAgent,
          },
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

        return await response.text();
      } catch (err) {
        if (err instanceof SourceBlockedError) {
          throw err;
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

  async json<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const body = await this.text(url, init);
    return JSON.parse(body) as T;
  }

  private async waitForHostGap(url: string): Promise<void> {
    const host = new URL(url).host;
    const gap = this.gapForHost(url);
    const last = this.lastRequestAt.get(host);
    const now = Date.now();

    if (last !== undefined) {
      const elapsed = now - last;
      if (elapsed < gap) {
        await this.sleepImpl(gap - elapsed);
      }
    }

    this.lastRequestAt.set(host, Date.now());
  }
}
