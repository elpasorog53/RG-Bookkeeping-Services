import { Router } from 'express';
import { query } from '../lib/db.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, name, timezone FROM organizations WHERE id = $1', [req.orgId]);
    res.json({
      user: req.user,
      org: rows[0] || null,
      role: req.orgRole,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
