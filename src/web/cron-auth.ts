import { timingSafeEqual } from 'node:crypto';

/** Constant-time check of an `Authorization: Bearer <secret>` header against CRON_SECRET. */
export function checkCronSecret(authHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret || !authHeader) return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const provided = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(provided, expected);
}
