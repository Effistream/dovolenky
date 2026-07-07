/**
 * The expanded-row detail (Task 27), rendered into the board's `renderDetail`
 * slot. On expand it fetches /api/offers/:id/history (cached per id in a
 * module-level Map so re-opening a row is instant), then draws — 1:1 with
 * docs/design/terminal-mockup.html:
 *   - a chart-cap label + SVG price chart (white polyline, amber median band,
 *     red dashed claimed-original line, green DNES endpoint dot, axis dates),
 *   - a facts kv block (SLEDUJI · MEDIÁN 30 DNÍ · poslední pohyb),
 *   - a verdict sentence built from real discount data (MASTER.md copy rules),
 *   - a single primary CTA "Otevřít u <Zdroj>" (+ "Také u:" alternatives).
 * No "Ztlumit" — v1 is read-only (spec §14). Chart maths and copy live in
 * lib/history.ts so they stay unit-tested and DOM-free.
 */
import { useEffect, useState } from 'react';
import { fetchHistory } from '../lib/api.js';
import {
  buildChart,
  buildFacts,
  buildVerdict,
  sourceDisplayName,
} from '../lib/history.js';
import { formatCzk } from '../lib/format.js';
import { sourceLabel } from '../lib/term.js';
import type { HistoryResponse, Offer } from '../lib/types.js';

interface Props {
  offer: Offer;
}

// Per-id history cache, module-scoped so it survives collapse/expand and row
// re-renders (a plain object keyed by offer id). Cleared only on full reload.
const historyCache = new Map<number, HistoryResponse>();

// The chart viewBox matches the mockup (560×190). The SVG scales to 100% width.
const CHART_VB = { width: 560, height: 190 };

export function OfferDetail({ offer }: Props) {
  const [data, setData] = useState<HistoryResponse | null>(
    () => historyCache.get(offer.id) ?? null,
  );
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !historyCache.has(offer.id));

  useEffect(() => {
    const cached = historyCache.get(offer.id);
    if (cached) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchHistory(offer.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        historyCache.set(offer.id, result);
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => controller.abort();
  }, [offer.id]);

  if (loading) {
    return <p className="chart-cap">Načítám cenovou historii…</p>;
  }

  if (error || !data) {
    return (
      <p className="chart-cap" role="alert">
        Historie se nenačetla. Zkus řádek zavřít a otevřít znovu.
      </p>
    );
  }

  return <DetailBody offer={offer} history={data} />;
}

function DetailBody({ offer, history }: { offer: Offer; history: HistoryResponse }) {
  const chart = buildChart(CHART_VB, history);
  const facts = buildFacts(history);
  const verdict = buildVerdict(offer, history);
  const openLabel = `Otevřít u ${sourceDisplayName(offer.source)}`;

  return (
    <>
      <div className="chart">
        <p className="chart-cap">CENA ZA OSOBU · POSLEDNÍCH 30 DNÍ</p>
        {chart ? (
          <ChartSvg chart={chart} />
        ) : (
          <p className="chart-empty">zatím málo dat na graf</p>
        )}
      </div>

      <div className="facts">
        <div className="kv">
          {facts.tracked}
          <br />
          {facts.median}
          <br />
          {facts.lastMove}
        </div>

        <p className="verdict">{verdict}</p>

        <div className="actions">
          <a
            className="btn btn-primary"
            href={offer.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {openLabel}
          </a>
        </div>

        {offer.alternatives.length > 0 && (
          <p className="alts">
            Také u:{' '}
            {offer.alternatives.map((a, i) => (
              <span key={`${a.source}-${i}`}>
                {i > 0 ? ' · ' : ''}
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {sourceLabel(a.source)} {formatCzk(a.pricePerPerson)}
                </a>
              </span>
            ))}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The price chart, built from the pure ChartModel. Colours are inline hex
 * matching the mockup (the chart lives on the ink-2 detail panel; the semantic
 * board tokens are the same values). The polyline is the white price curve; the
 * amber rect is the median band; the red dashed line is the claimed "original";
 * the green dot is DNES.
 */
function ChartSvg({ chart }: { chart: NonNullable<ReturnType<typeof buildChart>> }) {
  const { width, height } = CHART_VB;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Graf ceny za osobu za posledních 30 dní. ${chart.dot.label}.`}
    >
      {chart.claimedLine && (
        <>
          <line
            x1="0"
            y1={chart.claimedLine.y}
            x2={width}
            y2={chart.claimedLine.y}
            stroke="var(--warn-board)"
            strokeWidth="1"
            strokeDasharray="5 4"
            opacity="0.75"
          />
          <text
            x="4"
            y={Math.max(10, chart.claimedLine.y - 8)}
            className="chart-lbl"
            fill="var(--warn-board)"
          >
            {chart.claimedLine.label}
          </text>
        </>
      )}

      {chart.band && (
        <>
          <rect
            x="0"
            y={chart.band.y}
            width={width}
            height={chart.band.height}
            fill="var(--amber)"
            opacity="0.10"
          />
          <text
            x="4"
            y={Math.max(10, chart.band.y - 4)}
            className="chart-lbl"
            fill="var(--board-muted)"
          >
            {chart.band.label}
          </text>
        </>
      )}

      <line
        x1="0"
        y1={chart.baselineY}
        x2={width}
        y2={chart.baselineY}
        stroke="var(--ink-3)"
        strokeWidth="1"
      />

      <polyline
        fill="none"
        stroke="var(--board-txt)"
        strokeWidth="2"
        points={chart.polylinePoints}
      />

      <circle cx={chart.dot.x} cy={chart.dot.y} r="4" fill="var(--deal-board)" />
      <text
        x={Math.min(width - 4, Math.max(4, chart.dot.x - 84))}
        y={Math.min(height - 22, chart.dot.y + 20)}
        className="chart-lbl chart-lbl--dnes"
        fill="var(--deal-board)"
      >
        {chart.dot.label}
      </text>

      <text x="4" y={height - 6} className="chart-axis" fill="var(--txt-muted)">
        {chart.axis.first}
      </text>
      <text
        x={width - 4}
        y={height - 6}
        className="chart-axis"
        textAnchor="end"
        fill="var(--txt-muted)"
      >
        {chart.axis.last}
      </text>
    </svg>
  );
}
