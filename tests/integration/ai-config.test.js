import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';
import { createOrgWithUser, loginAs } from '../helpers/fixtures.js';

process.env.NODE_ENV = 'test';
process.env.CONFIG_ENCRYPTION_KEY = '1'.repeat(64);

const realFetch = globalThis.fetch;
let mockAnthropicOk = true;

function mockFetch(url, options = {}) {
  if (String(url).startsWith('https://api.anthropic.com')) {
    if (mockAnthropicOk) {
      return Promise.resolve(new Response(JSON.stringify({ content: [{ text: 'OK' }] }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })
    );
  }
  return realFetch(url, options);
}

let server;
let baseUrl;
let pool;

test.before(async () => {
  globalThis.fetch = mockFetch;
  await setupTestDatabase();
  const dbModule = await import('../../src/lib/db.js');
  pool = dbModule.getPool();
  const { default: app } = await import('../../src/index.js');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await teardownTestDatabase();
});

test.beforeEach(async () => {
  await resetTestData(pool);
  await pool.query('DELETE FROM app_config');
  mockAnthropicOk = true;
});

test('AI config starts unconfigured, Editor cannot set it, Owner can, and the raw key is never returned', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'AI Org',
    email: 'owner-ai@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-ai@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const initial = await editor.get('/api/settings/ai-config');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.configured, false);

  const editorAttempt = await editor.put('/api/settings/ai-config', { apiKey: 'sk-ant-should-fail' });
  assert.equal(editorAttempt.status, 403);

  const ownerSet = await owner.put('/api/settings/ai-config', { apiKey: 'sk-ant-real-looking-key-0123456789' });
  assert.equal(ownerSet.status, 200);
  assert.equal(ownerSet.data.configured, true);
  assert.equal(JSON.stringify(ownerSet.data).includes('sk-ant-real-looking-key-0123456789'), false);

  const afterSet = await editor.get('/api/settings/ai-config');
  assert.equal(afterSet.data.configured, true);

  const { rows: configRows } = await pool.query('SELECT encrypted_value FROM app_config WHERE key = $1', [
    'ANTHROPIC_API_KEY',
  ]);
  assert.equal(configRows.length, 1);
  assert.notEqual(configRows[0].encrypted_value, 'sk-ant-real-looking-key-0123456789', 'must be stored encrypted, not plaintext');
});

test('the test-connection endpoint reports success or failure without ever echoing the key, and is Owner-only', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'AI Org 2',
    email: 'owner-ai2@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-ai2@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const noKeyYet = await owner.post('/api/settings/ai-config/test');
  assert.equal(noKeyYet.status, 400);

  await owner.put('/api/settings/ai-config', { apiKey: 'sk-ant-real-looking-key-0123456789' });

  const editorAttempt = await editor.post('/api/settings/ai-config/test');
  assert.equal(editorAttempt.status, 403);

  mockAnthropicOk = true;
  const success = await owner.post('/api/settings/ai-config/test');
  assert.equal(success.status, 200);
  assert.equal(success.data.ok, true);

  mockAnthropicOk = false;
  const failure = await owner.post('/api/settings/ai-config/test');
  assert.equal(failure.status, 200);
  assert.equal(failure.data.ok, false);
  assert.match(failure.data.error, /invalid x-api-key/);
});

test('deleting the key reverts configured to false, Owner-only', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'AI Org 3',
    email: 'owner-ai3@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-ai3@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  await owner.post('/api/posts', { title: 'noop' }); // just to exercise a normal write first
  await owner.put('/api/settings/ai-config', { apiKey: 'sk-ant-real-looking-key-0123456789' });

  const editorAttempt = await editor.del('/api/settings/ai-config');
  assert.equal(editorAttempt.status, 403);

  const del = await owner.del('/api/settings/ai-config');
  assert.equal(del.status, 200);
  assert.equal(del.data.configured, false);

  const after = await owner.get('/api/settings/ai-config');
  assert.equal(after.data.configured, false);
});

test('getConfig falls back to the env var when no app_config row exists, and app_config wins when both exist', async () => {
  const configModule = await import('../../src/lib/config.js');
  process.env.SOME_TEST_KEY = 'from-env';
  assert.equal(await configModule.getConfig('SOME_TEST_KEY'), 'from-env');

  await configModule.setConfig('SOME_TEST_KEY', 'from-app-config');
  assert.equal(await configModule.getConfig('SOME_TEST_KEY'), 'from-app-config');

  delete process.env.SOME_TEST_KEY;
});
