import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../lib/db.js';
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  parseCookies,
  createSession,
  setSessionCookies,
  clearSessionCookies,
  destroySessionByToken,
  destroyAllSessionsForUser,
  SESSION_COOKIE,
} from '../lib/auth-middleware.js';
import { validateBody } from '../lib/validate.js';
import { rateLimit, ipKey } from '../lib/rate-limit.js';
import { sendMail } from '../lib/mailer.js';
import { DEFAULT_PILLARS } from '../lib/seed-data.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

const authRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, keyFn: ipKey });

export const onboardSchema = z.object({
  orgName: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100).default('America/New_York'),
  displayName: z.string().min(1).max(200),
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
});

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const requestResetSchema = z.object({
  email: z.string().email().max(320),
});

export const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});

function publicUser(row) {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export function createAuthRouter() {
  const router = Router();

  router.get('/status', async (_req, res, next) => {
    try {
      const { rows } = await query('SELECT count(*)::int AS n FROM users');
      res.json({ needsOnboarding: rows[0].n === 0 });
    } catch (err) {
      next(err);
    }
  });

  router.post('/onboard', authRateLimit, validateBody(onboardSchema), async (req, res, next) => {
    try {
      const { orgName, timezone, displayName, email, password } = req.body;

      const { rows: existing } = await query('SELECT count(*)::int AS n FROM users');
      if (existing[0].n > 0) {
        return res.status(409).json({ error: 'Onboarding already completed' });
      }

      const passwordHash = await hashPassword(password);
      const verifyToken = randomToken();
      const verifyExpiresAt = new Date(Date.now() + VERIFY_TTL_MS);

      const user = await withTransaction(async (client) => {
        const { rows: orgRows } = await client.query(
          'INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id',
          [orgName, timezone]
        );
        const orgId = orgRows[0].id;

        const { rows: userRows } = await client.query(
          `INSERT INTO users (email, password_hash, display_name, verify_token_hash, verify_token_expires_at)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name`,
          [email.toLowerCase(), passwordHash, displayName, sha256(verifyToken), verifyExpiresAt]
        );
        const newUser = userRows[0];

        await client.query(
          "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'OWNER')",
          [orgId, newUser.id]
        );

        await client.query(
          'INSERT INTO brand_settings (org_id, business_name) VALUES ($1, $2)',
          [orgId, orgName]
        );

        for (const pillar of DEFAULT_PILLARS) {
          await client.query(
            `INSERT INTO content_pillars (org_id, name, description, color, requires_review)
             VALUES ($1, $2, $3, $4, $5)`,
            [orgId, pillar.name, pillar.description, pillar.color, pillar.requires_review]
          );
        }

        return newUser;
      });

      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      // The account (org, membership, brand settings, pillars) is already
      // committed at this point. A flaky mail provider must not turn a
      // successful signup into a dead end the user can never retry (the
      // account already exists, so onboarding can't run again either).
      try {
        await sendMail({
          to: user.email,
          subject: 'Verify your RG Bookkeeping Social Planner account',
          text: `Welcome! Verify your email: ${appUrl}/api/auth/verify?token=${verifyToken}`,
        });
      } catch (mailErr) {
        console.error('[onboard] verification email failed to send:', mailErr.message);
      }

      const session = await createSession(user.id);
      setSessionCookies(res, session);
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', authRateLimit, validateBody(loginSchema), async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const { rows } = await query(
        'SELECT id, email, display_name, password_hash, is_active FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
      const user = rows[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const session = await createSession(user.id);
      setSessionCookies(res, session);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const cookies = parseCookies(req);
      const token = cookies[SESSION_COOKIE];
      if (token) await destroySessionByToken(token);
      clearSessionCookies(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/verify', async (req, res, next) => {
    try {
      const token = String(req.query.token || '');
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      if (!token) return res.redirect(`${appUrl}/?verify=missing`);

      const { rows } = await query(
        `SELECT id FROM users
         WHERE verify_token_hash = $1 AND verify_token_expires_at > now()`,
        [sha256(token)]
      );
      if (rows.length === 0) return res.redirect(`${appUrl}/?verify=invalid`);

      await query(
        `UPDATE users SET email_verified_at = now(), verify_token_hash = NULL, verify_token_expires_at = NULL
         WHERE id = $1`,
        [rows[0].id]
      );
      res.redirect(`${appUrl}/?verify=success`);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/request-password-reset',
    authRateLimit,
    validateBody(requestResetSchema),
    async (req, res, next) => {
      try {
        const { email } = req.body;
        const { rows } = await query(
          'SELECT id, email FROM users WHERE email = $1 AND is_active',
          [email.toLowerCase()]
        );

        // Always respond the same way whether or not the account exists,
        // so this endpoint can't be used to enumerate registered emails.
        if (rows.length > 0) {
          const user = rows[0];
          const resetToken = randomToken();
          const expiresAt = new Date(Date.now() + RESET_TTL_MS);
          await query(
            'UPDATE users SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE id = $3',
            [sha256(resetToken), expiresAt, user.id]
          );
          const appUrl = process.env.APP_URL || 'http://localhost:3000';
          try {
            await sendMail({
              to: user.email,
              subject: 'Reset your RG Bookkeeping Social Planner password',
              text: `Reset your password: ${appUrl}/reset-password?token=${resetToken} (expires in 1 hour)`,
            });
          } catch (mailErr) {
            // Must not throw here: a 500 only ever happens when the email
            // exists (the branch above), which would leak exactly the
            // enumeration signal this endpoint's uniform 200 is meant to hide.
            console.error('[request-password-reset] email failed to send:', mailErr.message);
          }
        }

        res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post('/reset-password', authRateLimit, validateBody(resetSchema), async (req, res, next) => {
    try {
      const { token, newPassword } = req.body;
      const { rows } = await query(
        `SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires_at > now()`,
        [sha256(token)]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'Reset link is invalid or expired' });
      }

      const userId = rows[0].id;
      const passwordHash = await hashPassword(newPassword);
      await query(
        `UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL
         WHERE id = $2`,
        [passwordHash, userId]
      );
      await destroyAllSessionsForUser(userId);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
