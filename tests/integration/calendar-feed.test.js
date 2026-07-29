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
});

test('feed URL is created lazily on first request and stays stable after', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Feed Org',
    email: 'feed@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const first = await client.get('/api/settings/calendar-feed-url');
  assert.equal(first.status, 200);
  assert.match(first.data.feedUrl, /\/api\/calendar-feed\/[a-f0-9]+\.ics$/);

  const second = await client.get('/api/settings/calendar-feed-url');
  assert.equal(second.data.feedUrl, first.data.feedUrl, 'the token should not change between requests');
});

test('the .ics feed is reachable with no session at all, gated only by the token', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Feed Org 2',
    email: 'feed2@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);
  await client.post('/api/posts', {
    title: 'Scheduled reminder post',
    status: 'draft',
    caption_main: 'caption',
    platforms: ['facebook'],
    planned_date: '2026-08-03',
    planned_time: '09:00',
  });
  const { feedUrl } = (await client.get('/api/settings/calendar-feed-url')).data;
  const path = new URL(feedUrl).pathname;

  const created = await client.get('/api/posts?status=draft');
  const postId = created.data.posts[0].id;
  await client.post(`/api/posts/${postId}/transition`, { to: 'ready' });
  await client.post(`/api/posts/${postId}/transition`, { to: 'scheduled' });

  // Deliberately no cookies at all on this request -- this is the whole point.
  const res = await fetch(`${baseUrl}${path}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const body = await res.text();
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.match(body, /SUMMARY:Post: Scheduled reminder post/);
});

test('an unknown token returns 404, not a listing of any kind', async () => {
  const res = await fetch(`${baseUrl}/api/calendar-feed/not-a-real-token.ics`);
  assert.equal(res.status, 404);
});

test('the feed only includes scheduled posts with a confirmed date, not drafts/ideas', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Feed Org 3',
    email: 'feed3@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  await client.post('/api/posts', { title: 'Just an idea, no date' });

  const { feedUrl } = (await client.get('/api/settings/calendar-feed-url')).data;
  const path = new URL(feedUrl).pathname;
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.text();
  assert.doesNotMatch(body, /VEVENT/, 'an idea with no confirmed schedule should not appear on the feed');
});

test('regenerating the token invalidates the old feed URL and requires Owner', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Feed Org 4',
    email: 'feed4@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('feed4-editor@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const before = (await owner.get('/api/settings/calendar-feed-url')).data.feedUrl;
  const oldPath = new URL(before).pathname;

  const editorAttempt = await editor.post('/api/settings/calendar-feed-url/regenerate');
  assert.equal(editorAttempt.status, 403);

  const regen = await owner.post('/api/settings/calendar-feed-url/regenerate');
  assert.equal(regen.status, 200);
  assert.notEqual(regen.data.feedUrl, before);

  const oldRes = await fetch(`${baseUrl}${oldPath}`);
  assert.equal(oldRes.status, 404, 'the old token must stop working once rotated');
});
