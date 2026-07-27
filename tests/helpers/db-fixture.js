// Test-only database bootstrap. Production and dev always talk to real
// Postgres (Supabase) via DATABASE_URL and the pg driver in src/lib/db.js.
// When TEST_DATABASE_URL isn't set (e.g. this sandbox, with no Supabase
// project reachable), we spin up an ephemeral in-memory Postgres-wire-
// protocol server (pglite) so `npm test` can still run real SQL against a
// real Postgres dialect with zero external services. If TEST_DATABASE_URL
// is set, that real database is used instead and this server never starts.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'migrations');

let server;
let db;

// Node's test runner runs each test file as its own subprocess, and several
// files use this fixture, so a fixed port would collide. Ask the OS for a
// free one instead (briefly bind to port 0, read it back, release it).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function setupTestDatabase() {
  // No test should ever depend on, or be affected by, a developer's local
  // .env: index.js loads it via `dotenv/config`, so a real SMTP_* value
  // sitting in .env would otherwise make mailer.js attempt genuine sends
  // during `npm test` instead of using its safe local-log fallback. Setting
  // (not deleting) these matters: dotenv only fills in *undefined* vars, so
  // a deleted key would just get silently refilled from .env when index.js
  // loads; an empty string is "already defined" and blocks that refill,
  // while still reading as falsy/unconfigured to mailer.js's own check.
  process.env.SMTP_HOST = '';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASS = '';

  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.DB_SSL = process.env.DB_SSL || 'true';
    return { external: true };
  }

  const port = await getFreePort();
  db = new PGlite();
  // maxConnections defaults to 1 in pglite-socket; the app's pg.Pool (and
  // concurrent requests from the frontend) open more than one connection.
  server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
  await server.start();

  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  process.env.DB_SSL = 'false';

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.exec(sql);
  }

  return { external: false };
}

export async function teardownTestDatabase() {
  if (server) {
    await server.stop();
    server = undefined;
  }
  if (db) {
    await db.close();
    db = undefined;
  }
}

export async function resetTestData(pool) {
  await pool.query(`
    TRUNCATE TABLE
      audit_log, ai_generations, status_history, post_media, media_assets,
      recurrence_rules, templates, posts, content_pillars, brand_settings,
      sessions, org_members, users, organizations
    RESTART IDENTITY CASCADE
  `);
}
