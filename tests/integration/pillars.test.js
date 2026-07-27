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

test('owner can list, create, update, and archive a pillar', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Org A',
    email: 'owner-a@example.com',
    displayName: 'Owner A',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const list = await client.get('/api/pillars');
  assert.equal(list.status, 200);
  assert.equal(list.data.pillars.length, 6);

  const created = await client.post('/api/pillars', { name: 'Custom Pillar', requires_review: true });
  assert.equal(created.status, 201);
  assert.equal(created.data.pillar.requires_review, true);

  const updated = await client.put(`/api/pillars/${created.data.pillar.id}`, { name: 'Renamed Pillar' });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.pillar.name, 'Renamed Pillar');

  const archived = await client.post(`/api/pillars/${created.data.pillar.id}/archive`);
  assert.equal(archived.status, 200);
  assert.ok(archived.data.pillar.archived_at);

  const listAfterArchive = await client.get('/api/pillars');
  assert.equal(listAfterArchive.data.pillars.length, 6, 'archived pillar excluded by default');

  const listIncludingArchived = await client.get('/api/pillars?includeArchived=true');
  assert.equal(listIncludingArchived.data.pillars.length, 7);
});

test('editor can read pillars but cannot create, update, or archive them', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Org B',
    email: 'owner-b@example.com',
    displayName: 'Owner B',
    role: 'OWNER',
  });
  void ownerId;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-b@example.com', 'x', 'Editor B', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [
    orgId,
    editorId,
  ]);

  const client = createClient(baseUrl);
  await loginAs(client, editorId);

  const list = await client.get('/api/pillars');
  assert.equal(list.status, 200);

  const created = await client.post('/api/pillars', { name: 'Should Fail' });
  assert.equal(created.status, 403);
});

test('a pillar belonging to another org is invisible (404, not leaked)', async () => {
  const { userId: ownerAId } = await createOrgWithUser(pool, {
    orgName: 'Org C',
    email: 'owner-c@example.com',
    displayName: 'Owner C',
    role: 'OWNER',
  });
  const { orgId: orgDId } = await createOrgWithUser(pool, {
    orgName: 'Org D',
    email: 'owner-d@example.com',
    displayName: 'Owner D',
    role: 'OWNER',
  });

  const { rows: dPillar } = await pool.query(
    `INSERT INTO content_pillars (org_id, name) VALUES ($1, 'Org D Only Pillar') RETURNING id`,
    [orgDId]
  );

  const clientA = createClient(baseUrl);
  await loginAs(clientA, ownerAId);

  const attempt = await clientA.put(`/api/pillars/${dPillar[0].id}`, { name: 'Hijacked' });
  assert.equal(attempt.status, 404);
});
