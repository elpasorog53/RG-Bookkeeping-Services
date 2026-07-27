import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';
import { createOrgWithUser, loginAs } from '../helpers/fixtures.js';

process.env.NODE_ENV = 'test';

let server;
let baseUrl;
let pool;

test.before(async () => {
  await setupTestDatabase();
  const dbModule = await import('../../src/lib/db.js');
  pool = dbModule.getPool();
  const { default: app } = await import('../../src/index.js');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await teardownTestDatabase();
});

test.beforeEach(async () => {
  await resetTestData(pool);
});

test('audit log is Owner-only and reflects real mutations with the actor name', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Audit Org',
    email: 'owner-audit@example.com',
    displayName: 'Jeremy',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-audit@example.com', 'x', 'Roger', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const editorAttempt = await editor.get('/api/audit');
  assert.equal(editorAttempt.status, 403);

  await owner.post('/api/posts', { title: 'Traceable idea' });

  const list = await owner.get('/api/audit');
  assert.equal(list.status, 200);
  assert.ok(list.data.entries.length >= 1);
  const createEntry = list.data.entries.find((e) => e.action === 'post.create');
  assert.ok(createEntry);
  assert.equal(createEntry.actor_name, 'Jeremy');
});
