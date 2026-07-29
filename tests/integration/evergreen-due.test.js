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

// publishedAtExpr/lastReusedAtExpr/archivedAtExpr are raw SQL expressions
// (e.g. "now() - interval '40 days'" or "NULL"), not parameters -- they need
// to be evaluated by Postgres, not bound as literal timestamp strings. Safe
// here since these are fixed test-authored strings, never user input.
async function insertPost(pool, orgId, overrides = {}) {
  const defaults = {
    title: 'Evergreen tip',
    status: 'published',
    is_evergreen: true,
    reuse_interval_days: 30,
    publishedAtExpr: 'now()',
    lastReusedAtExpr: 'NULL',
    archivedAtExpr: 'NULL',
  };
  const p = { ...defaults, ...overrides };
  const { rows } = await pool.query(
    `INSERT INTO posts (org_id, title, status, is_evergreen, reuse_interval_days, published_at, last_reused_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, ${p.publishedAtExpr}, ${p.lastReusedAtExpr}, ${p.archivedAtExpr})
     RETURNING id`,
    [orgId, p.title, p.status, p.is_evergreen, p.reuse_interval_days]
  );
  return rows[0].id;
}

test('a published evergreen post whose interval has elapsed since published_at is due', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Evergreen Org A',
    email: 'owner-ea@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const dueId = await insertPost(pool, orgId, {
    title: 'Due post',
    publishedAtExpr: `now() - interval '40 days'`,
    reuse_interval_days: 30,
  });
  const notDueId = await insertPost(pool, orgId, {
    title: 'Not due yet',
    publishedAtExpr: `now() - interval '10 days'`,
    reuse_interval_days: 30,
  });
  void notDueId;

  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.get('/api/posts/evergreen/due');
  assert.equal(res.status, 200);
  assert.equal(res.data.posts.length, 1);
  assert.equal(res.data.posts[0].id, dueId);
});

test('last_reused_at takes precedence over published_at as the anchor', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Evergreen Org B',
    email: 'owner-eb@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  // Published long ago, but reused recently -- should NOT be due.
  await insertPost(pool, orgId, {
    publishedAtExpr: `now() - interval '400 days'`,
    lastReusedAtExpr: `now() - interval '5 days'`,
    reuse_interval_days: 30,
  });

  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.get('/api/posts/evergreen/due');
  assert.equal(res.data.posts.length, 0);
});

test('non-evergreen posts, posts without a reuse interval, wrong status, and archived posts are all excluded', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Evergreen Org C',
    email: 'owner-ec@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  await insertPost(pool, orgId, {
    title: 'Not evergreen',
    is_evergreen: false,
    publishedAtExpr: `now() - interval '90 days'`,
  });
  await insertPost(pool, orgId, {
    title: 'No interval set',
    reuse_interval_days: null,
    publishedAtExpr: `now() - interval '90 days'`,
  });
  await insertPost(pool, orgId, {
    title: 'Still a draft',
    status: 'draft',
    publishedAtExpr: 'NULL',
  });
  const archivedId = await insertPost(pool, orgId, {
    title: 'Archived but overdue',
    publishedAtExpr: `now() - interval '90 days'`,
    archivedAtExpr: `now()`,
  });
  void archivedId;

  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.get('/api/posts/evergreen/due');
  assert.equal(res.data.posts.length, 0);
});

test('skipped posts qualify too, and results are ordered most-overdue first', async () => {
  const { orgId, userId } = await createOrgWithUser(pool, {
    orgName: 'Evergreen Org D',
    email: 'owner-ed@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const mostOverdueId = await insertPost(pool, orgId, {
    title: 'Skipped, very overdue',
    status: 'skipped',
    publishedAtExpr: `now() - interval '200 days'`,
    reuse_interval_days: 14,
  });
  const lessOverdueId = await insertPost(pool, orgId, {
    title: 'Published, barely overdue',
    status: 'published',
    publishedAtExpr: `now() - interval '31 days'`,
    reuse_interval_days: 30,
  });

  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const res = await client.get('/api/posts/evergreen/due');
  assert.equal(res.data.posts.length, 2);
  assert.equal(res.data.posts[0].id, mostOverdueId);
  assert.equal(res.data.posts[1].id, lessOverdueId);
});

test('another org\'s evergreen-due posts never leak into this org\'s list', async () => {
  const { orgId: orgAId, userId: ownerAId } = await createOrgWithUser(pool, {
    orgName: 'Evergreen Org E',
    email: 'owner-ee@example.com',
    displayName: 'Owner E',
    role: 'OWNER',
  });
  const { orgId: orgFId } = await createOrgWithUser(pool, {
    orgName: 'Evergreen Org F',
    email: 'owner-ef@example.com',
    displayName: 'Owner F',
    role: 'OWNER',
  });
  await insertPost(pool, orgFId, { publishedAtExpr: `now() - interval '90 days'` });
  void orgAId;

  const client = createClient(baseUrl);
  await loginAs(client, ownerAId);

  const res = await client.get('/api/posts/evergreen/due');
  assert.equal(res.data.posts.length, 0);
});
