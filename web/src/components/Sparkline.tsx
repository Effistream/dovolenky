/**
 * Inline-SVG price sparkline. Falling series → green line + green endpoint dot
 * (a price drop is the good signal); otherwise muted grey. Mirrors the mockup's
 * `.spark` / `.spark.down` markup exactly. Path maths live in lib/format so they
 * stay unit-tested and DOM-free.
 */
import { sparklinePath } from '../lib/format.js';

interface Props {
  prices: number[];
  width?: number;
  height?: number;
}

export function Sparkline({ prices, width = 64, height = 22 }: Props) {
  const path = sparklinePath(prices, width, height);
  if (!path) return null;

  const dotColor = path.falling ? 'var(--deal-board)' : 'var(--board-muted)';

  return (
    <svg
      className={`spark${path.falling ? ' down' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline points={path.points} />
      <circle cx={path.endX} cy={path.endY} r="2.2" style={{ color: dotColor }} />
    </svg>
  );
}
