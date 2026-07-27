import { Router } from 'express';
import archiver from 'archiver';
import { query, getPool } from '../lib/db.js';
import { requireOwner } from '../lib/auth-middleware.js';
import { createSignedUrl } from '../lib/storage.js';
import { writeAudit } from '../lib/audit.js';

const CSV_COLUMNS = [
  'title', 'status', 'pillar_name', 'campaign', 'platforms', 'caption_main',
  'hashtags', 'cta', 'link_url', 'planned_date', 'planned_time',
  'published_at', 'published_urls', 'is_evergreen', 'created_at',
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = Array.isArray(value) ? value.join('|') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const router = Router();

router.get('/posts.csv', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, c.name AS pillar_name FROM posts p
       LEFT JOIN content_pillars c ON c.id = p.pillar_id
       WHERE p.org_id = $1 AND p.archived_at IS NULL
       ORDER BY p.created_at DESC`,
      [req.orgId]
    );

    const lines = [CSV_COLUMNS.join(',')];
    for (const row of rows) {
      lines.push(CSV_COLUMNS.map((col) => csvEscape(row[col])).join(','));
    }
    const csv = lines.join('\r\n');

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'export.posts_csv',
      recordType: 'org',
      recordId: req.orgId,
      before: null,
      after: { row_count: rows.length },
      req,
    });

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="posts-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/posts/:id/package.zip', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const post = rows[0];

    const { rows: mediaRows } = await query(
      `SELECT m.* FROM post_media pm JOIN media_assets m ON m.id = pm.media_id
       WHERE pm.post_id = $1 ORDER BY pm.sort_order`,
      [req.params.id]
    );

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="post-${post.id}-package.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => next(err));
    archive.pipe(res);

    const platforms = post.platforms && post.platforms.length > 0 ? post.platforms : ['default'];
    for (const platformKey of platforms) {
      const caption = (post.caption_overrides && post.caption_overrides[platformKey]) || post.caption_main || '';
      const parts = [caption, post.hashtags, post.link_url].filter(Boolean);
      archive.append(parts.join('\n\n'), { name: `caption-${platformKey}.txt` });
    }

    for (const media of mediaRows) {
      const signedUrl = await createSignedUrl(media.object_path);
      const fileRes = await fetch(signedUrl);
      if (fileRes.ok) {
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        archive.append(buffer, { name: `media/${media.file_name}` });
      }
    }

    await archive.finalize();

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'export.post_package',
      recordType: 'post',
      recordId: post.id,
      before: null,
      after: { media_count: mediaRows.length },
      req,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
