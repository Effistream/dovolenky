import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.js';

const POLL_TIMEOUT_SECONDS = 25;
const TOTAL_TIMEOUT_MS = 2 * 60 * 1000;

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  chat: TelegramChat;
  from?: TelegramUser;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

const NO_TOKEN_GUIDE = `TELEGRAM_BOT_TOKEN chybí v .env.

Založení bota přes @BotFather:
  1. Otevři Telegram a najdi uživatele @BotFather.
  2. Pošli mu příkaz /newbot.
  3. Zadej jméno bota (zobrazované jméno) a poté jeho username (musí končit na "bot").
  4. BotFather ti pošle token ve tvaru "123456789:AAExampleTokenString".
  5. Vlož token do souboru .env v kořeni projektu jako:
     TELEGRAM_BOT_TOKEN=123456789:AAExampleTokenString
  6. Spusť znovu: npm run telegram:setup`;

/**
 * Replaces the value of `key` in a .env-style file content, preserving all
 * other lines (including comments and blank lines). If the key is not
 * present, appends a new line for it (adding a trailing newline before it
 * if the file doesn't already end with one).
 */
export function updateEnvVar(content: string, key: string, value: string): string {
  if (content === '') return `${key}=${value}\n`;

  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  // split('\n') on a string ending with '\n' yields a trailing '' element;
  // drop it so we don't duplicate blank lines when rejoining.
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop();

  let found = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const lineKey = trimmed.slice(0, eq).trim();
    if (lineKey === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}=${value}`);
  }

  return updated.join('\n') + '\n';
}

async function fetchUpdates(token: string, offset: number): Promise<GetUpdatesResponse> {
  const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=${POLL_TIMEOUT_SECONDS}&offset=${offset}`;
  const response = await fetch(url);
  const payload = (await response.json().catch(() => null)) as GetUpdatesResponse | null;
  if (!response.ok || !payload || payload.ok === false) {
    const description = payload?.description ?? `HTTP ${response.status} ${response.statusText}`;
    throw new Error(description);
  }
  return payload;
}

async function waitForFirstMessage(token: string): Promise<TelegramMessage> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let offset = 0;

  while (Date.now() < deadline) {
    const payload = await fetchUpdates(token, offset);
    const updates = payload.result ?? [];
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message) {
        return update.message;
      }
    }
  }

  throw new Error('timeout');
}

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const envPath = `${projectRoot}.env`;

  loadDotEnv(envPath, process.env);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error(NO_TOKEN_GUIDE);
    process.exit(1);
  }

  console.log('Pošli svému botovi na Telegramu libovolnou zprávu. Čekám (max 2 minuty)…');

  let message: TelegramMessage;
  try {
    message = await waitForFirstMessage(token);
  } catch (err) {
    if (err instanceof Error && err.message === 'timeout') {
      console.error('Nic nepřišlo do 2 minut. Zkontroluj, že píšeš správnému botovi, a spusť příkaz znovu.');
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Telegram API vrátilo chybu: ${detail}`);
    }
    process.exit(1);
  }

  const chatId = message.chat.id;
  const name = message.from?.first_name ?? message.from?.username ?? 'neznámý uživatel';

  const existingContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const updatedContent = updateEnvVar(existingContent, 'TELEGRAM_CHAT_ID', String(chatId));
  writeFileSync(envPath, updatedContent, 'utf-8');

  console.log(`Chat ID: ${chatId} (${name})`);
  console.log('TELEGRAM_CHAT_ID uloženo do .env.');
  console.log('Hotovo. Spusť npm run scan -- --dry-run');
}

// Only run when executed directly (e.g. `tsx src/cli/telegram-setup.ts`), not
// when imported by tests for the pure `updateEnvVar` helper.
const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('telegram-setup selhal:', err);
    process.exit(1);
  });
}
