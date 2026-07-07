/**
 * Thin fetch wrappers around the /api endpoints plus a small React hook that
 * exposes {data, error, loading, reload}. The dev server proxies /api → :4141
 * (vite.config.ts); in production the Hono server serves this bundle and the API
 * from the same origin, so relative paths work in both.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  HistoryResponse,
  OffersResponse,
  SourcesResponse,
  StatsResponse,
} from './types.js';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export function fetchOffers(
  params: { profile?: string; minRealPct?: number },
  signal?: AbortSignal,
): Promise<OffersResponse> {
  const q = new URLSearchParams();
  if (params.profile) q.set('profile', params.profile);
  if (params.minRealPct != null) q.set('minRealPct', String(params.minRealPct));
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return getJson<OffersResponse>(`/api/offers${suffix}`, signal);
}

export function fetchSources(signal?: AbortSignal): Promise<SourcesResponse> {
  return getJson<SourcesResponse>('/api/sources', signal);
}

export function fetchStats(signal?: AbortSignal): Promise<StatsResponse> {
  return getJson<StatsResponse>('/api/stats', signal);
}

export function fetchHistory(
  id: number,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  return getJson<HistoryResponse>(`/api/offers/${id}/history`, signal);
}

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `fetcher` on mount and whenever `deps` change (or `reload()` is called),
 * aborting the in-flight request on cleanup so a fast filter change can't land a
 * stale response. An AbortError from that cleanup is swallowed — it is expected.
 */
export function useAsync<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetcher(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
