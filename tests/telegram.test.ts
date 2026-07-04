import { describe, it, expect, vi } from 'vitest';
import { Telegram } from '../src/core/telegram.js';

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Telegram', () => {
  it('POSTs to the correct sendMessage URL with the right body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const tg = new Telegram('TOKEN123', 'CHAT456', fetchImpl as unknown as typeof fetch);

    await tg.send('<b>hello</b>');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN123/sendMessage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      chat_id: 'CHAT456',
      text: '<b>hello</b>',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  it('resolves without throwing on a successful {ok: true} response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: {} }));
    const tg = new Telegram('TOKEN123', 'CHAT456', fetchImpl as unknown as typeof fetch);

    await expect(tg.send('hi')).resolves.toBeUndefined();
  });

  it('throws with the description when the HTTP response is not ok', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, description: 'Bad Request: chat not found' }, { status: 400, statusText: 'Bad Request' }),
    );
    const tg = new Telegram('TOKEN123', 'CHAT456', fetchImpl as unknown as typeof fetch);

    await expect(tg.send('hi')).rejects.toThrow(/chat not found/);
  });

  it('throws with the description when HTTP is ok but the JSON payload has ok:false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, description: 'Forbidden: bot was blocked by the user' }));
    const tg = new Telegram('TOKEN123', 'CHAT456', fetchImpl as unknown as typeof fetch);

    await expect(tg.send('hi')).rejects.toThrow(/blocked by the user/);
  });

  it('uses the global fetch when no fetchImpl is provided', () => {
    const tg = new Telegram('TOKEN123', 'CHAT456');
    expect(tg).toBeInstanceOf(Telegram);
  });
});
