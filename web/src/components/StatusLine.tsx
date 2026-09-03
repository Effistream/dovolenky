/**
 * The mono status strip: last scan time, sources OK/total, and a digest slot.
 * Scan time = the newest source_run start across all sources (the latest ATTEMPT,
 * so a running scanner shows up even when it fails). OK count = sources whose
 * history.ts#sourceHealth tone is 'ok' (fresh data, latest attempt ok, not in
 * backoff); the dot warns when any source is in backoff or red. The digest time
 * is not exposed by the API (no field in /api/stats), so per the brief it renders
 * "—" rather than a fabricated value.
 */
import { sourceHealth } from '../lib/history.js';
import { pragueHhmm } from '../lib/term.js';
import type { SourceStatus } from '../lib/types.js';

interface Props {
  sources: SourceStatus[] | null;
  loading: boolean;
}

function latestScan(sources: SourceStatus[]): string {
  let newest = -Infinity;
  let iso: string | null = null;
  for (const s of sources) {
    const t = new Date(s.startedAt).getTime();
    if (Number.isFinite(t) && t > newest) {
      newest = t;
      iso = s.startedAt;
    }
  }
  return pragueHhmm(iso);
}

export function StatusLine({ sources, loading }: Props) {
  const total = sources?.length ?? 0;
  const nowMs = Date.now();
  const tones = (sources ?? []).map((s) => sourceHealth(s, nowMs).tone);
  const okCount = tones.filter((t) => t === 'ok').length;
  const scan = sources && sources.length > 0 ? latestScan(sources) : '—';
  const warn = (sources?.some((s) => s.backoff) ?? false) || tones.includes('failed');

  return (
    <div className="status">
      <span className="ok">
        <span className={`dot${warn ? ' warn' : ''}`} />
        SCAN {loading ? '…' : scan}
      </span>
      <span>ZDROJE {loading ? '…' : `${okCount}/${total}`}</span>
      <span>DIGEST —</span>
    </div>
  );
}
