import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { matchProfiles } from '../src/core/filters.js';
import type { NormalizedOffer } from '../src/core/types.js';

const WATCH_YAML = `
profiles:
  leto-more:
    enabled: true
    countries: [Řecko, Turecko, Egypt, Španělsko, Kypr, Bulharsko, Chorvatsko, Itálie]
    transport: flight
    board: [AI]
    departure_months: [6, 7, 8, 9]
    max_price_per_person: 25000
    min_real_discount_pct: 15
    notify_new_offers: false
  last-minute:
    enabled: true
    countries: []
    departure_within_days: 14
    min_real_discount_pct: 25
    max_price_per_person: 20000
    notify_new_offers: true
  exotika:
    enabled: true
    countries: [Thajsko, Maledivy, Mauricius, Spojené arabské emiráty,
                Dominikánská republika, Mexiko, Kuba, Seychely, Srí Lanka,
                Zanzibar, Tanzanie, Vietnam, Indonésie, Kapverdy, Keňa,
                Filipíny, Réunion]
    board: []
    departure_months: []
    max_price_per_person: 60000
    min_real_discount_pct: 15
    notify_new_offers: false
notifications:
  price_drop_pct: 10
  renotify_drop_pct: 5
  renotify_after_days: 7
  max_messages_per_run: 20
  digest_hour: 8
scan:
  adults: 2
  min_request_gap_ms: 3000
`;

function loadProfiles() {
  const dir = mkdtempSync(join(tmpdir(), 'dovolenky-filters-'));
  const path = join(dir, 'watch.yaml');
  writeFileSync(path, WATCH_YAML, 'utf-8');
  return loadConfig({ configPath: path, env: {} }).profiles;
}

function mkOffer(overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    source: 'test-source',
    sourceOfferKey: 'abc123',
    title: 'Test offer',
    country: 'Řecko',
    locality: null,
    stars: null,
    board: 'AI',
    transport: 'flight',
    departureAirport: null,
    departureDate: '2026-07-20',
    nights: null,
    pricePerPerson: 11990,
    priceTotal: null,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
    tourOperator: null,
    url: 'https://example.com/offer',
    ...overrides,
  };
}

describe('matchProfiles', () => {
  it('1. matches leto-more for Řecko/AI/flight offer departing 2026-07-20 at 11990', () => {
    const profiles = loadProfiles();
    const offer = mkOffer();

    const matches = matchProfiles(offer, profiles, new Date('2026-07-01'));

    expect(matches.map((m) => m.name)).toContain('leto-more');
  });

  it('1b. matches NOTHING once the departure day has passed (departed offers are unbuyable)', () => {
    const profiles = loadProfiles();
    const offer = mkOffer(); // departs 2026-07-20; matches leto-more on 2026-07-01 (test 1)

    // One day after departure (Prague calendar): every profile must reject it —
    // this is what mutes notifications/digest/stats for stale-but-still-listed terms.
    expect(matchProfiles(offer, profiles, new Date('2026-07-21T10:00:00.000Z'))).toEqual([]);
  });

  it('1c. departing TODAY still matches (same-day last-minute is bookable)', () => {
    const profiles = loadProfiles();
    const offer = mkOffer(); // departs 2026-07-20

    const matches = matchProfiles(offer, profiles, new Date('2026-07-20T08:00:00.000Z'));
    expect(matches.map((m) => m.name)).toContain('leto-more');
  });

  it('2. does not match leto-more when board is HB (profile requires [AI])', () => {
    const profiles = loadProfiles();
    const offer = mkOffer({ board: 'HB' });

    const matches = matchProfiles(offer, profiles, new Date('2026-07-01'));

    expect(matches.map((m) => m.name)).not.toContain('leto-more');
  });

  it('3. matches last-minute when departing 10 days from now, regardless of discount (countries [])', () => {
    const profiles = loadProfiles();
    const now = new Date('2026-07-01T00:00:00.000Z');
    const departureDate = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const offer = mkOffer({
      country: 'Nějaká jiná země',
      departureDate,
      pricePerPerson: 19000,
    });

    const matches = matchProfiles(offer, profiles, now);

    expect(matches.map((m) => m.name)).toContain('last-minute');
  });

  it('4. does not match leto-more when price is 26000 (max is 25000)', () => {
    const profiles = loadProfiles();
    const offer = mkOffer({ pricePerPerson: 26000 });

    const matches = matchProfiles(offer, profiles, new Date('2026-07-01'));

    expect(matches.map((m) => m.name)).not.toContain('leto-more');
  });

  it('5. does not match leto-more when departure month is 5 (profile wants 6-9)', () => {
    const profiles = loadProfiles();
    const offer = mkOffer({ departureDate: '2026-05-20' });

    const matches = matchProfiles(offer, profiles, new Date('2026-01-01'));

    expect(matches.map((m) => m.name)).not.toContain('leto-more');
  });

  it('6. a profile with enabled: false never matches', () => {
    const profiles = loadProfiles();
    profiles['leto-more']!.enabled = false;
    const offer = mkOffer();

    const matches = matchProfiles(offer, profiles, new Date('2026-07-01'));

    expect(matches.map((m) => m.name)).not.toContain('leto-more');
  });

  it('14. Maledivy/AI/flight/45000 Kč in January matches exotika but not leto-more', () => {
    const profiles = loadProfiles();
    const offer = mkOffer({
      country: 'Maledivy',
      board: 'AI',
      transport: 'flight',
      departureDate: '2027-01-15',
      pricePerPerson: 45000,
    });

    const matches = matchProfiles(offer, profiles, new Date('2026-07-01'));

    expect(matches.map((m) => m.name)).toContain('exotika');
    expect(matches.map((m) => m.name)).not.toContain('leto-more');
  });

  it('15. Thajsko offer with transport "unknown" under cap matches exotika (no transport filter)', () => {
    // Regression guard for the 2026-07-07 final-review fix: exotika dropped its
    // transport: flight filter. All exotika countries are long-haul (flight
    // implied), and matchesTransport requires exact equality — so a flight-only
    // operator whose cards carry no transport marker (ESO travel emits
    // 'unknown', as does part of Adventura) was silently excluded, killing its
    // notification path. With the filter gone, transport 'unknown' must match.
    const profiles = loadProfiles();
    const offer = mkOffer({
      country: 'Thajsko',
      transport: 'unknown',
      departureDate: '2027-01-15',
      pricePerPerson: 45000,
    });

    const matches = matchProfiles(offer, profiles, new Date('2026-07-01'));

    expect(matches.map((m) => m.name)).toContain('exotika');
  });

  it('7. an offer with departureDate: null only matches profiles with no date conditions', () => {
    const profiles = loadProfiles();
    const offer = mkOffer({ departureDate: null });

    const matches = matchProfiles(offer, profiles, new Date('2026-07-01'));

    // leto-more has departureMonths set -> must not match
    expect(matches.map((m) => m.name)).not.toContain('leto-more');
    // last-minute has departureWithinDays set -> must not match
    expect(matches.map((m) => m.name)).not.toContain('last-minute');
  });

  describe('departureWithinDays Prague calendar-day boundaries', () => {
    // now = 2026-07-04T05:00:00Z = 2026-07-04 07:00 Prague (CEST, UTC+2)
    const now = new Date('2026-07-04T05:00:00.000Z');

    it('8. departureDate today (2026-07-04) matches last-minute', () => {
      const profiles = loadProfiles();
      const offer = mkOffer({ departureDate: '2026-07-04' });

      const matches = matchProfiles(offer, profiles, now);

      expect(matches.map((m) => m.name)).toContain('last-minute');
    });

    it('9. departureDate exactly +14 days (2026-07-18) matches last-minute', () => {
      const profiles = loadProfiles();
      const offer = mkOffer({ departureDate: '2026-07-18' });

      const matches = matchProfiles(offer, profiles, now);

      expect(matches.map((m) => m.name)).toContain('last-minute');
    });

    it('10. departureDate +15 days (2026-07-19) does not match last-minute', () => {
      const profiles = loadProfiles();
      const offer = mkOffer({ departureDate: '2026-07-19' });

      const matches = matchProfiles(offer, profiles, now);

      expect(matches.map((m) => m.name)).not.toContain('last-minute');
    });

    it('11. departureDate yesterday (2026-07-03) does not match last-minute', () => {
      const profiles = loadProfiles();
      const offer = mkOffer({ departureDate: '2026-07-03' });

      const matches = matchProfiles(offer, profiles, now);

      expect(matches.map((m) => m.name)).not.toContain('last-minute');
    });

    it('12. Prague-midnight edge: now=2026-07-04T22:30:00Z (2026-07-05 00:30 Prague), departureDate 2026-07-04 does not match (already yesterday in Prague)', () => {
      const profiles = loadProfiles();
      const lateNow = new Date('2026-07-04T22:30:00.000Z');
      const offer = mkOffer({ departureDate: '2026-07-04' });

      const matches = matchProfiles(offer, profiles, lateNow);

      expect(matches.map((m) => m.name)).not.toContain('last-minute');
    });

    it('13. Prague-midnight edge: now=2026-07-04T22:30:00Z (2026-07-05 00:30 Prague), departureDate 2026-07-05 matches as today', () => {
      const profiles = loadProfiles();
      const lateNow = new Date('2026-07-04T22:30:00.000Z');
      const offer = mkOffer({ departureDate: '2026-07-05' });

      const matches = matchProfiles(offer, profiles, lateNow);

      expect(matches.map((m) => m.name)).toContain('last-minute');
    });
  });
});
