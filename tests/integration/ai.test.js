import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';
import { createOrgWithUser, loginAs } from '../helpers/fixtures.js';

process.env.NODE_ENV = 'test';
process.env.CONFIG_ENCRYPTION_KEY = '2'.repeat(64);

const realFetch = globalThis.fetch;
let mockMode = 'json-object';
let mockArrayCount = 3;

function draftPayload(overrides = {}) {
  return {
    caption: 'A friendly bookkeeping tip for small business owners.',
    hashtags: '#bookkeeping #smallbusiness',
    cta: 'Reach out to learn more',
    needsReview: false,
    reviewReason: null,
    disclaimerRequired: false,
    ...overrides,
  };
}

function mockFetch(url, options = {}) {
  if (String(url).startsWith('https://api.anthropic.com')) {
    if (mockMode === 'http-error') {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })
      );
    }
    let text;
    if (mockMode === 'json-array') {
      const arr = Array.from({ length: mockArrayCount }, (_, i) => draftPayload({ caption: `Variant ${i + 1}` }));
      text = JSON.stringify(arr);
    } else if (mockMode === 'garbage') {
      text = 'this is not json';
    } else if (mockMode === 'needs-review') {
      text = JSON.stringify(
        draftPayload({ needsReview: true, reviewReason: 'Mentions a specific deduction amount', disclaimerRequired: true })
      );
    } else {
      text = JSON.stringify(draftPayload());
    }
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ text }], usage: { input_tokens: 42, output_tokens: 17 } }), {
        status: 200,
      })
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
  mockMode = 'json-object';
  mockArrayCount = 3;
});

async function setupOrgWithKey(pool, orgName, emailPrefix) {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName,
    email: `${emailPrefix}-owner@example.com`,
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1, 'x', 'Editor', now()) RETURNING id`,
    [`${emailPrefix}-editor@example.com`]
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  await owner.put('/api/settings/ai-config', { apiKey: 'sk-ant-test-key-0123456789' });

  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  return { orgId, owner, editor };
}

test('draft returns a parsed caption/hashtags/cta, logs a generation row, and is usable by Editors too', async () => {
  const { orgId, owner, editor } = await setupOrgWithKey(pool, 'Draft Org', 'draft');

  const res = await editor.post('/api/ai/draft', {
    topic: 'Why quarterly bookkeeping check-ins matter',
    platforms: ['facebook', 'linkedin'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.draft.caption, draftPayload().caption);
  assert.equal(res.data.draft.hashtags, draftPayload().hashtags);
  assert.equal(res.data.draft.needsReview, false);
  assert.ok(res.data.generationId);

  const { rows } = await pool.query('SELECT * FROM ai_generations WHERE org_id = $1', [orgId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'draft');
  assert.equal(rows[0].input_tokens, 42);
  assert.equal(rows[0].output_tokens, 17);
  assert.equal(rows[0].accepted, null);

  void owner;
});

test('draft 400s with a clear message when AI is not configured', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Unconfigured Org',
    email: 'unconfigured@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.post('/api/ai/draft', { topic: 'anything', platforms: ['facebook'] });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /not configured/);
});

test('draft rejects unknown or disabled platform keys', async () => {
  const { editor } = await setupOrgWithKey(pool, 'Bad Platform Org', 'badplat');

  const res = await editor.post('/api/ai/draft', { topic: 'anything', platforms: ['myspace'] });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Unknown or disabled platform/);
});

test('the safety flags survive the round trip when the model flags a post for review', async () => {
  mockMode = 'needs-review';
  const { editor } = await setupOrgWithKey(pool, 'Flag Org', 'flag');

  const res = await editor.post('/api/ai/draft', {
    topic: 'How much can I deduct for a home office?',
    platforms: ['facebook'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.draft.needsReview, true);
  assert.equal(res.data.draft.disclaimerRequired, true);
  assert.match(res.data.draft.reviewReason, /deduction/);
});

test('rewrite returns an updated caption using the existing caption plus an instruction', async () => {
  const { editor } = await setupOrgWithKey(pool, 'Rewrite Org', 'rewrite');

  const res = await editor.post('/api/ai/rewrite', {
    caption: 'Original caption text',
    instruction: 'make it shorter and more casual',
    platforms: ['instagram'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.draft.caption, draftPayload().caption);
});

test('variants returns exactly the requested count, capped at 5 by schema', async () => {
  mockMode = 'json-array';
  mockArrayCount = 4;
  const { editor } = await setupOrgWithKey(pool, 'Variants Org', 'variants');

  const res = await editor.post('/api/ai/variants', { caption: 'Base caption', count: 4 });
  assert.equal(res.status, 200);
  assert.equal(res.data.variants.length, 4);
  assert.equal(res.data.variants[0].caption, 'Variant 1');

  const tooMany = await editor.post('/api/ai/variants', { caption: 'Base caption', count: 9 });
  assert.equal(tooMany.status, 400, 'count is capped at 5 by the schema, so 9 must be rejected');
});

test('a malformed AI response yields a 502 with a clear, non-crashing error', async () => {
  mockMode = 'garbage';
  const { editor } = await setupOrgWithKey(pool, 'Garbage Org', 'garbage');

  const res = await editor.post('/api/ai/draft', { topic: 'anything', platforms: ['facebook'] });
  assert.equal(res.status, 502);
  assert.match(res.data.error, /could not be parsed/);
});

test('an invalid API key surfaces the Anthropic error message via 502, not a 500', async () => {
  mockMode = 'http-error';
  const { editor } = await setupOrgWithKey(pool, 'Invalid Key Org', 'invalidkey');

  const res = await editor.post('/api/ai/draft', { topic: 'anything', platforms: ['facebook'] });
  assert.equal(res.status, 502);
  assert.match(res.data.error, /invalid x-api-key/);
});

test('accepting a generation marks it accepted, and a generation from another org 404s', async () => {
  const { editor } = await setupOrgWithKey(pool, 'Accept Org', 'accept');
  const { editor: otherEditor } = await setupOrgWithKey(pool, 'Other Accept Org', 'otheraccept');

  const draft = await editor.post('/api/ai/draft', { topic: 'anything', platforms: ['facebook'] });
  const generationId = draft.data.generationId;

  const crossOrgAttempt = await otherEditor.post(`/api/ai/generations/${generationId}/accept`);
  assert.equal(crossOrgAttempt.status, 404);

  const accept = await editor.post(`/api/ai/generations/${generationId}/accept`);
  assert.equal(accept.status, 200);

  const { rows } = await pool.query('SELECT accepted FROM ai_generations WHERE id = $1', [generationId]);
  assert.equal(rows[0].accepted, true);
});

test('a non-numeric generation id 404s instead of erroring', async () => {
  const { editor } = await setupOrgWithKey(pool, 'Bad Id Org', 'badid');
  const res = await editor.post('/api/ai/generations/not-a-number/accept');
  assert.equal(res.status, 404);
});
