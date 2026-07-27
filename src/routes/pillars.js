import { Router } from 'express';
import { z } from 'zod';
import { query, getPool } from '../lib/db.js';
import { validateBody } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { requireOwner } from '../lib/auth-middleware.js';

const pillarSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  requires_review: z.boolean().optional().default(false),
});

const pillarUpdateSchema = pillarSchema.partial();

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const { rows } = await query(
      `SELECT * FROM content_pillars WHERE org_id = $1 ${includeArchived ? '' : 'AND archived_at IS NULL'}
       ORDER BY name`,
      [req.orgId]
    );
    res.json({ pillars: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireOwner, validateBody(pillarSchema), async (req, res, next) => {
  try {
    const { name, description, color, requires_review } = req.body;
    const { rows } = await query(
      `INSERT INTO content_pillars (org_id, name, description, color, requires_review)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.orgId, name, description ?? null, color ?? null, requires_review]
    );
    const pillar = rows[0];
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'pillar.create',
      recordType: 'content_pillar',
      recordId: pillar.id,
      before: null,
      after: pillar,
      req,
    });
    res.status(201).json({ pillar });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A pillar with that name already exists' });
    }
    next(err);
  }
});

router.put('/:id', requireOwner, validateBody(pillarUpdateSchema), async (req, res, next) => {
  try {
    const { rows: existingRows } = await query(
      'SELECT * FROM content_pillars WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = existingRows[0];

    const fields = req.body;
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.json({ pillar: before });

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    const { rows } = await query(
      `UPDATE content_pillars SET ${setClauses.join(', ')} WHERE id = $${keys.length + 1} AND org_id = $${keys.length + 2}
       RETURNING *`,
      [...values, req.params.id, req.orgId]
    );
    const after = rows[0];

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'pillar.update',
      recordType: 'content_pillar',
      recordId: after.id,
      before,
      after,
      req,
    });
    res.json({ pillar: after });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A pillar with that name already exists' });
    }
    next(err);
  }
});

router.post('/:id/archive', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE content_pillars SET archived_at = now() WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
       RETURNING *`,
      [req.params.id, req.orgId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'pillar.archive',
      recordType: 'content_pillar',
      recordId: rows[0].id,
      before: null,
      after: rows[0],
      req,
    });
    res.json({ pillar: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/restore', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE content_pillars SET archived_at = NULL WHERE id = $1 AND org_id = $2
       RETURNING *`,
      [req.params.id, req.orgId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ pillar: rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
