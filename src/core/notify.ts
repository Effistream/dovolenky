import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { notificationsLog } from './db/schema.js';
import type { Profile, NotifCfg } from './config.js';
import type { DiscountResult } from './discount.js';
import type { NormalizedOffer } from './types.js';

export type NotificationType = 'hot_deal' | 'price_drop' | 'new_offer';

export interface Candidate {
  offerId: number;
  offer: NormalizedOffer;
  discount: DiscountResult;
  type: NotificationType;
  profile: string;
  previousPrice: number | null;
}

export interface EvaluateOfferInput {
  offerId: number;
  offer: NormalizedOffer;
  isNew: boolean;
  previousPrice: number | null;
  discount: DiscountResult;
  matches: { name: string; profile: Profile }[];
  cfg: NotifCfg;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Among the profiles satisfying `passes`, return the name of the "strongest"
// one — the profile with the highest minRealDiscountPct that still passes.
// This is the most demanding profile the offer still clears, used uniformly
// across all notification types so at most one entry per type is emitted.
function strongestMatch(
  matches: { name: string; profile: Profile }[],
  passes: (profile: Profile) => boolean,
): string | null {
  let best: { name: string; profile: Profile } | null = null;
  for (const m of matches) {
    if (!passes(m.profile)) continue;
    if (best === null || m.profile.minRealDiscountPct > best.profile.minRealDiscountPct) {
      best = m;
    }
  }
  return best ? best.name : null;
}

export function evaluateOffer(input: EvaluateOfferInput): { type: NotificationType; profile: string }[] {
  const { offer, isNew, previousPrice, discount, matches, cfg } = input;
  const result: { type: NotificationType; profile: string }[] = [];

  // hot_deal: realPct known and >= the matched profile's threshold.
  if (discount.realPct != null) {
    const realPct = discount.realPct;
    const profileName = strongestMatch(matches, (p) => realPct >= p.minRealDiscountPct);
    if (profileName !== null) {
      result.push({ type: 'hot_deal', profile: profileName });
    }
  }

  // price_drop: previousPrice known and the drop meets cfg.priceDropPct.
  if (previousPrice != null && previousPrice > 0) {
    const dropPct = ((previousPrice - offer.pricePerPerson) / previousPrice) * 100;
    if (dropPct >= cfg.priceDropPct) {
      const profileName = strongestMatch(matches, () => true);
      if (profileName !== null) {
        result.push({ type: 'price_drop', profile: profileName });
      }
    }
  }

  // new_offer: only for newly discovered offers, gated per profile.
  if (isNew) {
    const profileName = strongestMatch(matches, (p) => p.notifyNewOffers);
    if (profileName !== null) {
      result.push({ type: 'new_offer', profile: profileName });
    }
  }

  return result;
}

async function latestLogRow(db: Db, offerId: number, type: NotificationType) {
  const [row] = await db
    .select()
    .from(notificationsLog)
    .where(and(eq(notificationsLog.offerId, offerId), eq(notificationsLog.type, type)))
    .orderBy(desc(notificationsLog.id))
    .limit(1);
  return row ?? null;
}

async function shouldSend(db: Db, candidate: Candidate, cfg: NotifCfg, now: Date): Promise<boolean> {
  const prior = await latestLogRow(db, candidate.offerId, candidate.type);
  if (!prior) return true;

  if (candidate.type === 'new_offer') {
    // new_offer is sent at most once per offer, ever.
    return false;
  }

  // hot_deal / price_drop: re-send only if price dropped enough since the
  // last send, or enough time has elapsed since the last send.
  const priceAtSend = prior.priceAtSend;
  const priceDroppedEnough =
    priceAtSend != null && priceAtSend > 0
      ? candidate.offer.pricePerPerson <= priceAtSend * (1 - cfg.renotifyDropPct / 100)
      : false;

  const sentAtMs = new Date(prior.sentAt).getTime();
  const daysElapsed = (now.getTime() - sentAtMs) / DAY_MS;
  const enoughTimeElapsed = daysElapsed >= cfg.renotifyAfterDays;

  return priceDroppedEnough || enoughTimeElapsed;
}

export async function filterAgainstLog(
  db: Db,
  candidates: Candidate[],
  cfg: NotifCfg,
  now: Date = new Date(),
): Promise<Candidate[]> {
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    if (await shouldSend(db, candidate, cfg, now)) {
      result.push(candidate);
    }
  }
  return result;
}

export async function recordSent(db: Db, c: Candidate, now: Date = new Date()): Promise<void> {
  await db.insert(notificationsLog).values({
    offerId: c.offerId,
    type: c.type,
    sentAt: now.toISOString(),
    priceAtSend: c.offer.pricePerPerson,
  });
}

export function capMessages(cands: Candidate[], max: number): { send: Candidate[]; overflow: number } {
  const sorted = [...cands].sort((a, b) => {
    const aPct = a.discount.realPct;
    const bPct = b.discount.realPct;
    if (aPct == null && bPct == null) return 0;
    if (aPct == null) return 1;
    if (bPct == null) return -1;
    return bPct - aPct;
  });

  const send = sorted.slice(0, max);
  const overflow = Math.max(0, sorted.length - max);
  return { send, overflow };
}
