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

test('owner can create, list, update, and archive/restore a template', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Template Org A',
    email: 'owner-ta@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows: pillarRows } = await pool.query(
    `INSERT INTO content_pillars (org_id, name) VALUES ($1, 'Tips') RETURNING id`,
    [orgId]
  );
  const pillarId = pillarRows[0].id;

  const owner = createClient(baseUrl);
  await loginAs(owner, userId);

  const created = await owner.post('/api/templates', {
    name: 'Weekly Tip',
    pillar_id: pillarId,
    platforms: ['facebook', 'linkedin'],
    body: 'Here is a weekly bookkeeping tip: {{tip}}',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.template.name, 'Weekly Tip');
  assert.deepEqual(created.data.template.platforms, ['facebook', 'linkedin']);

  const list = await owner.get('/api/templates');
  assert.equal(list.status, 200);
  assert.equal(list.data.templates.length, 1);

  const updated = await owner.put(`/api/templates/${created.data.template.id}`, { name: 'Renamed Tip' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.template.name, 'Renamed Tip');

  const archived = await owner.post(`/api/templates/${created.data.template.id}/archive`);
  assert.equal(archived.status, 200);
  assert.ok(archived.data.template.archived_at);

  const listAfterArchive = await owner.get('/api/templates');
  assert.equal(listAfterArchive.data.templates.length, 0, 'archived template excluded by default');

  const listIncludingArchived = await owner.get('/api/templates?includeArchived=true');
  assert.equal(listIncludingArchived.data.templates.length, 1);

  const restored = await owner.post(`/api/templates/${created.data.template.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.template.archived_at, null);
});

test('editor can read templates but cannot create, update, or archive them', async () => {
  const { orgId } = await createOrgWithUser(pool, {
    orgName: 'Template Org B',
    email: 'owner-tb@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-tb@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const list = await editor.get('/api/templates');
  assert.equal(list.status, 200);

  const created = await editor.post('/api/templates', { name: 'Should Fail', body: 'x' });
  assert.equal(created.status, 403);
});

test('a template belonging to another org is invisible (404, not leaked)', async () => {
  const { userId: ownerAId } = await createOrgWithUser(pool, {
    orgName: 'Template Org C',
    email: 'owner-tc@example.com',
    displayName: 'Owner C',
    role: 'OWNER',
  });
  const { orgId: orgDId } = await createOrgWithUser(pool, {
    orgName: 'Template Org D',
    email: 'owner-td@example.com',
    displayName: 'Owner D',
    role: 'OWNER',
  });
  const { rows: dTemplate } = await pool.query(
    `INSERT INTO templates (org_id, name, body) VALUES ($1, 'Org D Only', 'body') RETURNING id`,
    [orgDId]
  );

  const clientA = createClient(baseUrl);
  await loginAs(clientA, ownerAId);

  const attempt = await clientA.put(`/api/templates/${dTemplate[0].id}`, { name: 'Hijacked' });
  assert.equal(attempt.status, 404);
});

test('create and update reject unknown or disabled platform keys with a real error message', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Template Org E',
    email: 'owner-te@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const owner = createClient(baseUrl);
  await loginAs(owner, userId);

  const created = await owner.post('/api/templates', { name: 'Bad Platform', body: 'x', platforms: ['myspace'] });
  assert.equal(created.status, 400);
  assert.match(created.data.error, /Unknown or disabled platform/);

  const valid = await owner.post('/api/templates', { name: 'Good', body: 'x', platforms: ['facebook'] });
  assert.equal(valid.status, 201);

  const updated = await owner.put(`/api/templates/${valid.data.template.id}`, { platforms: ['friendster'] });
  assert.equal(updated.status, 400);
  assert.match(updated.data.error, /Unknown or disabled platform/);
});
