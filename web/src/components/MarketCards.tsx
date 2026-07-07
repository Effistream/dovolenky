/**
 * The two quiet light cards below the board: TRH DNES (three market numbers from
 * /api/stats) and ZDROJE (a status grid from /api/sources). Dot tone follows
 * MASTER.md: green ok, amber partial or in-backoff ("v pauze"), red failed. Skrz
 * carries a "vč. Slevomatu" via-note. Times are the latest run's start.
 */
import { formatNumber } from '../lib/format.js';
import { pragueHhmm, sourceLabel } from '../lib/term.js';
import { sourceDotTone, sourceViaNote } from '../lib/history.js';
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
            const tone = sourceDotTone(s.status, s.backoff);
            const via = sourceViaNote(s.source, s.backoff);
            return (
              <div className="sourc" key={s.source}>
                <span className={DOT_CLASS[tone]} />
                {sourceLabel(s.source)}
                {via && <span className="via">{via}</span>}
                <time>{pragueHhmm(s.startedAt)}</time>
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
