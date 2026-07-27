import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from './db.js';

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'rg_session';
const CSRF_COOKIE = 'rg_csrf';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day sliding expiry
const SLIDING_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // extend once <7 days remain
const BCRYPT_COST = 12;

export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex'); // 256 bits
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function cookieOptions(expiresAt, { httpOnly }) {
  return {
    httpOnly,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  };
}

export async function createSession(userId) {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await query(
    'INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
    [sha256(token), userId, csrfToken, expiresAt]
  );

  return { token, csrfToken, expiresAt };
}

export async function destroySessionByToken(token) {
  await query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
}

export async function destroyAllSessionsForUser(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export function setSessionCookies(res, { token, csrfToken, expiresAt }) {
  res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAt, { httpOnly: true }));
  res.cookie(CSRF_COOKIE, csrfToken, cookieOptions(expiresAt, { httpOnly: false }));
}

export function clearSessionCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

// Blanket gate for everything mounted after it: 401 with no valid, unexpired
// session. Also performs the sliding-expiry renewal so active users are
// never logged out mid-session.
export async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { rows } = await query(
      `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.display_name, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [sha256(token)]
    );
    const row = rows[0];
    if (!row || !row.is_active || new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = { id: row.id, email: row.email, displayName: row.display_name };
    req.sessionId = row.session_id;

    const remainingMs = new Date(row.expires_at).getTime() - Date.now();
    if (remainingMs < SLIDING_THRESHOLD_MS) {
      const newExpiry = new Date(Date.now() + SESSION_TTL_MS);
      await query('UPDATE sessions SET expires_at = $1 WHERE id = $2', [newExpiry, row.session_id]);
      res.cookie(SESSION_COOKIE, token, cookieOptions(newExpiry, { httpOnly: true }));
    }

    next();
  } catch (err) {
    next(err);
  }
}

// Double-cookie CSRF check for every non-GET request past requireAuth.
// Skipped on safe methods; the /api/auth/* pre-session routes are mounted
// ahead of this middleware entirely (see src/index.js), so there is no
// chicken-and-egg problem obtaining the first CSRF cookie.
export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

// Requires requireAuth to have already run. Resolves the caller's org
// membership and role; a v1 user belongs to exactly one org.
export async function requireOrg(req, res, next) {
  try {
    const { rows } = await query(
      'SELECT org_id, role FROM org_members WHERE user_id = $1 LIMIT 1',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(403).json({ error: 'No organization membership' });
    req.orgId = rows[0].org_id;
    req.orgRole = rows[0].role;
    next();
  } catch (err) {
    next(err);
  }
}

// Requires requireOrg to have already run.
export function requireOwner(req, res, next) {
  if (req.orgRole !== 'OWNER') {
    return res.status(403).json({ error: 'Owner role required' });
  }
  next();
}

export { SESSION_COOKIE, CSRF_COOKIE };
