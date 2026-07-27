import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';

process.env.NODE_ENV = 'test';

let pool;
let writeAudit;

test.before(async () => {
  await setupTestDatabase();
  const dbModule = await import('../../src/lib/db.js');
  pool = dbModule.getPool();
  ({ writeAudit } = await import('../../src/lib/audit.js'));
});

test.after(async () => {
  await pool.end();
  await teardownTestDatabase();
});

test.beforeEach(async () => {
  await resetTestData(pool);
});

test('writeAudit records actor, action, before/after, and session metadata', async () => {
  const { rows: orgRows } = await pool.query(
    "INSERT INTO organizations (name) VALUES ('Test Org') RETURNING id"
  );
  const orgId = orgRows[0].id;
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ('a@example.com', 'x', 'A') RETURNING id`
  );
  const userId = userRows[0].id;

  await writeAudit(pool, {
    orgId,
    actorId: userId,
    action: 'post.create',
    recordType: 'post',
    recordId: 'abc-123',
    before: null,
    after: { title: 'New idea' },
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } },
  });

  const { rows } = await pool.query('SELECT * FROM audit_log WHERE org_id = $1', [orgId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'post.create');
  assert.equal(rows[0].record_type, 'post');
  assert.equal(rows[0].record_id, 'abc-123');
  assert.equal(rows[0].after.title, 'New idea');
  assert.equal(rows[0].session_meta.ip, '127.0.0.1');
});

test('writeAudit works inside a transaction client', async () => {
  const { withTransaction } = await import('../../src/lib/db.js');
  const { rows: orgRows } = await pool.query(
    "INSERT INTO organizations (name) VALUES ('Test Org 2') RETURNING id"
  );
  const orgId = orgRows[0].id;

  await withTransaction(async (client) => {
    await writeAudit(client, {
      orgId,
      actorId: null,
      action: 'settings.update',
      recordType: 'brand_settings',
      recordId: orgId,
      before: { tone: 'old' },
      after: { tone: 'new' },
    });
  });

  const { rows } = await pool.query(
    "SELECT * FROM audit_log WHERE org_id = $1 AND action = 'settings.update'",
    [orgId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].before.tone, 'old');
});
