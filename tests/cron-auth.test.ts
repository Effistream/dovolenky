import { describe, it, expect } from 'vitest';
import { checkCronSecret } from '../src/web/cron-auth.js';
describe('checkCronSecret', () => {
  it('accepts exact Bearer match', () => expect(checkCronSecret('Bearer s3cret', 's3cret')).toBe(true));
  it('rejects wrong secret', () => expect(checkCronSecret('Bearer nope', 's3cret')).toBe(false));
  it('rejects missing header', () => expect(checkCronSecret(undefined, 's3cret')).toBe(false));
  it('rejects when server secret unset', () => expect(checkCronSecret('Bearer s3cret', undefined)).toBe(false));
  it('rejects non-bearer', () => expect(checkCronSecret('s3cret', 's3cret')).toBe(false));
  it('rejects length mismatch without throwing', () => expect(checkCronSecret('Bearer short', 'muchlongersecret')).toBe(false));
});
