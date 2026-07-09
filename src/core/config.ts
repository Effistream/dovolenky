import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Board } from './types.js';

const BOARD_VALUES = ['AI', 'FB', 'HB', 'BB', 'none', 'unknown'] as const;

const profileSchema = z
  .object({
    enabled: z.boolean(),
    countries: z.array(z.string()).default([]),
    transport: z.enum(['flight', 'own', 'bus']).optional(),
    board: z.array(z.enum(BOARD_VALUES)).default([]),
    departure_months: z.array(z.number()).default([]),
    departure_within_days: z.number().nullable().default(null),
    max_price_per_person: z.number().nullable().default(null),
    min_real_discount_pct: z.number(),
    notify_new_offers: z.boolean().default(false),
  })
  .strict()
  .transform((p) => ({
    enabled: p.enabled,
    countries: p.countries,
    transport: p.transport,
    board: p.board as Board[],
    departureMonths: p.departure_months,
    departureWithinDays: p.departure_within_days,
    maxPricePerPerson: p.max_price_per_person,
    minRealDiscountPct: p.min_real_discount_pct,
    notifyNewOffers: p.notify_new_offers,
  }));

const notifCfgSchema = z
  .object({
    price_drop_pct: z.number(),
    renotify_drop_pct: z.number(),
    renotify_after_days: z.number(),
    max_messages_per_run: z.number(),
    digest_hour: z.number(),
  })
  .strict()
  .transform((n) => ({
    priceDropPct: n.price_drop_pct,
    renotifyDropPct: n.renotify_drop_pct,
    renotifyAfterDays: n.renotify_after_days,
    maxMessagesPerRun: n.max_messages_per_run,
    digestHour: n.digest_hour,
  }));

const scanCfgSchema = z
  .object({
    adults: z.number(),
    min_request_gap_ms: z.number(),
  })
  .strict()
  .transform((s) => ({
    adults: s.adults,
    minRequestGapMs: s.min_request_gap_ms,
  }));

const watchYamlSchema = z
  .object({
    profiles: z.record(z.string(), profileSchema),
    notifications: notifCfgSchema,
    scan: scanCfgSchema,
  })
  .strict();

export interface Profile {
  enabled: boolean;
  countries: string[];
  transport?: 'flight' | 'own' | 'bus';
  board: Board[];
  departureMonths: number[];
  departureWithinDays: number | null;
  maxPricePerPerson: number | null;
  minRealDiscountPct: number;
  notifyNewOffers: boolean;
}

export interface NotifCfg {
  priceDropPct: number;
  renotifyDropPct: number;
  renotifyAfterDays: number;
  maxMessagesPerRun: number;
  digestHour: number;
}

export interface ScanCfg {
  adults: number;
  minRequestGapMs: number;
}

export interface AppConfig {
  profiles: Record<string, Profile>;
  notifications: NotifCfg;
  scan: ScanCfg;
  telegramToken: string | null;
  telegramChatId: string | null;
  databaseUrl: string;
  databaseAuthToken: string | null;
}

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../config/watch.yaml', import.meta.url));
const DEFAULT_DATABASE_URL = 'file:./data/dovolenky.db';

export function loadConfig(opts?: {
  configPath?: string;
  env?: Record<string, string | undefined>;
}): AppConfig {
  const configPath = opts?.configPath ?? DEFAULT_CONFIG_PATH;
  const env = opts?.env ?? process.env;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config file at "${configPath}": ${(err as Error).message}`);
  }

  const parsedYaml: unknown = parseYaml(raw);
  const result = watchYamlSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw new Error(`Invalid config file at "${configPath}": ${result.error.message}`);
  }

  return {
    profiles: result.data.profiles,
    notifications: result.data.notifications,
    scan: result.data.scan,
    telegramToken: env.TELEGRAM_BOT_TOKEN ?? null,
    telegramChatId: env.TELEGRAM_CHAT_ID ?? null,
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    databaseAuthToken: env.DATABASE_AUTH_TOKEN ?? null,
  };
}
