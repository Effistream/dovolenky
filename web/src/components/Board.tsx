/**
 * The signature dark board: caption + count line, the mono caps header row, and
 * the rows themselves. Owns the loading skeleton, empty state and error state so
 * the panel chrome (rounded ink card) is always present. The expanded row opens
 * a detail slot rendered right after it — Task 27 fills that slot; for now it's a
 * labelled placeholder so the click affordance isn't dead.
 */
import { Fragment } from 'react';
import { BoardRow } from './BoardRow.js';
import type { Offer } from '../lib/types.js';

interface Props {
  offers: Offer[];
  loading: boolean;
  error: Error | null;
  expandedId: number | null;
  onToggle: (id: number) => void;
  onRetry: () => void;
  /** Optional detail renderer for the expanded row (Task 27). */
  renderDetail?: (offer: Offer) => React.ReactNode;
}

const HEADER = [
  'DESTINACE',
  'TERMÍN',
  'ODLET',
  'STRAVA',
  'CENA / OS.',
  '30 DNÍ',
  'REÁLNÁ',
  'UVÁDÍ',
  'ZDROJ',
];

function HeaderRow() {
  return (
    <div className="hrow" aria-hidden="true">
      {HEADER.map((h) => (
        <div key={h}>{h}</div>
      ))}
    </div>
  );
}

function SkeletonRows() {
  // Nine placeholder rows so the panel keeps its height while data loads.
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <div className="skel-row" key={i} aria-hidden="true">
          <div className="skel" style={{ width: '70%' }} />
          <div className="skel" style={{ width: '80%' }} />
          <div className="skel" style={{ width: '50%' }} />
          <div className="skel" style={{ width: '70%' }} />
          <div className="skel" style={{ width: '60%' }} />
          <div className="skel" style={{ width: '60%' }} />
          <div className="skel" style={{ width: '50%' }} />
          <div className="skel" style={{ width: '50%' }} />
          <div className="skel" style={{ width: '60%' }} />
        </div>
      ))}
    </>
  );
}

export function Board({
  offers,
  loading,
  error,
  expandedId,
  onToggle,
  onRetry,
  renderDetail,
}: Props) {
  const count = offers.length;

  return (
    <section className="board" aria-label="Odletová tabule s nabídkami">
      <div className="board-cap">
        <h2>ODLETOVÁ TABULE</h2>
        <span className="count">
          SEŘAZENO PODLE REÁLNÉ SLEVY · {count} NABÍDEK
        </span>
      </div>

      <div className="board-scroll">
        <div className="board-table">
          <HeaderRow />

          {loading && <SkeletonRows />}

          {!loading && error && (
            <div className="board-state" role="alert">
              Data se nenačetla. Zkontroluj, že terminál běží.
              <br />
              <button className="retry" onClick={onRetry} type="button">
                Zkusit znovu
              </button>
            </div>
          )}

          {!loading && !error && count === 0 && (
            <div className="board-state">
              Nic tu není. Povol více zemí, nebo sniž práh slevy.
            </div>
          )}

          {!loading &&
            !error &&
            offers.map((offer) => (
              <Fragment key={offer.id}>
                <BoardRow
                  offer={offer}
                  expanded={expandedId === offer.id}
                  onToggle={onToggle}
                />
                {expandedId === offer.id && (
                  <div className="detail">
                    {renderDetail ? (
                      renderDetail(offer)
                    ) : (
                      <p className="detail-placeholder">
                        CENOVÝ GRAF A VERDIKT · DOPLNÍ TASK 27
                      </p>
                    )}
                  </div>
                )}
              </Fragment>
            ))}
        </div>
      </div>
    </section>
  );
}
