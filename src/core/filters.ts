import type { Profile } from './config.js';
import { dayDiff, pragueDayString } from './dates.js';
import { normalizeCountry } from './normalize.js';
import type { NormalizedOffer } from './types.js';

function matchesCountry(offer: NormalizedOffer, profile: Profile): boolean {
  if (profile.countries.length === 0) return true;
  const offerCountry = normalizeCountry(offer.country);
  if (!offerCountry) return false;
  const normalizedProfileCountries = profile.countries.map((c) => normalizeCountry(c));
  return normalizedProfileCountries.includes(offerCountry);
}

function matchesBoard(offer: NormalizedOffer, profile: Profile): boolean {
  if (profile.board.length === 0) return true;
  return profile.board.includes(offer.board);
}

function matchesTransport(offer: NormalizedOffer, profile: Profile): boolean {
  if (profile.transport === undefined) return true;
  return offer.transport === profile.transport;
}

function matchesDepartureMonth(offer: NormalizedOffer, profile: Profile): boolean {
  if (profile.departureMonths.length === 0) return true;
  if (!offer.departureDate) return false;
  const month = Number(offer.departureDate.slice(5, 7));
  return profile.departureMonths.includes(month);
}

function matchesDepartureWithinDays(offer: NormalizedOffer, profile: Profile, now: Date): boolean {
  if (profile.departureWithinDays === null) return true;
  if (!offer.departureDate) return false;
  const diff = dayDiff(pragueDayString(now), offer.departureDate);
  return diff >= 0 && diff <= profile.departureWithinDays;
}

function matchesMaxPrice(offer: NormalizedOffer, profile: Profile): boolean {
  if (profile.maxPricePerPerson === null) return true;
  return offer.pricePerPerson <= profile.maxPricePerPerson;
}

export function matchProfiles(
  offer: NormalizedOffer,
  profiles: Record<string, Profile>,
  now: Date = new Date(),
): { name: string; profile: Profile }[] {
  const result: { name: string; profile: Profile }[] = [];

  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile.enabled) continue;
    if (!matchesCountry(offer, profile)) continue;
    if (!matchesBoard(offer, profile)) continue;
    if (!matchesTransport(offer, profile)) continue;
    if (!matchesDepartureMonth(offer, profile)) continue;
    if (!matchesDepartureWithinDays(offer, profile, now)) continue;
    if (!matchesMaxPrice(offer, profile)) continue;

    result.push({ name, profile });
  }

  return result;
}
