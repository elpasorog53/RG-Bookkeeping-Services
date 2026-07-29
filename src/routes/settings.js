import { Router } from 'express';
import { z } from 'zod';
import { query, getPool } from '../lib/db.js';
import { validateBody } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { requireOwner, hashPassword, randomToken, sha256, destroyAllSessionsForUser } from '../lib/auth-middleware.js';
import { rateLimit, ipKey } from '../lib/rate-limit.js';
import { sendMail } from '../lib/mailer.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const brandSettingsSchema = z.object({
  business_name: z.string().max(200).optional().nullable(),
  business_description: z.string().max(4000).optional().nullable(),
  services: z.string().max(4000).optional().nullable(),
  target_audience: z.string().max(2000).optional().nullable(),
  geographic_area: z.string().max(500).optional().nullable(),
  tone: z.string().max(500).optional().nullable(),
  preferred_terms: z.string().max(2000).optional().nullable(),
  avoid_terms: z.string().max(2000).optional().nullable(),
  default_ctas: z.array(z.string()).optional(),
  website_url: z.string().url().max(500).optional().nullable().or(z.literal('')),
  contact_info: z.string().max(1000).optional().nullable(),
  disclaimer_text: z.string().max(2000).optional().nullable(),
  platform_prefs: z.record(z.any()).optional(),
  post_length_pref: z.string().max(200).optional().nullable(),
  example_posts: z.array(z.string()).max(5).optional(),
}).partial();

const platformUpdateSchema = z.object({
  char_soft_limit: z.number().int().positive().optional(),
  char_hard_limit: z.number().int().positive().optional(),
  media_max_count: z.number().int().min(0).optional(),
  notes: z.string().max(2000).optional().nullable(),
  is_enabled: z.boolean().optional(),
}).partial();

const inviteSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200),
  role: z.enum(['OWNER', 'EDITOR']).default('EDITOR'),
});

const inviteRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, keyFn: ipKey });

const router = Router();

router.get('/brand', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM brand_settings WHERE org_id = $1', [req.orgId]);
    res.json({ brandSettings: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

router.put('/brand', requireOwner, validateBody(brandSettingsSchema), async (req, res, next) => {
  try {
    const { rows: beforeRows } = await query('SELECT * FROM brand_settings WHERE org_id = $1', [req.orgId]);
    const before = beforeRows[0] || null;

    const fields = req.body;
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.json({ brandSettings: before });

    const jsonColumns = new Set(['default_ctas', 'platform_prefs', 'example_posts']);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => (jsonColumns.has(k) ? JSON.stringify(fields[k]) : fields[k]));

    const { rows } = await query(
      `UPDATE brand_settings SET ${setClauses.join(', ')} WHERE org_id = $${keys.length + 1} RETURNING *`,
      [...values, req.orgId]
    );
    const after = rows[0];

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'settings.update',
      recordType: 'brand_settings',
      recordId: req.orgId,
      before,
      after,
      req,
    });
    res.json({ brandSettings: after });
  } catch (err) {
    next(err);
  }
});

router.get('/platforms', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM platforms ORDER BY sort_order');
    res.json({ platforms: rows });
  } catch (err) {
    next(err);
  }
});

router.put('/platforms/:key', requireOwner, validateBody(platformUpdateSchema), async (req, res, next) => {
  try {
    const { rows: beforeRows } = await query('SELECT * FROM platforms WHERE key = $1', [req.params.key]);
    if (beforeRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = beforeRows[0];

    const fields = req.body;
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.json({ platform: before });

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    const { rows } = await query(
      `UPDATE platforms SET ${setClauses.join(', ')} WHERE key = $${keys.length + 1} RETURNING *`,
      [...values, req.params.key]
    );
    const after = rows[0];

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'settings.platform_update',
      recordType: 'platform',
      recordId: after.key,
      before,
      after,
      req,
    });
    res.json({ platform: after });
  } catch (err) {
    next(err);
  }
});

router.get('/users', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.display_name, u.is_active, u.email_verified_at, m.role
       FROM org_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY u.created_at`,
      [req.orgId]
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/users/invite', requireOwner, inviteRateLimit, validateBody(inviteSchema), async (req, res, next) => {
  try {
    const { email, displayName, role } = req.body;
    const normalizedEmail = email.toLowerCase();

    const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    const unusablePassword = await hashPassword(randomToken());
    const inviteToken = randomToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const { rows: userRows } = await query(
      `INSERT INTO users (email, password_hash, display_name, reset_token_hash, reset_token_expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name`,
      [normalizedEmail, unusablePassword, displayName, sha256(inviteToken), expiresAt]
    );
    const newUser = userRows[0];

    await query('INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)', [
      req.orgId,
      newUser.id,
      role,
    ]);

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    // Not awaited: the user + org_members rows are already committed, and a
    // slow/hung mail server must never block this response or the audit
    // write below. A failed send is logged, not thrown -- the invite has
    // already happened either way.
    sendMail({
      to: newUser.email,
      subject: 'You have been invited to RG Bookkeeping Social Planner',
      text: `${req.user.displayName} invited you as ${role.toLowerCase()}. Set your password: ${appUrl}/reset-password?token=${inviteToken} (link expires in 7 days)`,
    }).catch((mailErr) => {
      console.error('[invite] email failed to send:', mailErr.message);
    });

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'user.invite',
      recordType: 'user',
      recordId: newUser.id,
      before: null,
      after: { email: newUser.email, role },
      req,
    });

    res.status(201).json({ user: newUser });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/deactivate', requireOwner, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    const { rows } = await query(
      `UPDATE users SET is_active = false
       WHERE id = $1 AND id IN (SELECT user_id FROM org_members WHERE org_id = $2)
       RETURNING id, email, is_active`,
      [req.params.id, req.orgId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await destroyAllSessionsForUser(rows[0].id);

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'user.deactivate',
      recordType: 'user',
      recordId: rows[0].id,
      before: null,
      after: rows[0],
      req,
    });
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

function feedUrlFor(token) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  return `${appUrl}/api/calendar-feed/${token}.ics`;
}

router.get('/calendar-feed-url', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT calendar_feed_token FROM organizations WHERE id = $1', [req.orgId]);
    let token = rows[0].calendar_feed_token;
    if (!token) {
      token = randomToken();
      await query('UPDATE organizations SET calendar_feed_token = $1 WHERE id = $2', [token, req.orgId]);
    }
    res.json({ feedUrl: feedUrlFor(token) });
  } catch (err) {
    next(err);
  }
});

// Owner-only: rotating the token invalidates the old URL immediately,
// useful if a feed link was ever shared somewhere it shouldn't have been.
router.post('/calendar-feed-url/regenerate', requireOwner, async (req, res, next) => {
  try {
    const token = randomToken();
    await query('UPDATE organizations SET calendar_feed_token = $1 WHERE id = $2', [token, req.orgId]);
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'settings.calendar_feed_token_regenerate',
      recordType: 'organization',
      recordId: req.orgId,
      before: null,
      after: null,
      req,
    });
    res.json({ feedUrl: feedUrlFor(token) });
  } catch (err) {
    next(err);
  }
});

export default router;
