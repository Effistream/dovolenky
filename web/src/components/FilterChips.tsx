/**
 * Filter bar: profile chips (single-select — the active profile drives the
 * server-side /api/offers?profile= query), country chips (multi-select, derived
 * from the currently loaded offers, applied client-side), and a static threshold
 * pill. Chip visuals and aria-pressed semantics are 1:1 with the mockup.
 */
import type { ProfileFilter } from '../lib/types.js';

interface Props {
  profile: ProfileFilter;
  onProfile: (p: ProfileFilter) => void;
  countries: string[];
  activeCountries: string[];
  onToggleCountry: (c: string) => void;
}

const PROFILES: { key: ProfileFilter; label: string }[] = [
  { key: 'all', label: 'Vše' },
  { key: 'leto-more', label: 'Léto u moře' },
  { key: 'last-minute', label: 'Last-minute' },
];

export function FilterChips({
  profile,
  onProfile,
  countries,
  activeCountries,
  onToggleCountry,
}: Props) {
  return (
    <nav className="filters" aria-label="Filtry nabídek">
      {PROFILES.map((p) => (
        <button
          key={p.key}
          type="button"
          className="chip"
          aria-pressed={profile === p.key}
          onClick={() => onProfile(p.key)}
        >
          {p.label}
        </button>
      ))}

      {countries.length > 0 && <span className="gap" aria-hidden="true" />}

      {countries.map((c) => (
        <button
          key={c}
          type="button"
          className="chip chip--country"
          aria-pressed={activeCountries.includes(c)}
          onClick={() => onToggleCountry(c)}
        >
          {c}
        </button>
      ))}

      <span className="threshold">PRÁH REÁLNÉ SLEVY 15 %</span>
    </nav>
  );
}
