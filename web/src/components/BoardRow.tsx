/**
 * One board row = the cheapest representative of a match-key group. Grid columns
 * are 1:1 with the mockup: DESTINACE / TERMÍN / ODLET / STRAVA / CENA·OS. /
 * 30 DNÍ / REÁLNÁ / UVÁDÍ / ZDROJ. Clicking toggles an expand slot (Task 27
 * fills the detail); the row itself is the accessible <button> from the mockup.
 */
import { Sparkline } from './Sparkline.js';
import {
  discountTone,
  formatCzk,
  formatDiscount,
  formatNumber,
} from '../lib/format.js';
import {
  boardLabel,
  departureLabel,
  formatTermRange,
  nightsLabel,
  sourceLabel,
} from '../lib/term.js';
import type { Offer } from '../lib/types.js';

interface Props {
  offer: Offer;
  expanded: boolean;
  onToggle: (id: number) => void;
}

const STARS = '★★★★★';

/** REÁLNÁ cell: figure + reference line, coloured by tone (MASTER.md rules). */
function RealCell({ offer }: { offer: Offer }) {
  const tone = discountTone(offer.realPct);

  if (tone === 'none') {
    // No reference yet — we're still collecting history for this offer.
    return (
      <div className="real none real-cell">
        SBÍRÁM HISTORII
        <span className="ref">sbírám ~14 dní historie</span>
      </div>
    );
  }

  const ref =
    offer.baseline != null ? (
      tone === 'up' ? (
        <span className="ref">zdražuje · medián {formatNumber(offer.baseline)}</span>
      ) : (
        <span className="ref">vs. medián {formatNumber(offer.baseline)}</span>
      )
    ) : null;

  return (
    <div className={`real ${tone} real-cell`}>
      {formatDiscount(offer.realPct)}
      {ref}
    </div>
  );
}

/** UVÁDÍ cell: the seller's claimed discount + a NADSAZENÁ flag when fake. */
function ClaimsCell({ offer }: { offer: Offer }) {
  const claimed =
    offer.claimedDiscountPct != null ? `−${offer.claimedDiscountPct} %` : '—';
  return (
    <div className="claims mono">
      {claimed}
      {offer.fake && (
        <span className="flag">
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M6 1 L11 10 H1 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
          NADSAZENÁ
        </span>
      )}
    </div>
  );
}

/** ZDROJ cell: source caps + a "Také: …" via-line listing cheaper alternatives. */
function SourceCell({ offer }: { offer: Offer }) {
  const via =
    offer.alternatives.length > 0
      ? `Také: ${offer.alternatives
          .map((a) => `${sourceLabel(a.source)} ${formatCzk(a.pricePerPerson)}`)
          .join(' · ')}`
      : null;
  return (
    <div className="src">
      {sourceLabel(offer.source)}
      {via && <span className="via">{via}</span>}
    </div>
  );
}

function DestinationCell({ offer }: { offer: Offer }) {
  const city = (offer.locality || offer.country || offer.title).toUpperCase();
  const stars = offer.stars != null ? STARS.slice(0, offer.stars) : '';
  return (
    <div className="dest">
      <span className="city">{city}</span>
      <div className="hotel">
        {offer.title}
        {stars && <span className="stars"> {stars}</span>}
      </div>
    </div>
  );
}

export function BoardRow({ offer, expanded, onToggle }: Props) {
  return (
    <button
      className="row"
      aria-expanded={expanded}
      onClick={() => onToggle(offer.id)}
    >
      <DestinationCell offer={offer} />

      <div className="term cell-sm mono">
        {formatTermRange(offer.departureDate, offer.nights)}
        <span className="nights">{nightsLabel(offer.nights)}</span>
      </div>

      <div className="cell-dim mono odlet-cell">
        {departureLabel(offer.departureAirport, offer.transport)}
      </div>

      <div className="cell-sm strava-cell">{boardLabel(offer.board)}</div>

      <div className="price price-cell">
        {formatCzk(offer.pricePerPerson)}
        <span className="per">za osobu</span>
      </div>

      <div className="spark-cell">
        <Sparkline prices={offer.sparkline} />
      </div>

      <RealCell offer={offer} />
      <ClaimsCell offer={offer} />
      <SourceCell offer={offer} />
    </button>
  );
}
