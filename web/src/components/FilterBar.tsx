/**
 * FilterBar (Task 29) — replaces the thin FilterChips. A compact, chip-based
 * panel over the loaded /api/offers set. Only the profile is a server-side param
 * (single-select, drives the refetch); every other control narrows client-side.
 *
 * Layout follows design-system/MASTER.md:
 *  - Primary row, always visible: profile chips · country chips (top 8 by count
 *    + a „+ dalších N" reveal — this is the fix for the user's original complaint
 *    that only some destinations were selectable) · řazení · a live active-count
 *    badge + „Vymazat vše".
 *  - Secondary rows behind a „Více filtrů (N aktivních)" toggle: cena · noci ·
 *    strava · odlet · termín · min. reálná sleva · zdroj.
 * Section labels are mono uppercase; chips carry aria-pressed; grouped controls
 * sit in <fieldset>/<legend> so the whole panel is keyboard- and SR-navigable.
 */
import { useMemo, useState } from 'react';
import type { ProfileFilter } from '../lib/types.js';
import {
  activeFilterCount,
  airportFacets,
  boardFacets,
  countryFacets,
  hasOwnTransport,
  isDefaultState,
  NIGHTS_BANDS,
  sourceFacets,
  type Facet,
  type FilterState,
  type NightsBand,
  type SortKey,
} from '../lib/filters.js';
import { sourceLabel } from '../lib/term.js';
import type { Offer } from '../lib/types.js';

interface Props {
  offers: Offer[];
  profile: ProfileFilter;
  onProfile: (p: ProfileFilter) => void;
  state: FilterState;
  onChange: (next: FilterState) => void;
  onClear: () => void;
}

const PROFILES: { key: ProfileFilter; label: string }[] = [
  { key: 'all', label: 'Vše' },
  { key: 'leto-more', label: 'Léto u moře' },
  { key: 'last-minute', label: 'Last-minute' },
  { key: 'exotika', label: 'Exotika' },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'real', label: 'Reálná sleva' },
  { key: 'price', label: 'Cena' },
  { key: 'departure', label: 'Odlet' },
];

const PRICE_PRESETS = [10000, 15000, 20000, 25000];
const MIN_REAL_PRESETS = [10, 15, 25];
/**
 * Board chip order + labels. Covers the full Board domain (AI/FB/HB/BB/none/
 * unknown) so every board code that can appear on the board is also
 * selectable/excludable here — see boardFacets, which filters this list down
 * to codes actually present in the loaded data.
 */
const BOARD_LABELS: Record<string, string> = {
  AI: 'All inclusive',
  FB: 'Plná penze',
  HB: 'Polopenze',
  BB: 'Snídaně',
  none: 'Bez stravy',
  unknown: 'Neuvedeno',
};
const BOARD_CHIPS = ['AI', 'FB', 'HB', 'BB', 'none', 'unknown'];
const NIGHTS_ORDER: NightsBand[] = ['le5', '6-8', '9-12', '13+'];
const COUNTRY_VISIBLE = 8;

/** A single toggle chip with aria-pressed semantics. */
function Chip({
  label,
  pressed,
  onClick,
  className,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`chip${className ? ` ${className}` : ''}`}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Toggle a value in/out of a string[] immutably. */
function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function FilterBar({ offers, profile, onProfile, state, onChange, onClear }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showAllCountries, setShowAllCountries] = useState(false);
  const [priceInput, setPriceInput] = useState('');

  const countries = useMemo(() => countryFacets(offers), [offers]);
  const airports = useMemo(() => airportFacets(offers), [offers]);
  const sources = useMemo(() => sourceFacets(offers), [offers]);
  const boards = useMemo(() => boardFacets(offers), [offers]);
  const boardCodes = useMemo(() => new Set(boards.map((b) => b.value)), [boards]);
  const ownAvailable = useMemo(() => hasOwnTransport(offers), [offers]);

  const activeCount = activeFilterCount(state);
  const isDefault = isDefaultState(state);

  const visibleCountries = showAllCountries ? countries : countries.slice(0, COUNTRY_VISIBLE);
  const overflow = countries.length - COUNTRY_VISIBLE;

  const set = (patch: Partial<FilterState>): void => onChange({ ...state, ...patch });

  const applyCustomPrice = (): void => {
    const n = Number(priceInput);
    if (Number.isInteger(n) && n > 0) set({ maxPrice: n });
    setPriceInput('');
  };

  return (
    <section className="filterbar" aria-label="Filtry nabídek">
      {/* ── Primary row: profiles · countries · sort · clear ─────────────── */}
      <div className="fb-row fb-primary">
        <fieldset className="fb-group">
          <legend className="fb-label">PROFIL</legend>
          {PROFILES.map((p) => (
            <Chip
              key={p.key}
              label={p.label}
              pressed={profile === p.key}
              onClick={() => onProfile(p.key)}
            />
          ))}
        </fieldset>

        {countries.length > 0 && (
          <fieldset className="fb-group">
            <legend className="fb-label">ZEMĚ</legend>
            {visibleCountries.map((c) => (
              <Chip
                key={c.value}
                label={`${c.value} ${c.count}`}
                pressed={state.countries.includes(c.value)}
                className="chip--country"
                onClick={() => set({ countries: toggle(state.countries, c.value) })}
              />
            ))}
            {overflow > 0 && (
              <button
                type="button"
                className="fb-more-countries"
                aria-expanded={showAllCountries}
                onClick={() => setShowAllCountries((v) => !v)}
              >
                {showAllCountries ? 'Méně zemí' : `+ dalších ${overflow}`}
              </button>
            )}
          </fieldset>
        )}

        <fieldset className="fb-group fb-sort">
          <legend className="fb-label">ŘAZENÍ</legend>
          {SORTS.map((s) => (
            <Chip
              key={s.key}
              label={s.label}
              pressed={state.sort === s.key}
              onClick={() => set({ sort: s.key })}
            />
          ))}
        </fieldset>
      </div>

      {/* ── Controls: more-filters toggle + active count + clear ─────────── */}
      <div className="fb-controls">
        <button
          type="button"
          className="fb-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Méně filtrů' : 'Více filtrů'}
          {activeCount > 0 && (
            <span className="fb-count" aria-label={`${activeCount} aktivních filtrů`}>
              {activeCount}
            </span>
          )}
        </button>
        {!isDefault && (
          <button type="button" className="fb-clear" onClick={onClear}>
            Vymazat vše
          </button>
        )}
      </div>

      {/* ── Secondary rows (collapsible) ─────────────────────────────────── */}
      {expanded && (
        <div className="fb-secondary">
          <fieldset className="fb-group">
            <legend className="fb-label">CENA MAX/OS.</legend>
            {PRICE_PRESETS.map((p) => (
              <Chip
                key={p}
                label={`${p / 1000} tis.`}
                pressed={state.maxPrice === p}
                onClick={() => set({ maxPrice: state.maxPrice === p ? null : p })}
              />
            ))}
            <input
              type="number"
              className="fb-input"
              inputMode="numeric"
              min={1}
              placeholder="vlastní"
              aria-label="Vlastní cena max na osobu"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCustomPrice();
              }}
              onBlur={applyCustomPrice}
            />
            {state.maxPrice != null && !PRICE_PRESETS.includes(state.maxPrice) && (
              <Chip
                label={`${state.maxPrice} Kč`}
                pressed
                onClick={() => set({ maxPrice: null })}
              />
            )}
          </fieldset>

          <fieldset className="fb-group">
            <legend className="fb-label">NOCI</legend>
            {NIGHTS_ORDER.map((b) => (
              <Chip
                key={b}
                label={NIGHTS_BANDS[b].label}
                pressed={state.nights.includes(b)}
                onClick={() => set({ nights: toggle(state.nights, b) })}
              />
            ))}
          </fieldset>

          {boards.length > 0 && (
            <fieldset className="fb-group">
              <legend className="fb-label">STRAVA</legend>
              {BOARD_CHIPS.filter((code) => boardCodes.has(code)).map((code) => (
                <Chip
                  key={code}
                  label={BOARD_LABELS[code] ?? code}
                  pressed={state.boards.includes(code)}
                  onClick={() => set({ boards: toggle(state.boards, code) })}
                />
              ))}
            </fieldset>
          )}

          {(airports.length > 0 || ownAvailable) && (
            <fieldset className="fb-group">
              <legend className="fb-label">ODLET</legend>
              {airports.map((a: Facet) => (
                <Chip
                  key={a.value}
                  label={`${a.value} ${a.count}`}
                  pressed={state.airports.includes(a.value)}
                  className="chip--country"
                  onClick={() => set({ airports: toggle(state.airports, a.value) })}
                />
              ))}
              {ownAvailable && (
                <Chip
                  label="Vlastní doprava"
                  pressed={state.ownTransport}
                  onClick={() => set({ ownTransport: !state.ownTransport })}
                />
              )}
            </fieldset>
          )}

          <fieldset className="fb-group fb-dates">
            <legend className="fb-label">TERMÍN</legend>
            <label className="fb-datelbl">
              <span>od</span>
              <input
                type="date"
                className="fb-input fb-date"
                aria-label="Odlet od"
                value={state.dateFrom ?? ''}
                onChange={(e) => set({ dateFrom: e.target.value || null })}
              />
            </label>
            <label className="fb-datelbl">
              <span>do</span>
              <input
                type="date"
                className="fb-input fb-date"
                aria-label="Odlet do"
                value={state.dateTo ?? ''}
                onChange={(e) => set({ dateTo: e.target.value || null })}
              />
            </label>
          </fieldset>

          <fieldset className="fb-group">
            <legend className="fb-label">MIN. REÁLNÁ SLEVA</legend>
            {MIN_REAL_PRESETS.map((p) => (
              <Chip
                key={p}
                label={`${p} %`}
                pressed={state.minRealPct === p}
                onClick={() => set({ minRealPct: state.minRealPct === p ? null : p })}
              />
            ))}
          </fieldset>

          {sources.length > 0 && (
            <fieldset className="fb-group">
              <legend className="fb-label">ZDROJ</legend>
              {sources.map((s: Facet) => (
                <Chip
                  key={s.value}
                  label={`${sourceLabel(s.value)} ${s.count}`}
                  pressed={state.sources.includes(s.value)}
                  className="chip--country"
                  onClick={() => set({ sources: toggle(state.sources, s.value) })}
                />
              ))}
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
