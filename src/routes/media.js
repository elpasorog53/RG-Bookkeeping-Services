import { Router } from 'express';
import multer from 'multer';
import { query, getPool, withTransaction } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';
import { requireOwner } from '../lib/auth-middleware.js';
import {
  buildObjectPath,
  uploadObject,
  createSignedUrl,
  deleteObjects,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from '../lib/storage.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

const router = Router();

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds the 25MB limit' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}

router.post('/upload', handleUpload, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
      return res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}` });
    }

    const kind = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const objectPath = buildObjectPath(req.orgId, req.file.originalname);

    await uploadObject(objectPath, req.file.buffer, req.file.mimetype);

    const media = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO media_assets (org_id, object_path, file_name, mime_type, byte_size, kind, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.orgId, objectPath, req.file.originalname, req.file.mimetype, req.file.size, kind, req.user.id]
      );
      const asset = rows[0];

      if (req.body.post_id) {
        const { rows: postRows } = await client.query('SELECT id FROM posts WHERE id = $1 AND org_id = $2', [
          req.body.post_id,
          req.orgId,
        ]);
        if (postRows.length === 0) {
          const err = new Error('Post not found');
          err.status = 404;
          throw err;
        }
        const { rows: maxRows } = await client.query(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM post_media WHERE post_id = $1',
          [req.body.post_id]
        );
        await client.query('INSERT INTO post_media (post_id, media_id, sort_order) VALUES ($1, $2, $3)', [
          req.body.post_id,
          asset.id,
          maxRows[0].next,
        ]);
      }

      return asset;
    });

    const signedUrl = await createSignedUrl(media.object_path);

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'media.upload',
      recordType: 'media_asset',
      recordId: media.id,
      before: null,
      after: { file_name: media.file_name, kind: media.kind, byte_size: media.byte_size },
      req,
    });

    res.status(201).json({ media, signedUrl });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM media_assets WHERE org_id = $1 AND archived_at IS NULL ORDER BY created_at DESC',
      [req.orgId]
    );
    const media = await Promise.all(
      rows.map(async (asset) => ({ ...asset, signedUrl: await createSignedUrl(asset.object_path) }))
    );
    res.json({ media });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM media_assets WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const asset = rows[0];

    await withTransaction(async (client) => {
      await client.query('DELETE FROM post_media WHERE media_id = $1', [asset.id]);
      await client.query('DELETE FROM media_assets WHERE id = $1', [asset.id]);
    });
    await deleteObjects([asset.object_path]);

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'media.delete',
      recordType: 'media_asset',
      recordId: asset.id,
      before: { file_name: asset.file_name },
      after: null,
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
