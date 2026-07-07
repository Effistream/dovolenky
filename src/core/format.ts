import type { NormalizedOffer } from './types.js';
import type { DiscountResult } from './discount.js';

const DIGEST_LIMIT = 10;

/**
 * Telegram caps `sendMessage` text at 4096 chars. We stop appending digest
 * items once the message would cross this safety margin, leaving headroom
 * for the stats footer and the "… a dalších N nabídek" overflow line that
 * follows.
 */
const DIGEST_MAX_CHARS = 3800;

const KIND_EMOJI: Record<'hot_deal' | 'price_drop' | 'new_offer', string> = {
  hot_deal: '🔥',
  price_drop: '📉',
  new_offer: '🆕',
};

/**
 * Reference-tier label (spec §15): own/omnibus are static phrases; hotel is a
 * fixed phrase too ("tento hotel" — the subject *is* the hotel, no further
 * detail needed); locality/market interpolate the offer's own locality/country
 * so the label names the actual comparison bucket ("Kréta", "Řecko") rather
 * than a generic "medián lokality/trhu". Falls back to the generic noun when
 * the offer lacks that field (should be rare — the bucket query itself
 * requires a non-null locality/country to populate, but we stay defensive).
 */
function referenceLabel(reference: NonNullable<DiscountResult['reference']>, offer: NormalizedOffer): string {
  switch (reference) {
    case 'own':
      return '30denní medián';
    case 'omnibus':
      return 'Omnibus 30denní min.';
    case 'hotel':
      return 'tento hotel';
    case 'locality':
      return offer.locality ?? 'lokalita';
    case 'market':
      return offer.country ?? 'trh';
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a CZK amount as e.g. "12 990 Kč". `toLocaleString('cs-CZ')` inserts
 * a non-breaking space (U+00A0) as the thousands separator; we replace it
 * with a regular space so the output is consistent (and simple to assert on
 * in tests / diffs) across environments, since Telegram renders both the
 * same visually.
 */
function formatCzk(amount: number): string {
  return `${amount.toLocaleString('cs-CZ').replace(/ /g, ' ')} Kč`;
}

function formatPricePerPerson(amount: number): string {
  return `${formatCzk(amount)}/os.`;
}

function starsLine(stars: number | null): string {
  return stars != null && stars > 0 ? ` ${'★'.repeat(stars)}` : '';
}

function locationLine(offer: NormalizedOffer): string {
  const parts = [offer.country, offer.locality].filter((p): p is string => !!p).map(escapeHtml);
  return parts.length > 0 ? ` — ${parts.join(', ')}` : '';
}

/**
 * `DiscountResult.realPct` is positive when the price is genuinely cheaper
 * than the baseline (e.g. 22 means 22 % below baseline) and negative when
 * the price actually rose. We always render it with an explicit sign using
 * the typographic minus '−' (U+2212, matching the rest of the message,
 * e.g. "uvádí slevu −45 %") rather than JS's ASCII hyphen-minus.
 */
function signedPct(pct: number): string {
  return pct >= 0 ? `−${pct} %` : `+${Math.abs(pct)} %`;
}

function realDiscountLine(d: DiscountResult, offer: NormalizedOffer): string {
  if (d.realPct == null || d.reference == null || d.baseline == null) {
    return '📊 reálná sleva: sbírám historii';
  }
  const label = referenceLabel(d.reference, offer);
  const line = `📊 Reálná sleva ${signedPct(d.realPct)} vs. ${label} ${formatCzk(d.baseline)}`;
  return d.fake ? `${line} ⚠️ nadsazená sleva` : line;
}

function priceLine(kind: 'hot_deal' | 'price_drop' | 'new_offer', offer: NormalizedOffer, extra?: { previousPrice?: number }): string {
  const base = `💰 ${formatPricePerPerson(offer.pricePerPerson)}`;
  const claimed = offer.claimedDiscountPct != null ? ` (uvádí slevu −${offer.claimedDiscountPct} %)` : '';
  const line = `${base}${claimed}`;
  if (kind === 'price_drop' && extra?.previousPrice != null) {
    return `${line}\n↓ z ${formatCzk(extra.previousPrice)}`;
  }
  return line;
}

/**
 * Converts an ISO `YYYY-MM-DD` date to Czech `DD.MM.YYYY` display format.
 * If the input doesn't match the expected shape, it's returned unchanged
 * rather than throwing (defensive against unexpected upstream data).
 */
function formatCzechDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

function detailsLine(offer: NormalizedOffer): string {
  const parts: string[] = [];
  if (offer.departureDate && offer.nights != null) {
    parts.push(`🗓 ${formatCzechDate(offer.departureDate)} (${offer.nights} nocí)`);
  } else if (offer.departureDate) {
    parts.push(`🗓 ${formatCzechDate(offer.departureDate)}`);
  }
  if (offer.departureAirport) {
    parts.push(`✈️ ${escapeHtml(offer.departureAirport)}`);
  }
  if (offer.board !== 'unknown') {
    parts.push(BOARD_LABEL[offer.board]);
  }
  return parts.join(' · ');
}

const BOARD_LABEL: Record<NormalizedOffer['board'], string> = {
  AI: 'All inclusive',
  FB: 'Plná penze',
  HB: 'Polopenze',
  BB: 'Snídaně',
  none: 'Bez stravy',
  unknown: '',
};

function linkLine(offer: NormalizedOffer): string {
  const source = offer.tourOperator ?? offer.source;
  return `🔗 <a href="${escapeHtml(offer.url)}">odkaz</a> · zdroj: ${escapeHtml(source)}`;
}

/**
 * Cross-source alternatives line (spec §13): when the same physical tour was
 * found at other sources, list them after the representative's price line as
 * `Také: <Source> <price> Kč · <Source2> <price2> Kč`. Source names are shown
 * as stored (only the first letter upper-cased, since sources are stored as
 * bare lowercase slugs like `invia`); every interpolated value is HTML-escaped.
 */
function alternativesLine(alternatives: { source: string; pricePerPerson: number }[]): string {
  const parts = alternatives.map((a) => `${escapeHtml(capitalize(a.source))} ${formatCzk(a.pricePerPerson)}`);
  return `Také: ${parts.join(' · ')}`;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function formatOffer(
  kind: 'hot_deal' | 'price_drop' | 'new_offer',
  offer: NormalizedOffer,
  d: DiscountResult,
  extra?: { previousPrice?: number; alternatives?: { source: string; pricePerPerson: number; url: string }[] },
): string {
  const emoji = KIND_EMOJI[kind];
  const title = `${emoji} ${escapeHtml(offer.title)}${starsLine(offer.stars)}${locationLine(offer)}`;
  const lines = [title];

  const details = detailsLine(offer);
  if (details) lines.push(details);

  lines.push(priceLine(kind, offer, extra));
  if (extra?.alternatives && extra.alternatives.length > 0) {
    lines.push(alternativesLine(extra.alternatives));
  }
  lines.push(realDiscountLine(d, offer));
  lines.push(linkLine(offer));

  return lines.join('\n');
}

export function formatDigest(
  items: { offer: NormalizedOffer; d: DiscountResult }[],
  stats: { activeOffers: number; newLast24h: number },
): string {
  const top = items.slice(0, DIGEST_LIMIT);

  const header = ['☀️ Denní přehled nabídek', ''];
  const footer = ['', `📊 Aktivních nabídek: ${stats.activeOffers} · Nových za 24 h: ${stats.newLast24h}`];

  const itemLines: string[] = [];
  let rendered = 0;

  for (const { offer, d } of top) {
    const stars = starsLine(offer.stars);
    const pct = d.realPct != null ? signedPct(d.realPct) : 'sbírám historii';
    const line = `• ${escapeHtml(offer.title)}${stars} — ${formatPricePerPerson(offer.pricePerPerson)} (reálná sleva ${pct}) · <a href="${escapeHtml(offer.url)}">odkaz</a>`;

    const candidateLength = [...header, ...itemLines, line, ...footer].join('\n').length;
    if (candidateLength > DIGEST_MAX_CHARS) {
      break;
    }

    itemLines.push(line);
    rendered += 1;
  }

  const notRendered = items.length - rendered;
  const lines = [...header, ...itemLines];
  if (notRendered > 0) {
    lines.push(`… a dalších ${notRendered} nabídek`);
  }
  lines.push(...footer);

  return lines.join('\n');
}
