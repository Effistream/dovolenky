import { readFileSync } from 'node:fs';

/**
 * Minimal .env loader — no dependency. Reads KEY=VALUE lines, ignores blanks
 * and `#` comments, strips optional surrounding quotes, and only sets vars not
 * already present in the environment (real env wins over the file).
 */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return; // no .env file is fine
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}
