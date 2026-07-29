import { Router } from 'express';
import { z } from 'zod';
import { query, getPool, withTransaction } from '../lib/db.js';
import { validateBody, validateQuery } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { requireOwner } from '../lib/auth-middleware.js';
import {
  validateTransition,
  autoTransitionForFieldChange,
  canArchive,
  TransitionError,
} from '../services/post-service.js';
import { createSignedUrl } from '../lib/storage.js';
import { captionSimilarity } from '../lib/similarity.js';

const PILLAR_REPEAT_WINDOW_DAYS = 14;
const SIMILAR_CAPTION_WINDOW_DAYS = 90;
const SIMILARITY_THRESHOLD = 0.5;

const JSON_COLUMNS = new Set(['caption_overrides', 'published_urls']);

const createSchema = z.object({
  title: z.string().min(1).max(300),
  status: z.enum(['idea', 'draft']).optional().default('idea'),
  pillar_id: z.string().uuid().optional().nullable(),
  campaign: z.string().max(200).optional().nullable(),
  platforms: z.array(z.string()).optional().default([]),
  caption_main: z.string().max(10000).optional().nullable(),
  caption_overrides: z.record(z.string()).optional(),
  hashtags: z.string().max(1000).optional().nullable(),
  cta: z.string().max(200).optional().nullable(),
  link_url: z.string().url().max(1000).optional().nullable().or(z.literal('')),
  planned_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  planned_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
  needs_review: z.boolean().optional(),
  disclaimer_required: z.boolean().optional(),
  is_evergreen: z.boolean().optional(),
  reuse_interval_days: z.number().int().positive().optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  media_instructions: z.string().max(2000).optional().nullable(),
});

const updateSchema = createSchema
  .omit({ status: true })
  .partial()
  .extend({
    published_urls: z.record(z.string()).optional(),
    expected_updated_at: z.string().optional(),
  });

const listQuerySchema = z
  .object({
    status: z.string().optional(),
    pillar_id: z.string().uuid().optional(),
    platform: z.string().optional(),
    campaign: z.string().optional(),
    search: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    includeArchived: z.string().optional(),
  })
  .partial();

const transitionSchema = z.object({
  to: z.enum(['idea', 'draft', 'ready', 'scheduled', 'published', 'skipped']),
  approve: z.boolean().optional(),
  published_urls: z.record(z.string()).optional(),
  published_at: z.string().optional(),
  note: z.string().max(1000).optional(),
});

const copyLogSchema = z.object({
  platform: z.string().min(1).max(50),
});

const repetitionCheckSchema = z.object({
  post_id: z.string().uuid().optional().nullable(),
  pillar_id: z.string().uuid().optional().nullable(),
  caption_main: z.string().max(10000).optional().nullable(),
});

const router = Router();

async function validatePlatformKeys(platforms) {
  if (!platforms || platforms.length === 0) return;
  const { rows } = await query('SELECT key FROM platforms WHERE is_enabled = true');
  const valid = new Set(rows.map((r) => r.key));
  const invalid = platforms.filter((p) => !valid.has(p));
  if (invalid.length > 0) {
    const err = new Error(`Unknown or disabled platform(s): ${invalid.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

function toColumnValue(key, value) {
  return JSON_COLUMNS.has(key) ? JSON.stringify(value) : value;
}

router.get('/', validateQuery(listQuerySchema), async (req, res, next) => {
  try {
    const { status, pillar_id, platform, campaign, search, date_from, date_to, includeArchived } = req.query;
    const clauses = ['org_id = $1'];
    const params = [req.orgId];

    if (includeArchived !== 'true') clauses.push('archived_at IS NULL');
    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      params.push(statuses);
      clauses.push(`status = ANY($${params.length}::post_status[])`);
    }
    if (pillar_id) {
      params.push(pillar_id);
      clauses.push(`pillar_id = $${params.length}`);
    }
    if (platform) {
      params.push(platform);
      clauses.push(`$${params.length} = ANY(platforms)`);
    }
    if (campaign) {
      params.push(`%${campaign}%`);
      clauses.push(`campaign ILIKE $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      clauses.push(`(title ILIKE $${params.length} OR caption_main ILIKE $${params.length})`);
    }
    if (date_from) {
      params.push(date_from);
      clauses.push(`planned_date >= $${params.length}`);
    }
    if (date_to) {
      params.push(date_to);
      clauses.push(`planned_date <= $${params.length}`);
    }

    const { rows } = await query(
      `SELECT * FROM posts WHERE ${clauses.join(' AND ')}
       ORDER BY (planned_date IS NULL), planned_date, planned_time, created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ posts: rows });
  } catch (err) {
    next(err);
  }
});

// Evergreen resurfacing: a post is "due" once reuse_interval_days have
// elapsed since it was last reused (or, if never reused, since it was
// published/created). Only published/skipped posts qualify -- a post that
// hasn't been through the workflow yet has nothing to resurface.
router.get('/evergreen/due', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM posts
       WHERE org_id = $1 AND archived_at IS NULL AND is_evergreen = true
         AND reuse_interval_days IS NOT NULL
         AND status IN ('published', 'skipped')
         AND COALESCE(last_reused_at, published_at, created_at)
             <= now() - (reuse_interval_days::text || ' days')::interval
       ORDER BY COALESCE(last_reused_at, published_at, created_at) ASC
       LIMIT 100`,
      [req.orgId]
    );
    res.json({ posts: rows });
  } catch (err) {
    next(err);
  }
});

// Topic-repetition warnings (spec's Phase 2 order, final step): informational
// only, never blocks a save/transition -- distinct from evergreen reuse
// (deliberate, scheduled repetition) in that this catches *accidental*
// repeats, e.g. forgetting a pillar/topic was already covered recently.
router.post('/repetition-check', validateBody(repetitionCheckSchema), async (req, res, next) => {
  try {
    const { post_id: postId, pillar_id: pillarId, caption_main: captionMain } = req.body;

    let pillarRepeats = [];
    if (pillarId) {
      const { rows } = await query(
        `SELECT id, title, planned_date, published_at, created_at FROM posts
         WHERE org_id = $1 AND pillar_id = $2 AND archived_at IS NULL
           AND ($3::uuid IS NULL OR id != $3)
           AND COALESCE(planned_date, published_at::date, created_at::date)
               >= (now() - ($4 || ' days')::interval)::date
         ORDER BY COALESCE(planned_date, published_at::date, created_at::date) DESC
         LIMIT 5`,
        [req.orgId, pillarId, postId || null, PILLAR_REPEAT_WINDOW_DAYS]
      );
      pillarRepeats = rows;
    }

    let similarCaptions = [];
    if (captionMain && captionMain.trim().length > 0) {
      const { rows } = await query(
        `SELECT id, title, caption_main, planned_date, published_at, created_at FROM posts
         WHERE org_id = $1 AND archived_at IS NULL AND caption_main IS NOT NULL
           AND ($2::uuid IS NULL OR id != $2)
           AND COALESCE(planned_date, published_at::date, created_at::date)
               >= (now() - ($3 || ' days')::interval)::date
         LIMIT 200`,
        [req.orgId, postId || null, SIMILAR_CAPTION_WINDOW_DAYS]
      );
      similarCaptions = rows
        .map((r) => ({ ...r, similarity: captionSimilarity(captionMain, r.caption_main) }))
        .filter((r) => r.similarity >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 3)
        .map((r) => ({
          id: r.id,
          title: r.title,
          planned_date: r.planned_date,
          published_at: r.published_at,
          created_at: r.created_at,
          similarity: r.similarity,
        }));
    }

    res.json({ pillarRepeats, similarCaptions });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ post: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/', validateBody(createSchema), async (req, res, next) => {
  try {
    await validatePlatformKeys(req.body.platforms);

    const fields = { ...req.body, org_id: req.orgId, created_by: req.user.id, updated_by: req.user.id };
    const keys = Object.keys(fields);
    const columns = keys.join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map((k) => toColumnValue(k, fields[k]));

    const post = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO posts (${columns}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      const created = rows[0];
      await client.query(
        'INSERT INTO status_history (post_id, from_status, to_status, actor_id) VALUES ($1, NULL, $2, $3)',
        [created.id, created.status, req.user.id]
      );
      await writeAudit(client, {
        orgId: req.orgId,
        actorId: req.user.id,
        action: 'post.create',
        recordType: 'post',
        recordId: created.id,
        before: null,
        after: created,
        req,
      });
      return created;
    });

    res.status(201).json({ post });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res, next) => {
  try {
    const { rows: existingRows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = existingRows[0];

    const { expected_updated_at, ...body } = req.body;
    if (expected_updated_at && new Date(expected_updated_at).getTime() !== new Date(before.updated_at).getTime()) {
      return res.status(409).json({ error: 'This post changed elsewhere. Reload before saving again.' });
    }

    if (before.status === 'published') {
      const allowed = new Set(['published_urls', 'notes']);
      const disallowed = Object.keys(body).filter((k) => !allowed.has(k));
      if (disallowed.length > 0) {
        return res.status(409).json({ error: 'This post is published and locked; only the URL and notes can change.' });
      }
    }

    if (body.platforms) await validatePlatformKeys(body.platforms);

    const autoPatch = autoTransitionForFieldChange(before, body) || {};
    const fields = { ...body, ...autoPatch, updated_by: req.user.id };
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.json({ post: before });

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => toColumnValue(k, fields[k]));

    const after = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE posts SET ${setClauses.join(', ')} WHERE id = $${keys.length + 1} AND org_id = $${keys.length + 2}
         RETURNING *`,
        [...values, req.params.id, req.orgId]
      );
      const updated = rows[0];

      if (autoPatch.status && autoPatch.status !== before.status) {
        await client.query(
          'INSERT INTO status_history (post_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)',
          [updated.id, before.status, autoPatch.status, req.user.id, 'auto: field edit']
        );
      }

      await writeAudit(client, {
        orgId: req.orgId,
        actorId: req.user.id,
        action: 'post.update',
        recordType: 'post',
        recordId: updated.id,
        before,
        after: updated,
        req,
      });
      return updated;
    });

    res.json({ post: after });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/transition', validateBody(transitionSchema), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const post = rows[0];

    let patch;
    try {
      patch = validateTransition(post, req.body.to, {
        orgRole: req.orgRole,
        actorId: req.user.id,
        approve: req.body.approve,
        publishedUrls: req.body.published_urls,
        publishedAt: req.body.published_at ? new Date(req.body.published_at) : undefined,
      });
    } catch (err) {
      if (err instanceof TransitionError) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    const fields = { status: req.body.to, ...patch, updated_by: req.user.id };
    const keys = Object.keys(fields);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => toColumnValue(k, fields[k]));

    const updated = await withTransaction(async (client) => {
      const { rows: updRows } = await client.query(
        `UPDATE posts SET ${setClauses.join(', ')} WHERE id = $${keys.length + 1} AND org_id = $${keys.length + 2}
         RETURNING *`,
        [...values, req.params.id, req.orgId]
      );
      await client.query(
        'INSERT INTO status_history (post_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)',
        [req.params.id, post.status, req.body.to, req.user.id, req.body.note || null]
      );
      await writeAudit(client, {
        orgId: req.orgId,
        actorId: req.user.id,
        action: 'post.status_change',
        recordType: 'post',
        recordId: req.params.id,
        before: { status: post.status },
        after: { status: req.body.to },
        req,
      });
      return updRows[0];
    });

    res.json({ post: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/archive', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const post = rows[0];
    if (post.archived_at) return res.status(409).json({ error: 'Already archived' });
    if (!canArchive(post.status, req.orgRole)) {
      return res.status(403).json({ error: `Only the Owner can archive a ${post.status} post` });
    }

    const { rows: updRows } = await query(
      'UPDATE posts SET archived_at = now(), updated_by = $1 WHERE id = $2 AND org_id = $3 RETURNING *',
      [req.user.id, req.params.id, req.orgId]
    );
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'post.archive',
      recordType: 'post',
      recordId: req.params.id,
      before: { archived_at: null },
      after: { archived_at: updRows[0].archived_at },
      req,
    });
    res.json({ post: updRows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/restore', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM posts WHERE id = $1 AND org_id = $2 AND archived_at IS NOT NULL',
      [req.params.id, req.orgId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const post = rows[0];
    const targetStatus = post.caption_main && post.caption_main.trim() ? 'draft' : 'idea';

    const { rows: updRows } = await withTransaction(async (client) => {
      const result = await client.query(
        'UPDATE posts SET archived_at = NULL, status = $1, updated_by = $2 WHERE id = $3 AND org_id = $4 RETURNING *',
        [targetStatus, req.user.id, req.params.id, req.orgId]
      );
      await client.query(
        'INSERT INTO status_history (post_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)',
        [req.params.id, post.status, targetStatus, req.user.id, 'restored from archive']
      );
      return result;
    });

    res.json({ post: updRows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reuse', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const original = rows[0];

    const copy = await withTransaction(async (client) => {
      const { rows: newRows } = await client.query(
        `INSERT INTO posts (
           org_id, title, status, pillar_id, campaign, platforms, caption_main,
           caption_overrides, hashtags, cta, link_url, is_evergreen, reuse_interval_days,
           parent_post_id, created_by, updated_by
         ) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
         RETURNING *`,
        [
          req.orgId,
          original.title,
          original.pillar_id,
          original.campaign,
          original.platforms,
          original.caption_main,
          JSON.stringify(original.caption_overrides || {}),
          original.hashtags,
          original.cta,
          original.link_url,
          original.is_evergreen,
          original.reuse_interval_days,
          original.id,
          req.user.id,
        ]
      );
      const created = newRows[0];
      await client.query('UPDATE posts SET last_reused_at = now() WHERE id = $1', [original.id]);
      await client.query(
        'INSERT INTO status_history (post_id, from_status, to_status, actor_id, note) VALUES ($1, NULL, $2, $3, $4)',
        [created.id, created.status, req.user.id, `reused from ${original.id}`]
      );
      await writeAudit(client, {
        orgId: req.orgId,
        actorId: req.user.id,
        action: 'post.reuse',
        recordType: 'post',
        recordId: created.id,
        before: null,
        after: { parent_post_id: original.id },
        req,
      });
      return created;
    });

    res.status(201).json({ post: copy });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/copy-log', validateBody(copyLogSchema), async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'post.copy_caption',
      recordType: 'post',
      recordId: req.params.id,
      before: null,
      after: { platform: req.body.platform },
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (!rows[0].archived_at) {
      return res.status(409).json({ error: 'Archive the post before permanently deleting it' });
    }

    await query('DELETE FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'post.delete',
      recordType: 'post',
      recordId: req.params.id,
      before: rows[0],
      after: null,
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const attachMediaSchema = z.object({ media_id: z.string().uuid() });
const reorderMediaSchema = z.object({ order: z.array(z.string().uuid()) });

router.get('/:id/media', async (req, res, next) => {
  try {
    const { rows: postRows } = await query('SELECT id FROM posts WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (postRows.length === 0) return res.status(404).json({ error: 'Not found' });

    const { rows } = await query(
      `SELECT m.*, pm.sort_order FROM post_media pm
       JOIN media_assets m ON m.id = pm.media_id
       WHERE pm.post_id = $1 ORDER BY pm.sort_order`,
      [req.params.id]
    );
    const media = await Promise.all(rows.map(async (m) => ({ ...m, signedUrl: await createSignedUrl(m.object_path) })));
    res.json({ media });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/media', validateBody(attachMediaSchema), async (req, res, next) => {
  try {
    const { rows: postRows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (postRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const post = postRows[0];

    const { rows: mediaRows } = await query('SELECT id FROM media_assets WHERE id = $1 AND org_id = $2', [
      req.body.media_id,
      req.orgId,
    ]);
    if (mediaRows.length === 0) return res.status(404).json({ error: 'Media not found' });

    if (post.platforms && post.platforms.length > 0) {
      const { rows: platformRows } = await query(
        'SELECT MIN(media_max_count) AS max_count FROM platforms WHERE key = ANY($1)',
        [post.platforms]
      );
      const maxCount = platformRows[0].max_count;
      if (maxCount != null) {
        const { rows: countRows } = await query('SELECT count(*)::int AS n FROM post_media WHERE post_id = $1', [
          req.params.id,
        ]);
        if (countRows[0].n >= maxCount) {
          return res.status(400).json({
            error: `This post's platforms allow at most ${maxCount} media item(s)`,
          });
        }
      }
    }

    const { rows: maxRows } = await query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM post_media WHERE post_id = $1',
      [req.params.id]
    );
    await query('INSERT INTO post_media (post_id, media_id, sort_order) VALUES ($1, $2, $3)', [
      req.params.id,
      req.body.media_id,
      maxRows[0].next,
    ]);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already attached' });
    next(err);
  }
});

router.delete('/:id/media/:mediaId', async (req, res, next) => {
  try {
    const { rows: postRows } = await query('SELECT id FROM posts WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (postRows.length === 0) return res.status(404).json({ error: 'Not found' });

    await query('DELETE FROM post_media WHERE post_id = $1 AND media_id = $2', [req.params.id, req.params.mediaId]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.put('/:id/media/reorder', validateBody(reorderMediaSchema), async (req, res, next) => {
  try {
    const { rows: postRows } = await query('SELECT id FROM posts WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (postRows.length === 0) return res.status(404).json({ error: 'Not found' });

    await withTransaction(async (client) => {
      for (let i = 0; i < req.body.order.length; i += 1) {
        await client.query('UPDATE post_media SET sort_order = $1 WHERE post_id = $2 AND media_id = $3', [
          i,
          req.params.id,
          req.body.order[i],
        ]);
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
