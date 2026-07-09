/**
 * Terminál shell. Header + status line, the FilterBar (Task 29), the departure
 * board, and the two light cards. State lives here:
 *  - profile (single-select) → drives the server-side /api/offers?profile= query
 *  - filters (FilterState) → the full client-side filter/sort panel, applied over
 *    the loaded offer set and mirrored into the URL query (shareable/bookmarkable)
 *  - expandedId → which row's detail slot is open
 * Offers refetch only when the profile changes; every other filter and the sort
 * run in the browser over that loaded set (the API returns the full active set).
 */
import { useEffect, useMemo, useState } from 'react';
import { StatusLine } from './components/StatusLine.js';
import { FilterBar } from './components/FilterBar.js';
import { Board } from './components/Board.js';
import { OfferDetail } from './components/OfferDetail.js';
import { MarketCards } from './components/MarketCards.js';
import {
  fetchExclusions,
  fetchOffers,
  fetchSources,
  fetchStats,
  putExclusions,
  useAsync,
} from './lib/api.js';
import { profileParam } from './lib/format.js';
import {
  applyFilterAndSort,
  emptyFilterState,
  parseFilterState,
  serializeFilterQuery,
  type FilterState,
} from './lib/filters.js';
import type { ProfileFilter } from './lib/types.js';

/** Read the current window query into a FilterState (SSR-safe guard for tests). */
function stateFromUrl(): FilterState {
  if (typeof window === 'undefined') return emptyFilterState();
  return parseFilterState(window.location.search.replace(/^\?/, ''));
}

/** Mirror the state into the address bar without a history entry. */
function syncUrl(state: FilterState): void {
  if (typeof window === 'undefined') return;
  const query = serializeFilterQuery(state);
  const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.replaceState(null, '', url);
}

export function App() {
  const [profile, setProfile] = useState<ProfileFilter>('all');
  const [filters, setFilters] = useState<FilterState>(stateFromUrl);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Offers refetch on profile change; sources/stats load once (they don't depend
  // on the filters). All three abort cleanly on unmount via useAsync.
  const offersState = useAsync(
    (signal) => fetchOffers({ profile: profileParam(profile) }, signal),
    [profile],
  );
  const sourcesState = useAsync((signal) => fetchSources(signal), []);
  const statsState = useAsync((signal) => fetchStats(signal), []);
  // Global „nechci vidět" exclusions — server-side state, deliberately NOT in the
  // URL/FilterState. Excluded countries are already hidden from /api/offers and
  // /api/stats server-side, so changing them refetches both.
  const exclusionsState = useAsync((signal) => fetchExclusions(signal), []);
  const excluded = exclusionsState.data?.countries ?? [];

  const onExcluded = async (next: string[]): Promise<void> => {
    await putExclusions(next);
    exclusionsState.reload(); // refresh the chip list from the stored set
    offersState.reload(); // board refetch — excluded rows disappear, counts adjust
  };

  const allOffers = offersState.data?.offers ?? [];

  // Client-side: apply the full filter panel, then the chosen sort.
  const visibleOffers = useMemo(
    () => applyFilterAndSort(allOffers, filters),
    [allOffers, filters],
  );

  // Keep the URL in step with the filter state (replaceState — no history spam).
  useEffect(() => {
    syncUrl(filters);
  }, [filters]);

  const onFilters = (next: FilterState): void => {
    setFilters(next);
    setExpandedId(null); // a filter change invalidates the open detail
  };

  const onClear = (): void => onFilters(emptyFilterState());

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

      <FilterBar
        offers={allOffers}
        profile={profile}
        onProfile={onProfile}
        state={filters}
        onChange={onFilters}
        onClear={onClear}
        excluded={excluded}
        onExcluded={onExcluded}
      />

      <Board
        offers={visibleOffers}
        loading={offersState.loading}
        error={offersState.error}
        expandedId={expandedId}
        onToggle={toggleRow}
        onRetry={offersState.reload}
        sort={filters.sort}
        renderDetail={(offer) => <OfferDetail offer={offer} />}
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
