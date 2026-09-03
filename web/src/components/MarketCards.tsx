/**
 * The two quiet light cards below the board: TRH DNES (three market numbers from
 * /api/stats) and ZDROJE (a status grid from /api/sources). Dot tone and via-note
 * come from history.ts#sourceHealth — judged by the age of the last usable data,
 * not by the latest attempt (MASTER.md: green ok, amber partial/backoff/aging,
 * red failed). The time is when data last arrived ("—" when never); the latest
 * attempt (time · status · error) sits in the row's hover title.
 */
import { formatNumber } from '../lib/format.js';
import { pragueHhmm, sourceLabel } from '../lib/term.js';
import { sourceAttemptTitle, sourceHealth } from '../lib/history.js';
import type { SourceStatus, StatsResponse } from '../lib/types.js';

/** Dot tone → the CSS modifier: ok green (base), partial amber, failed red. */
const DOT_CLASS: Record<string, string> = {
  ok: 'dot',
  partial: 'dot partial',
  failed: 'dot warn',
};

interface Props {
  stats: StatsResponse | null;
  sources: SourceStatus[] | null;
}

/** The median for the "léto u moře" set, the headline market number. */
function letoMedian(stats: StatsResponse | null): number | null {
  if (!stats) return null;
  return stats.medianByProfile['leto-more'] ?? null;
}

export function MarketCards({ stats, sources }: Props) {
  const median = letoMedian(stats);
  const nowMs = Date.now();

  return (
    <div className="cards">
      <section className="card" aria-label="Stav trhu">
        <h3>TRH DNES</h3>
        <div className="market">
          <div className="m">
            <div className="num">{stats ? formatNumber(stats.activeCount) : '—'}</div>
            <div className="lbl">aktivních nabídek</div>
          </div>
          <div className="m">
            <div className="num">{stats ? formatNumber(stats.new24h) : '—'}</div>
            <div className="lbl">nových za 24 h</div>
          </div>
          <div className="m">
            <div className="num">{median != null ? formatNumber(median) : '—'}</div>
            <div className="lbl">medián léto u moře, Kč/os.</div>
          </div>
        </div>
      </section>

      <section className="card" aria-label="Stav zdrojů">
        <h3>ZDROJE</h3>
        <div className="sources">
          {(sources ?? []).map((s) => {
            const { tone, note } = sourceHealth(s, nowMs);
            return (
              <div className="sourc" key={s.source} title={sourceAttemptTitle(s)}>
                <span className={DOT_CLASS[tone]} />
                {sourceLabel(s.source)}
                {note && <span className="via">{note}</span>}
                <time>{pragueHhmm(s.lastOkAt)}</time>
              </div>
            );
          })}
          {(!sources || sources.length === 0) && (
            <div className="sourc">
              <span className="via">zatím žádné běhy zdrojů</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
