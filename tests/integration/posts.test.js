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

async function setupOwner(orgName, email) {
  const { userId } = await createOrgWithUser(pool, { orgName, email, displayName: 'Owner', role: 'OWNER' });
  const client = createClient(baseUrl);
  await loginAs(client, userId);
  return client;
}

test('quick-add creates an idea with just a title', async () => {
  const client = await setupOwner('Quick Add Org', 'quickadd@example.com');
  const created = await client.post('/api/posts', { title: 'Shoebox receipts tip' });
  assert.equal(created.status, 201);
  assert.equal(created.data.post.status, 'idea');
  assert.equal(created.data.post.title, 'Shoebox receipts tip');
});

test('full lifecycle: idea -> draft -> ready -> scheduled -> published', async () => {
  const client = await setupOwner('Lifecycle Org', 'lifecycle@example.com');

  const created = await client.post('/api/posts', { title: 'Q3 estimated tax reminder' });
  const postId = created.data.post.id;

  const toDraft = await client.post(`/api/posts/${postId}/transition`, { to: 'draft' });
  assert.equal(toDraft.status, 200);

  const missingCaption = await client.post(`/api/posts/${postId}/transition`, { to: 'ready' });
  assert.equal(missingCaption.status, 400);

  await client.put(`/api/posts/${postId}`, {
    caption_main: 'Q3 estimated taxes are due Sept 15.',
    platforms: ['facebook', 'gbp'],
  });

  const toReady = await client.post(`/api/posts/${postId}/transition`, { to: 'ready' });
  assert.equal(toReady.status, 200);
  assert.equal(toReady.data.post.status, 'ready');

  const missingDate = await client.post(`/api/posts/${postId}/transition`, { to: 'scheduled' });
  assert.equal(missingDate.status, 400);

  const dateSet = await client.put(`/api/posts/${postId}`, { planned_date: '2026-09-12', planned_time: '09:00' });
  assert.equal(
    dateSet.data.post.planned_date,
    '2026-09-12',
    'planned_date must round-trip as a plain YYYY-MM-DD string, not a Date-serialized ISO timestamp (breaks <input type="date"> and formatDate())'
  );

  const toScheduled = await client.post(`/api/posts/${postId}/transition`, { to: 'scheduled' });
  assert.equal(toScheduled.status, 200);

  const toPublished = await client.post(`/api/posts/${postId}/transition`, {
    to: 'published',
    published_urls: { facebook: 'https://facebook.com/rg/posts/1' },
  });
  assert.equal(toPublished.status, 200);
  assert.equal(toPublished.data.post.status, 'published');
  assert.ok(toPublished.data.post.published_at);
  assert.equal(toPublished.data.post.published_urls.facebook, 'https://facebook.com/rg/posts/1');

  const illegalFromPublished = await client.post(`/api/posts/${postId}/transition`, { to: 'draft' });
  assert.equal(illegalFromPublished.status, 409);

  const lockedEdit = await client.put(`/api/posts/${postId}`, { caption_main: 'trying to change it' });
  assert.equal(lockedEdit.status, 409);

  const allowedEdit = await client.put(`/api/posts/${postId}`, { notes: 'went well' });
  assert.equal(allowedEdit.status, 200);

  const { rows: history } = await pool.query(
    'SELECT from_status, to_status FROM status_history WHERE post_id = $1 ORDER BY id',
    [postId]
  );
  assert.deepEqual(
    history.map((h) => h.to_status),
    ['idea', 'draft', 'ready', 'scheduled', 'published']
  );
});

test('editing the caption on a ready post automatically drops it back to draft', async () => {
  const client = await setupOwner('Auto Downgrade Org', 'autodowngrade@example.com');
  const created = await client.post('/api/posts', {
    title: 'Common mistake tip',
    status: 'draft',
    caption_main: 'Original caption',
    platforms: ['facebook'],
  });
  const postId = created.data.post.id;
  await client.post(`/api/posts/${postId}/transition`, { to: 'ready' });

  const edit = await client.put(`/api/posts/${postId}`, { caption_main: 'Edited caption' });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.post.status, 'draft', 'caption edits on a ready post drop it back to draft');
});

test('clearing the date on a scheduled post automatically promotes it back to ready', async () => {
  const client = await setupOwner('Auto Promote Org', 'autopromote@example.com');
  const created = await client.post('/api/posts', {
    title: 'Trust post',
    status: 'draft',
    caption_main: 'A caption',
    platforms: ['facebook'],
    planned_date: '2026-08-01',
    planned_time: '09:00',
  });
  const postId = created.data.post.id;
  await client.post(`/api/posts/${postId}/transition`, { to: 'ready' });
  await client.post(`/api/posts/${postId}/transition`, { to: 'scheduled' });

  const cleared = await client.put(`/api/posts/${postId}`, { planned_date: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.post.status, 'ready');
});

test('review gate: editor cannot approve a flagged post, owner can with approve:true', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Review Gate Org',
    email: 'owner-review@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-review@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const created = await editor.post('/api/posts', {
    title: 'Tax adjacency post',
    status: 'draft',
    caption_main: 'This could read as tax advice',
    platforms: ['facebook'],
    needs_review: true,
  });
  const postId = created.data.post.id;

  const editorAttempt = await editor.post(`/api/posts/${postId}/transition`, { to: 'ready' });
  assert.equal(editorAttempt.status, 403);

  const ownerNoApprove = await owner.post(`/api/posts/${postId}/transition`, { to: 'ready' });
  assert.equal(ownerNoApprove.status, 400);

  const ownerApprove = await owner.post(`/api/posts/${postId}/transition`, { to: 'ready', approve: true });
  assert.equal(ownerApprove.status, 200);
  assert.equal(ownerApprove.data.post.reviewed_by, ownerId);
});

test('optimistic concurrency: a stale expected_updated_at is rejected with 409', async () => {
  const client = await setupOwner('Concurrency Org', 'concurrency@example.com');
  const created = await client.post('/api/posts', { title: 'Stale edit test' });
  const postId = created.data.post.id;
  const staleTimestamp = created.data.post.updated_at;

  await client.put(`/api/posts/${postId}`, { title: 'First editor wins' });

  const conflict = await client.put(`/api/posts/${postId}`, {
    title: 'Second editor loses',
    expected_updated_at: staleTimestamp,
  });
  assert.equal(conflict.status, 409);
});

test('filters: status, pillar, platform, campaign, search, and date range all narrow the list', async () => {
  const client = await setupOwner('Filter Org', 'filters@example.com');
  const pillars = await client.get('/api/pillars');
  const pillarId = pillars.data.pillars[0].id;

  await client.post('/api/posts', { title: 'Alpha idea' });
  const draft = await client.post('/api/posts', {
    title: 'Beta draft',
    status: 'draft',
    pillar_id: pillarId,
    platforms: ['linkedin'],
    campaign: 'September push',
    planned_date: '2026-09-01',
  });
  await client.post('/api/posts', { title: 'Gamma idea', campaign: 'Other' });

  const byStatus = await client.get('/api/posts?status=draft');
  assert.equal(byStatus.data.posts.length, 1);
  assert.equal(byStatus.data.posts[0].id, draft.data.post.id);

  const byPillar = await client.get(`/api/posts?pillar_id=${pillarId}`);
  assert.equal(byPillar.data.posts.length, 1);

  const byPlatform = await client.get('/api/posts?platform=linkedin');
  assert.equal(byPlatform.data.posts.length, 1);

  const byCampaign = await client.get('/api/posts?campaign=September');
  assert.equal(byCampaign.data.posts.length, 1);

  const bySearch = await client.get('/api/posts?search=Alpha');
  assert.equal(bySearch.data.posts.length, 1);
  assert.equal(bySearch.data.posts[0].title, 'Alpha idea');

  const byDateRange = await client.get('/api/posts?date_from=2026-08-01&date_to=2026-09-30');
  assert.equal(byDateRange.data.posts.length, 1);

  const all = await client.get('/api/posts');
  assert.equal(all.data.posts.length, 3);
});

test('archive requires Owner for a published post but allows Editor for a draft', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Archive Org',
    email: 'owner-archive@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-archive@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const draftPost = await editor.post('/api/posts', { title: 'Editor archivable', status: 'draft' });
  const editorArchive = await editor.post(`/api/posts/${draftPost.data.post.id}/archive`);
  assert.equal(editorArchive.status, 200);

  const published = await owner.post('/api/posts', {
    title: 'Owner-only archive',
    status: 'draft',
    caption_main: 'x',
    platforms: ['facebook'],
    planned_date: '2026-08-01',
    planned_time: '09:00',
  });
  const pid = published.data.post.id;
  await owner.post(`/api/posts/${pid}/transition`, { to: 'ready' });
  await owner.post(`/api/posts/${pid}/transition`, { to: 'scheduled' });
  await owner.post(`/api/posts/${pid}/transition`, { to: 'published' });

  const editorArchivePublished = await editor.post(`/api/posts/${pid}/archive`);
  assert.equal(editorArchivePublished.status, 403);

  const ownerArchivePublished = await owner.post(`/api/posts/${pid}/archive`);
  assert.equal(ownerArchivePublished.status, 200);
});

test('restore lands back in draft or idea depending on whether a caption exists, and delete requires archiving first', async () => {
  const client = await setupOwner('Restore Org', 'restore@example.com');

  const withCaption = await client.post('/api/posts', {
    title: 'Has a caption',
    status: 'draft',
    caption_main: 'Already written',
  });
  await client.post(`/api/posts/${withCaption.data.post.id}/archive`);
  const restored = await client.post(`/api/posts/${withCaption.data.post.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.post.status, 'draft');

  const withoutCaption = await client.post('/api/posts', { title: 'Just an idea' });

  const deleteBeforeArchive = await client.del(`/api/posts/${withoutCaption.data.post.id}`);
  assert.equal(deleteBeforeArchive.status, 409);

  await client.post(`/api/posts/${withoutCaption.data.post.id}/archive`);
  const restoredIdea = await client.post(`/api/posts/${withoutCaption.data.post.id}/restore`);
  assert.equal(restoredIdea.data.post.status, 'idea');

  await client.post(`/api/posts/${withoutCaption.data.post.id}/archive`);
  const deleted = await client.del(`/api/posts/${withoutCaption.data.post.id}`);
  assert.equal(deleted.status, 204);
});

test('reuse creates a new draft copy linked via parent_post_id, leaving the original untouched', async () => {
  const client = await setupOwner('Reuse Org', 'reuse@example.com');
  const original = await client.post('/api/posts', {
    title: 'Evergreen tip',
    status: 'draft',
    caption_main: 'Always relevant',
    platforms: ['facebook'],
    is_evergreen: true,
  });

  const reused = await client.post(`/api/posts/${original.data.post.id}/reuse`);
  assert.equal(reused.status, 201);
  assert.equal(reused.data.post.status, 'draft');
  assert.equal(reused.data.post.parent_post_id, original.data.post.id);
  assert.equal(reused.data.post.caption_main, 'Always relevant');

  const { rows } = await pool.query('SELECT status FROM posts WHERE id = $1', [original.data.post.id]);
  assert.equal(rows[0].status, 'draft', 'the original post is unchanged');
});

test('a post belonging to another org returns 404, never leaking existence', async () => {
  const clientA = await setupOwner('Org X', 'orgx@example.com');
  const clientB = await setupOwner('Org Y', 'orgy@example.com');

  const created = await clientB.post('/api/posts', { title: 'Org Y secret' });
  const getAttempt = await clientA.get(`/api/posts/${created.data.post.id}`);
  assert.equal(getAttempt.status, 404);

  const putAttempt = await clientA.put(`/api/posts/${created.data.post.id}`, { title: 'Hijacked' });
  assert.equal(putAttempt.status, 404);

  const transitionAttempt = await clientA.post(`/api/posts/${created.data.post.id}/transition`, { to: 'draft' });
  assert.equal(transitionAttempt.status, 404);
});

test('rejects an unknown/disabled platform key on create', async () => {
  const client = await setupOwner('Bad Platform Org', 'badplatform@example.com');
  const created = await client.post('/api/posts', { title: 'x', platforms: ['tiktok'] });
  assert.equal(created.status, 400);
});
