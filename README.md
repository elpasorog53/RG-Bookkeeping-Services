# RG Bookkeeping Social Planner

A small, mobile-friendly social media planning tool for RG Bookkeeping
Services: capture ideas, draft posts, review, calendar them, and track
manual posting across Facebook, Instagram, LinkedIn, and Google Business
Profile. No direct platform publishing in Phase 1 — the app makes
copy-and-paste posting fast and records what actually went out.

Built from `RG-Bookkeeping-Social-Media-System-Plan.md`. See
[BLOCKERS.md](BLOCKERS.md) for what's still unverified pending real
credentials (Supabase project, Supabase Storage bucket, SMTP account).

## Stack

Plain Node.js + Express, raw SQL over `pg` (no ORM), vanilla JS SPA served
as static files (no build step, no framework). Postgres via Supabase.
Media via Supabase Storage (private bucket, signed URLs). See the plan
document, section 3, for the full rationale.

## Local development

```bash
npm install
cp .env.example .env       # fill in a dev Supabase project's values
npm run db:migrate         # applies src/migrations/*.sql, idempotent
npm run dev                # nodemon on :3000
npm run lint
npm test                   # node:test; spins up an in-memory Postgres
                            # automatically if TEST_DATABASE_URL isn't set
npm start                  # production-mode boot (what Render runs)
```

First visit to a freshly migrated database serves a one-time onboarding
form (creates the Owner account, the organization, seeded content pillars,
and brand settings in one transaction).

### Running tests without a real Postgres

`npm test` does not require any external database. `tests/helpers/db-fixture.js`
spins up an ephemeral in-memory Postgres-wire-protocol server (`pglite` +
`pglite-socket`) automatically. If `TEST_DATABASE_URL` is set in the
environment, tests use that real database instead — useful for a final
check against genuine Postgres/Supabase before deploying.

## Deployment (Render)

1. Create two Supabase projects (dev, prod) — see BLOCKERS.md for what's
   still needed there. Create a **private** Storage bucket for media.
2. Create a Render Web Service from this repo, **free plan**. Zero
   monthly cost is a hard requirement — do not upgrade the plan without
   an explicit decision from the owner.
3. Start command: `node scripts/run-migrations.js && npm start` (migrations
   run automatically before every boot).
4. Set every variable from `.env.example` in the Render dashboard
   (`sync: false` — never commit real values). Set `DB_SSL=true` and
   `APP_URL` to the assigned `onrender.com` URL.
5. First deploy runs migrations, then serves the onboarding form.
6. Verify: signup email arrives, password reset works, an upload produces
   a signed URL that expires, a second browser without a session gets 401s
   on `/api/*`, Render logs show no secrets.
7. Confirm the free-tier cold-start behavior: leave the app idle past
   Render's spin-down window, then load it and confirm the "waking up"
   screen appears and the app recovers within about a minute.

## Backup runbook

The Supabase free tier has no managed automated backups. Monthly, run:

```bash
pg_dump "$DATABASE_URL" -F c -f "backup-$(date +%Y-%m-%d).dump"
```

Store the dump somewhere durable (not committed to git). To restore:

```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists backup-YYYY-MM-DD.dump
```

Verify a restore at least once during initial setup. The in-app CSV export
(Settings → Audit → "Export all posts") is a lightweight supplementary
export the Owner can run any time.

## Project structure

```text
src/
  index.js            express app, middleware order, router mounts
  routes/              one file per domain (auth, posts, pillars, media, ...)
  services/            post-service.js: the status transition matrix
  lib/                 db, auth-middleware, storage, audit, mailer, rate-limit
  migrations/          001_init.sql (additive only — never edit an applied one)
public/
  index.html  styles.css  app.js (router + shared helpers only)
  pages/               one feature per file (dashboard, calendar, editor, ...)
tests/
  unit/  integration/  helpers/
scripts/
  run-migrations.js
```

## Status

All of Phase 1 (spec section 32) is built: auth + onboarding, org scoping,
audit logging, brand settings, content pillars, the full post status
workflow, content list with filters, the post editor (autosave, per-platform
character counts, copy-to-clipboard, mark-published), media upload, the
calendar (month/list views, drag-and-drop rescheduling), the dashboard,
CSV/zip exports, and the Settings/audit UI. See BLOCKERS.md for the handful
of things that need real Supabase/SMTP credentials to verify end to end
rather than against local mocks.
