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

// createdAtExpr is a raw SQL expression (e.g. "now() - interval '5 days'"),
// not a bound parameter -- needed to backdate created_at for window tests.
// Safe here: fixed test-authored strings, never user input.
async function insertPost(pool, orgId, { title, pillarId = null, captionMain = null, createdAtExpr = 'now()' }) {
  const { rows } = await pool.query(
    `INSERT INTO posts (org_id, title, status, pillar_id, caption_main, created_at)
     VALUES ($1, $2, 'draft', $3, $4, ${createdAtExpr})
     RETURNING id`,
    [orgId, title, pillarId, captionMain]
  );
  return rows[0].id;
}

test('flags another post using the same pillar within the last 14 days, excludes ones older than that', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Repetition Org A',
    email: 'owner-repa@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows: pillarRows } = await pool.query(
    `INSERT INTO content_pillars (org_id, name) VALUES ($1, 'Tax Tips') RETURNING id`,
    [orgId]
  );
  const pillarId = pillarRows[0].id;

  const recentId = await insertPost(pool, orgId, {
    title: 'Recent tax tip',
    pillarId,
    createdAtExpr: `now() - interval '5 days'`,
  });
  await insertPost(pool, orgId, {
    title: 'Old tax tip',
    pillarId,
    createdAtExpr: `now() - interval '30 days'`,
  });

  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.post('/api/posts/repetition-check', { pillar_id: pillarId });
  assert.equal(res.status, 200);
  assert.equal(res.data.pillarRepeats.length, 1);
  assert.equal(res.data.pillarRepeats[0].id, recentId);
});

test('excludes the post itself from its own pillar-repeat results via post_id', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Repetition Org B',
    email: 'owner-repb@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows: pillarRows } = await pool.query(
    `INSERT INTO content_pillars (org_id, name) VALUES ($1, 'Tips') RETURNING id`,
    [orgId]
  );
  const pillarId = pillarRows[0].id;
  const selfId = await insertPost(pool, orgId, { title: 'This post', pillarId });

  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const withoutExclusion = await client.post('/api/posts/repetition-check', { pillar_id: pillarId });
  assert.equal(withoutExclusion.data.pillarRepeats.length, 1);

  const withExclusion = await client.post('/api/posts/repetition-check', { pillar_id: pillarId, post_id: selfId });
  assert.equal(withExclusion.data.pillarRepeats.length, 0);
});

test('flags a near-duplicate caption within 90 days, and scores unrelated captions below threshold', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Repetition Org C',
    email: 'owner-repc@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const similarId = await insertPost(pool, orgId, {
    title: 'Old estimated tax reminder',
    captionMain: 'Reminder that quarterly estimated tax payments are due soon for small business owners.',
    createdAtExpr: `now() - interval '10 days'`,
  });
  await insertPost(pool, orgId, {
    title: 'Unrelated holiday post',
    captionMain: 'Happy holidays from our whole bookkeeping team to yours this season.',
    createdAtExpr: `now() - interval '10 days'`,
  });
  await insertPost(pool, orgId, {
    title: 'Too old to count',
    captionMain: 'Reminder that quarterly estimated tax payments are due soon for small business owners.',
    createdAtExpr: `now() - interval '120 days'`,
  });

  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.post('/api/posts/repetition-check', {
    caption_main: 'Reminder that quarterly estimated tax payments are due soon for every small business owner.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.similarCaptions.length, 1);
  assert.equal(res.data.similarCaptions[0].id, similarId);
  assert.ok(res.data.similarCaptions[0].similarity >= 0.5);
});

test('returns empty arrays without error when neither pillar_id nor caption_main is given', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Repetition Org D',
    email: 'owner-repd@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.post('/api/posts/repetition-check', {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.pillarRepeats, []);
  assert.deepEqual(res.data.similarCaptions, []);
});

test('never leaks another org\'s pillar or caption matches', async () => {
  const { orgId: orgEId, userId: ownerEId } = await createOrgWithUser(pool, {
    orgName: 'Repetition Org E',
    email: 'owner-repe@example.com',
    displayName: 'Owner E',
    role: 'OWNER',
  });
  const { orgId: orgFId } = await createOrgWithUser(pool, {
    orgName: 'Repetition Org F',
    email: 'owner-repf@example.com',
    displayName: 'Owner F',
    role: 'OWNER',
  });
  const { rows: pillarRows } = await pool.query(
    `INSERT INTO content_pillars (org_id, name) VALUES ($1, 'Shared Name') RETURNING id`,
    [orgFId]
  );
  const foreignPillarId = pillarRows[0].id;
  await insertPost(pool, orgFId, {
    title: 'Org F post',
    pillarId: foreignPillarId,
    captionMain: 'Reminder that quarterly estimated tax payments are due soon for small business owners.',
  });
  void orgEId;

  const client = createClient(baseUrl);
  await loginAs(client, ownerEId);

  const res = await client.post('/api/posts/repetition-check', {
    pillar_id: foreignPillarId,
    caption_main: 'Reminder that quarterly estimated tax payments are due soon for small business owners.',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.pillarRepeats, [], 'a foreign pillar_id should just match nothing in this org');
  assert.deepEqual(res.data.similarCaptions, [], 'similarity search is scoped to this org only');
});
