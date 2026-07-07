import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';

const CONFIG_PATH = fileURLToPath(new URL('../config/watch.yaml', import.meta.url));

describe('loadConfig', () => {
  it('parses real config/watch.yaml into the expected shape', () => {
    const cfg = loadConfig({ configPath: CONFIG_PATH, env: {} });

    expect(cfg.profiles['leto-more']?.board).toEqual(['AI']);
    expect(cfg.profiles['leto-more']?.departureMonths).toEqual([6, 7, 8, 9]);
    expect(cfg.profiles['leto-more']?.minRealDiscountPct).toBe(15);

    expect(cfg.profiles['last-minute']?.departureWithinDays).toBe(14);

    expect(cfg.notifications.digestHour).toBe(8);
    expect(cfg.scan.adults).toBe(2);
  });

  it('parses the exotika profile (task 34; countries extended to 24 per spec §16.3 rev)', () => {
    const cfg = loadConfig({ configPath: CONFIG_PATH, env: {} });

    const exotika = cfg.profiles['exotika'];
    expect(exotika?.enabled).toBe(true);
    // Extended from 17 to 24 (spec §16.3 revision after Task 39 review): +Nepál, Peru, Japonsko,
    // Kambodža, Madagaskar, Namibie, Jihoafrická republika (Adventura's expedition countries).
    expect(exotika?.countries).toHaveLength(24);
    expect(exotika?.countries).toEqual(
      expect.arrayContaining(['Nepál', 'Peru', 'Japonsko', 'Kambodža', 'Madagaskar', 'Namibie', 'Jihoafrická republika']),
    );
    expect(exotika?.transport).toBe('flight');
    expect(exotika?.board).toEqual([]);
    expect(exotika?.departureMonths).toEqual([]);
    expect(exotika?.maxPricePerPerson).toBe(60000);
    expect(exotika?.minRealDiscountPct).toBe(15);
    expect(exotika?.notifyNewOffers).toBe(false);
  });

  it('applies sensible defaults for optional fields', () => {
    const cfg = loadConfig({ configPath: CONFIG_PATH, env: {} });

    const lastMinute = cfg.profiles['last-minute'];
    expect(lastMinute?.countries).toEqual([]);
    expect(lastMinute?.board).toEqual([]);
    expect(lastMinute?.transport).toBeUndefined();

    const letoMore = cfg.profiles['leto-more'];
    expect(letoMore?.departureWithinDays).toBeNull();
    expect(letoMore?.notifyNewOffers).toBe(false);
  });

  it('defaults databaseUrl and leaves telegram creds null when env is empty', () => {
    const cfg = loadConfig({ configPath: CONFIG_PATH, env: {} });

    expect(cfg.databaseUrl).toBe('file:./data/dovolenky.db');
    expect(cfg.telegramToken).toBeNull();
    expect(cfg.telegramChatId).toBeNull();
  });

  it('reads telegram creds and databaseUrl from the provided env map', () => {
    const cfg = loadConfig({
      configPath: CONFIG_PATH,
      env: {
        TELEGRAM_BOT_TOKEN: 'abc123',
        TELEGRAM_CHAT_ID: '999',
        DATABASE_URL: 'file:./custom.db',
      },
    });

    expect(cfg.telegramToken).toBe('abc123');
    expect(cfg.telegramChatId).toBe('999');
    expect(cfg.databaseUrl).toBe('file:./custom.db');
  });

  it('throws a clear error when the config file is missing', () => {
    expect(() => loadConfig({ configPath: '/nonexistent/path/watch.yaml', env: {} })).toThrow(
      /watch\.yaml|config|ENOENT|not found/i,
    );
  });

  it('throws on unknown keys in the YAML (zod .strict())', () => {
    const badPath = fileURLToPath(new URL('./fixtures/bad-watch.yaml', import.meta.url));
    expect(() => loadConfig({ configPath: badPath, env: {} })).toThrow();
  });
});
