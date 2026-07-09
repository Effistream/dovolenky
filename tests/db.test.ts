import { describe, it, expect } from 'vitest';
import { openDb, ensureSchema } from '../src/core/db/index.js';
import { offers } from '../src/core/db/schema.js';

describe('openDb', () => {
  it('opens a working in-memory DB when no authToken is passed (local URL, token N/A)', async () => {
    const db = openDb(':memory:');
    await ensureSchema(db);

    const rows = await db.select().from(offers);
    expect(rows).toEqual([]);
  });

  it('opens a working in-memory DB when authToken is explicitly undefined (safe no-op for local URLs)', async () => {
    const db = openDb(':memory:', undefined);
    await ensureSchema(db);

    const rows = await db.select().from(offers);
    expect(rows).toEqual([]);
  });
});
