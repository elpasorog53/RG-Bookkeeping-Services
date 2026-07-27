import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';

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

const OWNER = {
  orgName: 'RG Bookkeeping Services',
  timezone: 'America/Chicago',
  displayName: 'Jeremy',
  email: 'jeremy@example.com',
  password: 'a-long-enough-password',
};

test('GET /api/auth/status reports needsOnboarding before any user exists', async () => {
  const client = createClient(baseUrl);
  const res = await client.get('/api/auth/status');
  assert.equal(res.status, 200);
  assert.equal(res.data.needsOnboarding, true);
});

test('unauthenticated request to a guarded /api route is rejected with 401', async () => {
  const client = createClient(baseUrl);
  const res = await client.get('/api/whatever');
  assert.equal(res.status, 401);
});

test('full lifecycle: onboard -> verify -> logout -> login -> reset -> login with new password', async () => {
  const client = createClient(baseUrl);

  const onboardRes = await client.post('/api/auth/onboard', OWNER);
  assert.equal(onboardRes.status, 201);
  assert.equal(onboardRes.data.user.email, OWNER.email);
  assert.ok(client.getCookie('rg_session'), 'session cookie should be set after onboarding');
  assert.ok(client.getCookie('rg_csrf'), 'csrf cookie should be set after onboarding');

  const statusAfter = await client.get('/api/auth/status');
  assert.equal(statusAfter.data.needsOnboarding, false);

  const { rows } = await pool.query(
    'SELECT verify_token_hash FROM users WHERE email = $1',
    [OWNER.email]
  );
  assert.notEqual(rows[0].verify_token_hash, null, 'a verify token should have been issued');

  const { rows: pillarRows } = await pool.query('SELECT count(*)::int AS n FROM content_pillars');
  assert.equal(pillarRows[0].n, 6, 'six default pillars should be seeded');

  const { rows: platformRows } = await pool.query('SELECT count(*)::int AS n FROM platforms');
  assert.equal(platformRows[0].n, 4, 'platforms are seeded once by the migration, not onboarding');

  const logoutRes = await client.post('/api/auth/logout');
  assert.equal(logoutRes.status, 200);

  const afterLogout = await client.get('/api/whatever');
  assert.equal(afterLogout.status, 401, 'session should be invalid after logout');

  const badLogin = await client.post('/api/auth/login', {
    email: OWNER.email,
    password: 'wrong-password',
  });
  assert.equal(badLogin.status, 401);

  const goodLogin = await client.post('/api/auth/login', {
    email: OWNER.email,
    password: OWNER.password,
  });
  assert.equal(goodLogin.status, 200);
  assert.ok(client.getCookie('rg_session'));

  const resetRequest = await client.post('/api/auth/request-password-reset', {
    email: OWNER.email,
  });
  assert.equal(resetRequest.status, 200);

  const { rows: resetRows } = await pool.query(
    'SELECT reset_token_hash FROM users WHERE email = $1',
    [OWNER.email]
  );
  assert.notEqual(resetRows[0].reset_token_hash, null);

  const badReset = await client.post('/api/auth/reset-password', {
    token: 'not-the-real-token',
    newPassword: 'another-long-password',
  });
  assert.equal(badReset.status, 400);

  // Recover the real token the same way a human would: from the email.
  // SMTP isn't configured in this sandbox, so mailer.js logs to console and
  // exposes the last simulated send via this test-only introspection hook.
  const { getLastSimulatedMail } = await import('../../src/lib/mailer.js');
  const mail = getLastSimulatedMail();
  const match = mail.text.match(/token=([a-f0-9]+)/);
  assert.ok(match, 'reset email should contain a token');
  const realToken = match[1];

  const goodReset = await client.post('/api/auth/reset-password', {
    token: realToken,
    newPassword: 'a-brand-new-password',
  });
  assert.equal(goodReset.status, 200);

  const oldPasswordLogin = await client.post('/api/auth/login', {
    email: OWNER.email,
    password: OWNER.password,
  });
  assert.equal(oldPasswordLogin.status, 401, 'old password should no longer work');

  const newPasswordLogin = await client.post('/api/auth/login', {
    email: OWNER.email,
    password: 'a-brand-new-password',
  });
  assert.equal(newPasswordLogin.status, 200);
});

test('requesting a reset for an unknown email still responds 200 (no user enumeration)', async () => {
  const client = createClient(baseUrl);
  const res = await client.post('/api/auth/request-password-reset', {
    email: 'nobody@example.com',
  });
  assert.equal(res.status, 200);
});

test('onboarding twice is rejected once a user exists', async () => {
  const client = createClient(baseUrl);
  const first = await client.post('/api/auth/onboard', OWNER);
  assert.equal(first.status, 201);

  const second = await client.post('/api/auth/onboard', {
    ...OWNER,
    email: 'someoneelse@example.com',
  });
  assert.equal(second.status, 409);
});
