/**
 * The mono status strip: last scan time, sources OK/total, and a digest slot.
 * Scan time = the newest source_run start across all sources. OK count = sources
 * whose latest run status is 'ok' and that aren't in backoff. The digest time is
 * not exposed by the API (no field in /api/stats), so per the brief it renders
 * "—" rather than a fabricated value.
 */
import type { SourceStatus } from '../lib/types.js';

interface Props {
  sources: SourceStatus[] | null;
  loading: boolean;
}

/** "2026-07-04T14:05:00Z" → "14:05" (UTC clock, matching the mockup's HH:MM). */
function hhmm(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(
    d.getUTCMinutes(),
  ).padStart(2, '0')}`;
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
  return hhmm(iso);
}

export function StatusLine({ sources, loading }: Props) {
  const total = sources?.length ?? 0;
  const okCount =
    sources?.filter((s) => s.status === 'ok' && !s.backoff).length ?? 0;
  const scan = sources && sources.length > 0 ? latestScan(sources) : '—';
  const someBackoff = sources?.some((s) => s.backoff) ?? false;

  return (
    <div className="status">
      <span className="ok">
        <span className={`dot${someBackoff ? ' warn' : ''}`} />
        SCAN {loading ? '…' : scan}
      </span>
      <span>ZDROJE {loading ? '…' : `${okCount}/${total}`}</span>
      <span>DIGEST —</span>
    </div>
  );
}
