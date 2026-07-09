import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { getExcludedCountries, setExcludedCountries } from '../src/core/db/exclusions.js';

describe('excluded_countries helpers', () => {
  let db: Db;
  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('starts empty', async () => {
    expect(await getExcludedCountries(db)).toEqual([]);
  });

  it('stores, dedups and sorts (cs); round-trips via get', async () => {
    const stored = await setExcludedCountries(db, ['Turecko', 'Egypt', 'Egypt']);
    expect(stored).toEqual(['Egypt', 'Turecko']);
    expect(await getExcludedCountries(db)).toEqual(['Egypt', 'Turecko']);
  });

  it('replaces the whole set (not merge)', async () => {
    await setExcludedCountries(db, ['Egypt']);
    const stored = await setExcludedCountries(db, ['Řecko']);
    expect(stored).toEqual(['Řecko']);
    expect(await getExcludedCountries(db)).toEqual(['Řecko']);
  });

  it('drops unknown (non-canonical) countries', async () => {
    const stored = await setExcludedCountries(db, ['Egypt', 'Absurdistán', '']);
    expect(stored).toEqual(['Egypt']);
  });

  it('canonicalizes accepted aliases / case variants', async () => {
    const stored = await setExcludedCountries(db, ['bali', 'egypt', 'SAE']);
    expect(stored).toEqual(['Egypt', 'Indonésie', 'Spojené arabské emiráty']);
  });
});
