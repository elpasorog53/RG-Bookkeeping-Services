import { Router } from 'express';
import { z } from 'zod';
import { query, getPool } from '../lib/db.js';
import { validateBody } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { requireOwner } from '../lib/auth-middleware.js';

const templateSchema = z.object({
  name: z.string().min(1).max(200),
  pillar_id: z.string().uuid().optional().nullable(),
  body: z.string().min(1).max(10000),
  platforms: z.array(z.string()).optional().default([]),
});

const templateUpdateSchema = templateSchema.partial();

const router = Router();

// Returns the invalid keys (empty if all valid) rather than throwing -- the
// generic error handler in index.js discards a thrown error's message, so
// each route checks this list itself and writes its own 400 response.
async function invalidPlatformKeys(platforms) {
  if (!platforms || platforms.length === 0) return [];
  const { rows } = await query('SELECT key FROM platforms WHERE is_enabled = true');
  const valid = new Set(rows.map((r) => r.key));
  return platforms.filter((p) => !valid.has(p));
}

router.get('/', async (req, res, next) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const { rows } = await query(
      `SELECT * FROM templates WHERE org_id = $1 ${includeArchived ? '' : 'AND archived_at IS NULL'}
       ORDER BY name`,
      [req.orgId]
    );
    res.json({ templates: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireOwner, validateBody(templateSchema), async (req, res, next) => {
  try {
    const invalid = await invalidPlatformKeys(req.body.platforms);
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Unknown or disabled platform(s): ${invalid.join(', ')}` });
    }

    const { name, pillar_id, body, platforms } = req.body;
    const { rows } = await query(
      `INSERT INTO templates (org_id, name, pillar_id, body, platforms)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.orgId, name, pillar_id ?? null, body, platforms]
    );
    const template = rows[0];
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'template.create',
      recordType: 'template',
      recordId: template.id,
      before: null,
      after: template,
      req,
    });
    res.status(201).json({ template });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireOwner, validateBody(templateUpdateSchema), async (req, res, next) => {
  try {
    const { rows: existingRows } = await query('SELECT * FROM templates WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = existingRows[0];

    if (req.body.platforms) {
      const invalid = await invalidPlatformKeys(req.body.platforms);
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Unknown or disabled platform(s): ${invalid.join(', ')}` });
      }
    }

    const fields = req.body;
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.json({ template: before });

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    const { rows } = await query(
      `UPDATE templates SET ${setClauses.join(', ')} WHERE id = $${keys.length + 1} AND org_id = $${keys.length + 2}
       RETURNING *`,
      [...values, req.params.id, req.orgId]
    );
    const after = rows[0];

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'template.update',
      recordType: 'template',
      recordId: after.id,
      before,
      after,
      req,
    });
    res.json({ template: after });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/archive', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE templates SET archived_at = now() WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
       RETURNING *`,
      [req.params.id, req.orgId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'template.archive',
      recordType: 'template',
      recordId: rows[0].id,
      before: null,
      after: rows[0],
      req,
    });
    res.json({ template: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/restore', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE templates SET archived_at = NULL WHERE id = $1 AND org_id = $2
       RETURNING *`,
      [req.params.id, req.orgId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ template: rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
