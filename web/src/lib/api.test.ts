import { describe, it, expect, vi, afterEach } from 'vitest';
import { putExclusions } from './api.js';

afterEach(() => vi.restoreAllMocks());

describe('putExclusions', () => {
  it('PUTs the list and returns the stored set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ countries: ['Egypt'] }), { status: 200 }),
    );
    const out = await putExclusions(['Egypt', 'Řecko']);
    expect(out).toEqual({ countries: ['Egypt'] });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'PUT' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      countries: ['Egypt', 'Řecko'],
    });
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(putExclusions(['Egypt'])).rejects.toThrow('/api/exclusions → 500');
  });
});
