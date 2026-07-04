import { describe, it, expect } from 'vitest';
import { updateEnvVar } from '../src/cli/telegram-setup.js';

describe('updateEnvVar', () => {
  it('replaces an existing key while preserving other lines', () => {
    const content = 'TELEGRAM_BOT_TOKEN=abc123\nTELEGRAM_CHAT_ID=old\nDATABASE_URL=file:./data/dovolenky.db\n';
    const result = updateEnvVar(content, 'TELEGRAM_CHAT_ID', '999');
    expect(result).toBe('TELEGRAM_BOT_TOKEN=abc123\nTELEGRAM_CHAT_ID=999\nDATABASE_URL=file:./data/dovolenky.db\n');
  });

  it('appends the key when missing', () => {
    const content = 'TELEGRAM_BOT_TOKEN=abc123\nDATABASE_URL=file:./data/dovolenky.db\n';
    const result = updateEnvVar(content, 'TELEGRAM_CHAT_ID', '999');
    expect(result).toBe('TELEGRAM_BOT_TOKEN=abc123\nDATABASE_URL=file:./data/dovolenky.db\nTELEGRAM_CHAT_ID=999\n');
  });

  it('preserves comments and blank lines', () => {
    const content = '# Telegram config\nTELEGRAM_BOT_TOKEN=abc123\n\n# chat id below\nTELEGRAM_CHAT_ID=old\n';
    const result = updateEnvVar(content, 'TELEGRAM_CHAT_ID', '999');
    expect(result).toBe('# Telegram config\nTELEGRAM_BOT_TOKEN=abc123\n\n# chat id below\nTELEGRAM_CHAT_ID=999\n');
  });

  it('handles content with no trailing newline', () => {
    const content = 'TELEGRAM_BOT_TOKEN=abc123\nTELEGRAM_CHAT_ID=old';
    const result = updateEnvVar(content, 'TELEGRAM_CHAT_ID', '999');
    expect(result).toBe('TELEGRAM_BOT_TOKEN=abc123\nTELEGRAM_CHAT_ID=999\n');
  });

  it('appends to empty content', () => {
    const result = updateEnvVar('', 'TELEGRAM_CHAT_ID', '999');
    expect(result).toBe('TELEGRAM_CHAT_ID=999\n');
  });

  it('does not match keys inside comments', () => {
    const content = '# TELEGRAM_CHAT_ID=commented-out\nTELEGRAM_BOT_TOKEN=abc123\n';
    const result = updateEnvVar(content, 'TELEGRAM_CHAT_ID', '999');
    expect(result).toBe('# TELEGRAM_CHAT_ID=commented-out\nTELEGRAM_BOT_TOKEN=abc123\nTELEGRAM_CHAT_ID=999\n');
  });
});
