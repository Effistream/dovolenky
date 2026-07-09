/**
 * Selects which adapters a scan run should use, from a comma-separated source
 * list (CLI `--source=a,b,c` or the `SCAN_SOURCES` env var). Empty/absent input
 * means "all adapters" (the default cloud/GitHub-Actions behavior).
 *
 * The Mac fallback scanner sets SCAN_SOURCES to just the sources that tarpit or
 * block the GitHub-Actions datacenter IP, so it scrapes those from a residential
 * IP without touching the sources the cloud already handles. Kept as a pure
 * function so it is unit-testable without executing the scan CLI's main().
 */
export function selectSources<T extends { name: string }>(
  all: readonly T[],
  raw: string | null | undefined,
): { adapters: T[]; unknown: string[] } {
  const wanted = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // No real names given (absent/empty/whitespace/bare commas) → default to all.
  // A non-empty list that matches nothing (e.g. "nope,nada") is a misconfig: it
  // returns zero adapters and the caller (scan.ts) exits with an error.
  if (wanted.length === 0) return { adapters: [...all], unknown: [] };

  const known = new Set(all.map((a) => a.name));
  const wantedSet = new Set(wanted);
  const adapters = all.filter((a) => wantedSet.has(a.name));
  const unknown = wanted.filter((w) => !known.has(w));
  return { adapters, unknown };
}
