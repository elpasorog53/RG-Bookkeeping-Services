import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';
import { createOrgWithUser, loginAs } from '../helpers/fixtures.js';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://fake-project-exports.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.STORAGE_BUCKET_MEDIA = 'rg-media-test';

const realFetch = globalThis.fetch;
const fakeFileBytes = Buffer.from('fake-image-bytes');

function mockFetch(url, options = {}) {
  const urlStr = String(url);
  if (!urlStr.startsWith(process.env.SUPABASE_URL)) {
    return realFetch(url, options);
  }

  // Sign requests: POST .../storage/v1/object/sign/<bucket>/<path>
  if (options.method === 'POST' && urlStr.includes('/storage/v1/object/sign/')) {
    const path = urlStr.split(`/storage/v1/object/sign/${process.env.STORAGE_BUCKET_MEDIA}/`)[1];
    return Promise.resolve(
      new Response(JSON.stringify({ signedURL: `/object/sign/${process.env.STORAGE_BUCKET_MEDIA}/${path}?token=mock` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  }

  // Upload requests: POST .../storage/v1/object/<bucket>/<path>
  if (options.method === 'POST' && urlStr.includes('/storage/v1/object/')) {
    return Promise.resolve(new Response(JSON.stringify({ Key: 'ok' }), { status: 200 }));
  }

  // Everything else (GET on a signed download URL) returns fake file bytes.
  return Promise.resolve(new Response(fakeFileBytes, { status: 200 }));
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
});

async function rawGet(path, cookies) {
  const cookieHeader = `rg_session=${cookies.rg_session}; rg_csrf=${cookies.rg_csrf}`;
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie: cookieHeader } });
  return res;
}

test('CSV export is Owner-only and includes post rows', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Export Org',
    email: 'owner-export@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor-export@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  await owner.post('/api/posts', { title: 'Exportable idea', campaign: 'Fall push' });

  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);
  const editorAttempt = await editor.get('/api/exports/posts.csv');
  assert.equal(editorAttempt.status, 403);

  const res = await rawGet('/api/exports/posts.csv', { rg_session: owner.getCookie('rg_session'), rg_csrf: owner.getCookie('rg_csrf') });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const body = await res.text();
  assert.match(body, /title,status,pillar_name/);
  assert.match(body, /Exportable idea/);
  assert.match(body, /Fall push/);
});

test('per-post zip package includes captions per platform and attached media', async () => {
  const { userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Zip Org',
    email: 'owner-zip@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);

  const created = await owner.post('/api/posts', {
    title: 'Zip test post',
    status: 'draft',
    caption_main: 'Main caption',
    platforms: ['facebook', 'linkedin'],
    hashtags: '#test',
  });
  const postId = created.data.post.id;

  const res = await rawGet(`/api/exports/posts/${postId}/package.zip`, {
    rg_session: owner.getCookie('rg_session'),
    rg_csrf: owner.getCookie('rg_csrf'),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/zip/);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.ok(buffer.length > 0, 'zip should not be empty');
  // A real zip file always starts with the local file header signature "PK".
  assert.equal(buffer.slice(0, 2).toString(), 'PK');
});

test('exporting a post that belongs to another org returns 404', async () => {
  const { userId: ownerAId } = await createOrgWithUser(pool, {
    orgName: 'Zip Org A',
    email: 'owner-zip-a@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { userId: ownerBId } = await createOrgWithUser(pool, {
    orgName: 'Zip Org B',
    email: 'owner-zip-b@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const clientB = createClient(baseUrl);
  await loginAs(clientB, ownerBId);
  const created = await clientB.post('/api/posts', { title: 'Org B post' });

  const clientA = createClient(baseUrl);
  await loginAs(clientA, ownerAId);
  const attempt = await rawGet(`/api/exports/posts/${created.data.post.id}/package.zip`, {
    rg_session: clientA.getCookie('rg_session'),
    rg_csrf: clientA.getCookie('rg_csrf'),
  });
  assert.equal(attempt.status, 404);
});
