/**
 * Terminál shell (Task 26): header + status line, filter chips, the departure
 * board, and the two light cards. State lives here:
 *  - profile (single-select) → drives the server-side /api/offers?profile= query
 *  - activeCountries (multi-select) → client-side country filter over the result
 *  - expandedId → which row's detail slot is open (Task 27 fills the slot)
 * Offers refetch when the profile changes; countries filter/sort in the browser.
 */
import { useMemo, useState } from 'react';
import { StatusLine } from './components/StatusLine.js';
import { FilterChips } from './components/FilterChips.js';
import { Board } from './components/Board.js';
import { MarketCards } from './components/MarketCards.js';
import { fetchOffers, fetchSources, fetchStats, useAsync } from './lib/api.js';
import {
  countriesOf,
  filterOffers,
  profileParam,
  sortOffers,
} from './lib/format.js';
import type { ProfileFilter } from './lib/types.js';

export function App() {
  const [profile, setProfile] = useState<ProfileFilter>('all');
  const [activeCountries, setActiveCountries] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Offers refetch on profile change; sources/stats load once (they don't depend
  // on the filters). All three abort cleanly on unmount via useAsync.
  const offersState = useAsync(
    (signal) => fetchOffers({ profile: profileParam(profile) }, signal),
    [profile],
  );
  const sourcesState = useAsync((signal) => fetchSources(signal), []);
  const statsState = useAsync((signal) => fetchStats(signal), []);

  const allOffers = offersState.data?.offers ?? [];
  const countries = useMemo(() => countriesOf(allOffers), [allOffers]);

  // Client-side: keep only selected countries, then re-apply the board's sort.
  const visibleOffers = useMemo(
    () => sortOffers(filterOffers(allOffers, { countries: activeCountries })),
    [allOffers, activeCountries],
  );

  const toggleCountry = (c: string): void => {
    setActiveCountries((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  };

  const onProfile = (p: ProfileFilter): void => {
    setProfile(p);
    setExpandedId(null); // a filter change invalidates the open detail
  };

  const toggleRow = (id: number): void =>
    setExpandedId((cur) => (cur === id ? null : id));

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <h1>DOVOLENKY</h1>
          <span className="sub">osobní terminál zájezdů</span>
        </div>
        <StatusLine sources={sourcesState.data?.sources ?? null} loading={sourcesState.loading} />
      </header>

      <FilterChips
        profile={profile}
        onProfile={onProfile}
        countries={countries}
        activeCountries={activeCountries}
        onToggleCountry={toggleCountry}
      />

      <Board
        offers={visibleOffers}
        loading={offersState.loading}
        error={offersState.error}
        expandedId={expandedId}
        onToggle={toggleRow}
        onRetry={offersState.reload}
      />

      <MarketCards
        stats={statsState.data ?? null}
        sources={sourcesState.data?.sources ?? null}
      />

      <footer className="note">
        DOVOLENKY V1 · DATA Z VLASTNÍCH SKENŮ · ODLETOVÁ TABULE
      </footer>
    </div>
  );
}
