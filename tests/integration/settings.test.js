import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';
import { createOrgWithUser, loginAs } from '../helpers/fixtures.js';

process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';

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
  const { __resetRateLimits } = await import('../../src/lib/rate-limit.js');
  __resetRateLimits();
});

test('owner can read and update brand settings; editor gets 403 on write', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'RG Bookkeeping Services',
    email: 'owner@example.com',
    displayName: 'Jeremy',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor@example.com', 'x', 'Roger', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [
    orgId,
    editorId,
  ]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);

  const get1 = await owner.get('/api/settings/brand');
  assert.equal(get1.status, 200);
  assert.equal(get1.data.brandSettings.business_name, 'RG Bookkeeping Services');

  const update = await owner.put('/api/settings/brand', {
    tone: 'warm, plain-spoken, no jargon',
    website_url: 'https://example.com',
  });
  assert.equal(update.status, 200);
  assert.equal(update.data.brandSettings.tone, 'warm, plain-spoken, no jargon');

  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const editorRead = await editor.get('/api/settings/brand');
  assert.equal(editorRead.status, 200, 'editor can read brand settings');

  const editorWrite = await editor.put('/api/settings/brand', { tone: 'should fail' });
  assert.equal(editorWrite.status, 403);
});

test('platforms are readable by anyone authenticated and editable only by owner', async () => {
  const { userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Org P',
    email: 'owner-p@example.com',
    displayName: 'Owner P',
    role: 'OWNER',
  });
  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);

  const list = await owner.get('/api/settings/platforms');
  assert.equal(list.status, 200);
  assert.equal(list.data.platforms.length, 4);
  assert.equal(list.data.platforms[0].key, 'facebook');
  assert.equal(list.data.platforms[1].key, 'linkedin', 'linkedin outranks instagram per stated priority');

  const update = await owner.put('/api/settings/platforms/instagram', { char_soft_limit: 150 });
  assert.equal(update.status, 200);
  assert.equal(update.data.platform.char_soft_limit, 150);
});

test('owner can invite an editor, who can then log in after setting a password', async () => {
  const { userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Org I',
    email: 'owner-i@example.com',
    displayName: 'Owner I',
    role: 'OWNER',
  });
  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);

  const invite = await owner.post('/api/settings/users/invite', {
    email: 'roger@example.com',
    displayName: 'Roger Guzman',
    role: 'EDITOR',
  });
  assert.equal(invite.status, 201);

  const usersList = await owner.get('/api/settings/users');
  assert.equal(usersList.status, 200);
  assert.equal(usersList.data.users.length, 2);

  const { getLastSimulatedMail } = await import('../../src/lib/mailer.js');
  const mail = getLastSimulatedMail();
  const match = mail.text.match(/token=([a-f0-9]+)/);
  assert.ok(match);
  const inviteToken = match[1];

  const setPassword = await owner.post('/api/auth/reset-password', {
    token: inviteToken,
    newPassword: 'rogers-new-password',
  });
  assert.equal(setPassword.status, 200);

  const editorLogin = createClient(baseUrl);
  const login = await editorLogin.post('/api/auth/login', {
    email: 'roger@example.com',
    password: 'rogers-new-password',
  });
  assert.equal(login.status, 200);
});

test('a deactivated user can no longer authenticate', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Org Deact',
    email: 'owner-deact@example.com',
    displayName: 'Owner Deact',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('gone@example.com', 'x', 'Gone', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [
    orgId,
    editorId,
  ]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);

  const editorClient = createClient(baseUrl);
  await loginAs(editorClient, editorId);
  const before = await editorClient.get('/api/pillars');
  assert.equal(before.status, 200);

  const deactivate = await owner.post(`/api/settings/users/${editorId}/deactivate`);
  assert.equal(deactivate.status, 200);

  const after = await editorClient.get('/api/pillars');
  assert.equal(after.status, 401, 'deactivation should revoke the existing session');
});
