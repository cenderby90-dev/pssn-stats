import { sql } from '@vercel/postgres';

const WINDOW_MINUTES = 5;
const MAX_FAILURES = 10;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? fwd.split(',')[0] : (req.socket?.remoteAddress || 'unknown');
  return ip.trim();
}

// Checks a submitted PIN against one or more accepted PINs (e.g. team PIN or admin PIN),
// with brute-force protection: after MAX_FAILURES wrong attempts from the same IP within
// WINDOW_MINUTES, further attempts are rejected regardless of whether the PIN is actually
// correct, until the window rolls forward. Every attempt (success or failure) is logged.
//
// Usage in an endpoint:
//   const auth = await checkPin(req, pin, [ADMIN_PIN]);
//   if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
export async function checkPin(req, pin, validPins) {
  const ip = getClientIp(req);

  // Opportunistic cleanup so this table doesn't grow unbounded -- no cron needed for a
  // site this size, just prune old rows occasionally as a side effect of a real request.
  if (Math.random() < 0.02) {
    sql`DELETE FROM pin_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'`.catch(() => {});
  }

  // WINDOW_MINUTES is a fixed constant, not user input -- hardcoded directly in the
  // interval literal rather than interpolated, since a template parameter can't be
  // substituted inside a quoted SQL string literal this way.
  const { rows } = await sql`
    SELECT COUNT(*)::int AS c FROM pin_attempts
    WHERE ip_address = ${ip} AND success = false AND attempted_at > NOW() - INTERVAL '5 minutes'
  `;
  if (rows[0].c >= MAX_FAILURES) {
    return { ok: false, status: 429, error: `Too many failed attempts. Try again in a few minutes.` };
  }

  const isValid = !!pin && validPins.some(p => p && pin === p);
  await sql`INSERT INTO pin_attempts (ip_address, success) VALUES (${ip}, ${isValid})`;

  if (!isValid) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}
