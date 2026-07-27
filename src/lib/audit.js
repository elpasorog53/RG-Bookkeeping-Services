// Every mutating route writes one of these (section 18/34 criterion 14).
// `db` is whatever has a .query() method: the pool for a standalone write,
// or a transaction client when the audit row must land atomically with the
// mutation it describes.
export async function writeAudit(db, { orgId, actorId, action, recordType, recordId, before, after, req }) {
  const sessionMeta = req ? { ip: req.ip, userAgent: req.headers['user-agent'] || null } : null;
  await db.query(
    `INSERT INTO audit_log (org_id, actor_id, action, record_type, record_id, before, after, session_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orgId,
      actorId,
      action,
      recordType,
      String(recordId),
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      sessionMeta ? JSON.stringify(sessionMeta) : null,
    ]
  );
}
