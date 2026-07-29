import { Router } from 'express';
import { query } from '../lib/db.js';
import { buildCalendarFeed } from '../lib/ics.js';

const router = Router();

// Public by design: calendar apps poll this by plain HTTP GET with no
// session, so the token in the URL itself is the only gate (see migration
// 002). Only scheduled posts with a confirmed date/time are included --
// that's the "this is really happening, don't forget it" set.
router.get('/:token.ics', async (req, res, next) => {
  try {
    const { rows: orgRows } = await query(
      'SELECT id, name, timezone FROM organizations WHERE calendar_feed_token = $1',
      [req.params.token]
    );
    if (orgRows.length === 0) return res.status(404).send('Not found');
    const org = orgRows[0];

    const { rows: posts } = await query(
      `SELECT id, title, caption_main, platforms, planned_date, planned_time, updated_at
       FROM posts
       WHERE org_id = $1 AND status = 'scheduled' AND planned_date IS NOT NULL AND planned_time IS NOT NULL
         AND archived_at IS NULL
       ORDER BY planned_date, planned_time`,
      [org.id]
    );

    const ics = buildCalendarFeed({ orgName: org.name, timezone: org.timezone, posts });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Disposition', 'inline; filename="rg-social-planner.ics"');
    res.send(ics);
  } catch (err) {
    next(err);
  }
});

export default router;
