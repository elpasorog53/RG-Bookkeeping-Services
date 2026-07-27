import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';
import { createOrgWithUser, loginAs } from '../helpers/fixtures.js';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.STORAGE_BUCKET_MEDIA = 'rg-media-test';

// No real Supabase project exists in this environment (see BLOCKERS.md), so
// the Storage REST calls are mocked here at the fetch layer. Everything
// else -- multer parsing, mime/size validation, media_assets + post_media
// rows, signed-url threading through the API -- runs for real against the
// pglite-backed test Postgres.
const realFetch = globalThis.fetch;
const uploadedObjects = new Set();

function mockFetch(url, options = {}) {
  const urlStr = String(url);
  if (!urlStr.startsWith(process.env.SUPABASE_URL)) {
    return realFetch(url, options);
  }

  if (urlStr.includes('/storage/v1/object/sign/')) {
    const path = urlStr.split(`/storage/v1/object/sign/${process.env.STORAGE_BUCKET_MEDIA}/`)[1];
    return Promise.resolve(
      new Response(JSON.stringify({ signedURL: `/object/sign/${process.env.STORAGE_BUCKET_MEDIA}/${path}?token=mock` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  }

  if (urlStr.includes('/storage/v1/object/') && options.method === 'DELETE') {
    const body = JSON.parse(options.body);
    body.prefixes.forEach((p) => uploadedObjects.delete(p));
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  }

  if (urlStr.includes('/storage/v1/object/') && options.method === 'POST') {
    const path = urlStr.split(`/storage/v1/object/${process.env.STORAGE_BUCKET_MEDIA}/`)[1];
    uploadedObjects.add(path);
    return Promise.resolve(new Response(JSON.stringify({ Key: path }), { status: 200 }));
  }

  return Promise.resolve(new Response('not found', { status: 404 }));
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

function tinyPngBuffer() {
  // Smallest valid PNG (1x1 transparent pixel), used as fake upload bytes.
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

function multipartBody(fieldName, filename, mimeType, buffer, extraFields = {}) {
  const boundary = '----testboundary123456';
  const parts = [];
  for (const [key, value] of Object.entries(extraFields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    )
  );
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadFile(baseUrlArg, cookies, fields = {}) {
  const { body, contentType } = multipartBody('file', 'test.png', 'image/png', tinyPngBuffer(), fields);
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const res = await fetch(`${baseUrlArg}/api/media/upload`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'x-csrf-token': decodeURIComponent(cookies.rg_csrf),
      'content-type': contentType,
    },
    body,
  });
  const data = await res.json();
  return { status: res.status, data };
}

function cookiesFromClient(client) {
  return { rg_session: client.getCookie('rg_session'), rg_csrf: client.getCookie('rg_csrf') };
}

test('upload validates mime type and stores a media_assets row with a signed URL', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Media Org',
    email: 'media@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const { status, data } = await uploadFile(baseUrl, cookiesFromClient(client));
  assert.equal(status, 201);
  assert.equal(data.media.mime_type, 'image/png');
  assert.equal(data.media.kind, 'image');
  assert.ok(data.signedUrl.includes('token=mock'));

  const list = await client.get('/api/media');
  assert.equal(list.data.media.length, 1);
  assert.ok(list.data.media[0].signedUrl.includes('token=mock'));
});

test('upload rejects an unsupported mime type', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Media Org 2',
    email: 'media2@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const { body, contentType } = multipartBody('file', 'malware.exe', 'application/x-msdownload', Buffer.from('bad'));
  const cookies = cookiesFromClient(client);
  const res = await fetch(`${baseUrl}/api/media/upload`, {
    method: 'POST',
    headers: {
      cookie: `rg_session=${cookies.rg_session}; rg_csrf=${cookies.rg_csrf}`,
      'x-csrf-token': decodeURIComponent(cookies.rg_csrf),
      'content-type': contentType,
    },
    body,
  });
  assert.equal(res.status, 400);
});

test('upload can attach directly to a post in one call, respecting the platform media cap', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Media Org 3',
    email: 'media3@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const post = await client.post('/api/posts', { title: 'GBP post', platforms: ['gbp'] });
  const postId = post.data.post.id;

  const first = await uploadFile(baseUrl, cookiesFromClient(client), { post_id: postId });
  assert.equal(first.status, 201);

  const postMedia = await client.get(`/api/posts/${postId}/media`);
  assert.equal(postMedia.data.media.length, 1);

  // gbp's media_max_count is 1, so attaching a second item to this post is rejected.
  const secondUpload = await uploadFile(baseUrl, cookiesFromClient(client));
  const attach = await client.post(`/api/posts/${postId}/media`, { media_id: secondUpload.data.media.id });
  assert.equal(attach.status, 400);
});

test('reorder updates sort_order and detach removes the link without deleting the asset', async () => {
  const { userId } = await createOrgWithUser(pool, {
    orgName: 'Media Org 4',
    email: 'media4@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const client = createClient(baseUrl);
  await loginAs(client, userId);

  const post = await client.post('/api/posts', { title: 'Carousel post', platforms: ['facebook'] });
  const postId = post.data.post.id;

  const upload1 = await uploadFile(baseUrl, cookiesFromClient(client), { post_id: postId });
  const upload2 = await uploadFile(baseUrl, cookiesFromClient(client));
  await client.post(`/api/posts/${postId}/media`, { media_id: upload2.data.media.id });

  const reordered = await client.put(`/api/posts/${postId}/media/reorder`, {
    order: [upload2.data.media.id, upload1.data.media.id],
  });
  assert.equal(reordered.status, 200);

  const afterReorder = await client.get(`/api/posts/${postId}/media`);
  assert.equal(afterReorder.data.media[0].id, upload2.data.media.id);

  const detach = await client.del(`/api/posts/${postId}/media/${upload1.data.media.id}`);
  assert.equal(detach.status, 204);

  const afterDetach = await client.get(`/api/posts/${postId}/media`);
  assert.equal(afterDetach.data.media.length, 1);

  const stillInLibrary = await client.get('/api/media');
  assert.equal(stillInLibrary.data.media.length, 2, 'detaching does not delete the underlying asset');
});

test('delete requires Owner, removes the storage object, and detaches from all posts', async () => {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName: 'Media Org 5',
    email: 'media5@example.com',
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ('editor5@example.com', 'x', 'Editor', now()) RETURNING id`
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const post = await owner.post('/api/posts', { title: 'x' });
  const uploaded = await uploadFile(baseUrl, cookiesFromClient(owner), { post_id: post.data.post.id });
  const mediaId = uploaded.data.media.id;

  const editorDelete = await editor.del(`/api/media/${mediaId}`);
  assert.equal(editorDelete.status, 403);

  const ownerDelete = await owner.del(`/api/media/${mediaId}`);
  assert.equal(ownerDelete.status, 204);

  const { rows: postMediaRows } = await pool.query('SELECT * FROM post_media WHERE media_id = $1', [mediaId]);
  assert.equal(postMediaRows.length, 0);

  const { rows: assetRows } = await pool.query('SELECT * FROM media_assets WHERE id = $1', [mediaId]);
  assert.equal(assetRows.length, 0);
});
