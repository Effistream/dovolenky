/**
 * Selects which adapters a scan run should use, from a comma-separated source
 * list (CLI `--source=a,b,c` or the `SCAN_SOURCES` env var). Empty/absent input
 * means "all adapters" (the default cloud/GitHub-Actions behavior).
 *
 * The Mac fallback scanner sets SCAN_SOURCES to just the sources that tarpit or
 * block the GitHub-Actions datacenter IP, so it scrapes those from a residential
 * IP without touching the sources the cloud already handles. Kept as a pure
 * function so it is unit-testable without executing the scan CLI's main().
 *
 * `excludeRaw` (CLI `--exclude=a,b` or `SCAN_EXCLUDE_SOURCES`) is the mirror
 * image for the cloud: the CESYS sources (dovolenkovani, firo, zajezdy) are
 * dropped at connection level from the datacenter IP — measured over 7 days
 * (2026-08-27 → 09-03) they succeeded 0/55, 0/55 and 0/56 times, each attempt
 * only writing a `failed` source_runs row that fed the health alerts. Exclusion
 * is applied AFTER inclusion so `--source=firo --exclude=firo` yields zero
 * adapters (caller treats that as a misconfig), and `excluded` lists only the
 * names that were actually removed, so the log never claims more than happened.
 */
export function selectSources<T extends { name: string }>(
  all: readonly T[],
  raw: string | null | undefined,
  excludeRaw?: string | null,
): { adapters: T[]; unknown: string[]; excluded: string[] } {
  const wanted = parseNames(raw);
  const toExclude = parseNames(excludeRaw);
  const known = new Set(all.map((a) => a.name));

  // No real names given (absent/empty/whitespace/bare commas) → default to all.
  // A non-empty list that matches nothing (e.g. "nope,nada") is a misconfig: it
  // returns zero adapters and the caller (scan.ts) exits with an error.
  const wantedSet = new Set(wanted);
  const included = wanted.length === 0 ? [...all] : all.filter((a) => wantedSet.has(a.name));

  const excludeSet = new Set(toExclude);
  const adapters = included.filter((a) => !excludeSet.has(a.name));
  // Registry order (same as `adapters`), and only what the filter above removed.
  const excluded = included.filter((a) => excludeSet.has(a.name)).map((a) => a.name);

  // Unknown names from BOTH lists, include list first — a typo in either place
  // deserves the same "did you mean" warning.
  const unknown = [...wanted, ...toExclude].filter((name) => !known.has(name));
  return { adapters, unknown, excluded };
}

function parseNames(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
