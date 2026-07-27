import { Router } from 'express';
import { query } from '../lib/db.js';
import { requireOwner } from '../lib/auth-middleware.js';

const router = Router();

router.get('/', requireOwner, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await query(
      `SELECT a.*, u.display_name AS actor_name FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.org_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [req.orgId, limit]
    );
    res.json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
