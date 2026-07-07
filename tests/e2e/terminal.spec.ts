/**
 * Terminál smoke (Task 28). Drives the real stack (seeded throwaway DB → Hono
 * server → built SPA, wired up by playwright.config.ts#webServer) through the
 * user-visible surface: board render, filters, detail expand, alternatives, and
 * the two summary cards. Assertions target seeded fixture data (see seed.ts).
 *
 * Console hygiene (scenario g): a single page-level listener collects every
 * console error and pageerror across the whole file, and an afterAll fails the
 * run if any were seen. React/fetch errors that don't throw synchronously still
 * surface here, so a green run means the app rendered clean end to end.
 */
import { test, expect, type ConsoleMessage } from '@playwright/test';

// Collected across every test in this file; asserted empty in afterAll.
const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });
});

test.afterAll(() => {
  expect(consoleErrors, `Console errors during the run:\n${consoleErrors.join('\n')}`).toEqual([]);
});

/** Wait until the board has rendered real rows (not the loading skeleton). */
async function waitForBoard(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('button.row').first()).toBeVisible();
}

test('(a) board renders seeded offer titles and the count line', async ({ page }) => {
  await waitForBoard(page);

  // Seeded hero + a couple of fillers must be on the board.
  await expect(page.getByText('Hotel Poseidon Beach')).toBeVisible();
  await expect(page.getByText('Hotel Sunrise Garden')).toBeVisible();
  await expect(page.getByText('Hotel Aegean Star')).toBeVisible();

  // Count line: "SEŘAZENO PODLE REÁLNÉ SLEVY · N NABÍDEK". 11 board rows (the
  // cross-source pair collapses to one representative).
  const count = page.locator('.board-cap .count');
  await expect(count).toContainText('SEŘAZENO PODLE REÁLNÉ SLEVY');
  await expect(count).toContainText('11 NABÍDEK');
  await expect(page.locator('button.row')).toHaveCount(11);
});

test('(b) country chip filters rows and updates the count', async ({ page }) => {
  await waitForBoard(page);

  const rowsBefore = await page.locator('button.row').count();
  expect(rowsBefore).toBe(11);

  // Řecko chip → only Řecko rows remain. Seeded Řecko offers: Poseidon Beach,
  // Aegean Star, Rhodos Bay → 3 rows.
  const recko = page.locator('button.chip--country', { hasText: 'Řecko' });
  await expect(recko).toBeVisible();
  await recko.click();

  await expect(recko).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button.row')).toHaveCount(3);
  await expect(page.locator('.board-cap .count')).toContainText('3 NABÍDEK');
  await expect(page.getByText('Hotel Poseidon Beach')).toBeVisible();
  // A non-Řecko offer must be gone.
  await expect(page.getByText('Hotel Sunrise Garden')).toHaveCount(0);

  // Toggle back off → all rows return.
  await recko.click();
  await expect(recko).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('button.row')).toHaveCount(11);
});

test('(c) profile chip refetches and changes the offer set', async ({ page }) => {
  await waitForBoard(page);
  await expect(page.locator('button.row')).toHaveCount(11);

  // "Léto u moře" → server-side profile filter (leto-more: Řecko/Turecko/… ×
  // AI × flight × months 6-9 × ≤25000). That set is strictly smaller than "Vše".
  const leto = page.locator('button.chip', { hasText: 'Léto u moře' });
  await leto.click();
  await expect(leto).toHaveAttribute('aria-pressed', 'true');

  // Board must re-render with a different (smaller) row set. The hero (Řecko/AI/
  // flight, departure in August) is in the leto-more set.
  await expect(page.locator('button.row').first()).toBeVisible();
  const letoCount = await page.locator('button.row').count();
  expect(letoCount).toBeGreaterThan(0);
  expect(letoCount).toBeLessThan(11);
  await expect(page.getByText('Hotel Poseidon Beach')).toBeVisible();
  // An HB/Bulharsko filler (Sunny Bay) is NOT in the AI-only leto-more set.
  await expect(page.getByText('Hotel Sunny Bay')).toHaveCount(0);

  // Back to "Vše" → full set again.
  await page.locator('button.chip', { hasText: 'Vše' }).click();
  await expect(page.locator('button.row')).toHaveCount(11);
});

test('(d) row expand shows the detail: chart + „PŮVODNÍ CENA" for the history offer', async ({ page }) => {
  await waitForBoard(page);

  // Expand the hero (7-snapshot history, claimed original → red line).
  const hero = page.locator('button.row', { hasText: 'Hotel Poseidon Beach' });
  await hero.click();
  await expect(hero).toHaveAttribute('aria-expanded', 'true');

  const detail = page.locator('.detail');
  await expect(detail).toBeVisible();
  // Chart SVG present, and the „PŮVODNÍ CENA" claimed-original label drawn.
  await expect(detail.locator('svg')).toBeVisible();
  await expect(detail.getByText('PŮVODNÍ CENA')).toBeVisible();
  // Detail facts prove the long history rendered.
  await expect(detail.getByText(/SLEDUJI/)).toBeVisible();
});

test('(d) a single-snapshot offer shows „zatím málo dat na graf"', async ({ page }) => {
  await waitForBoard(page);

  // Costa Nueva has exactly one snapshot → buildChart returns null → note.
  const single = page.locator('button.row', { hasText: 'Hotel Costa Nueva' });
  await single.click();
  await expect(single).toHaveAttribute('aria-expanded', 'true');

  const detail = page.locator('.detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('zatím málo dat na graf')).toBeVisible();
});

test('(e) „Také:" alternatives are visible on the cross-source row', async ({ page }) => {
  await waitForBoard(page);

  // Blue Lagoon is the cheaper (fischer) representative of the cross-source
  // pair; the pricier invia twin renders as a "Také: INVIA …" via-line.
  const twin = page.locator('button.row', { hasText: 'Hotel Blue Lagoon' });
  await expect(twin).toBeVisible();
  const via = twin.locator('.src .via');
  await expect(via).toBeVisible();
  await expect(via).toContainText('Také:');
  await expect(via).toContainText('INVIA');
});

test('(f) TRH DNES and ZDROJE cards are populated, incl. a backoff/red source', async ({ page }) => {
  await waitForBoard(page);

  // TRH DNES: three market numbers (activeCount / new24h / median). The active
  // count number must be a concrete figure, not the em-dash placeholder.
  const trh = page.locator('.card', { hasText: 'TRH DNES' });
  await expect(trh).toBeVisible();
  await expect(trh.getByText('aktivních nabídek')).toBeVisible();
  const activeNum = trh.locator('.market .m').first().locator('.num');
  await expect(activeNum).not.toHaveText('—');

  // ZDROJE: source rows present, and the blocked skrz source is red + "v pauze".
  const zdroje = page.locator('.card', { hasText: 'ZDROJE' });
  await expect(zdroje).toBeVisible();
  const skrz = zdroje.locator('.sourc', { hasText: 'SKRZ' });
  await expect(skrz).toBeVisible();
  await expect(skrz.locator('.dot.warn')).toBeVisible(); // red = failed
  await expect(skrz.getByText('v pauze')).toBeVisible(); // backoff via-note
});
