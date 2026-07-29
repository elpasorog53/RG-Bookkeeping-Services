# RG Bookkeeping Social Planner

A small, mobile-friendly social media planning tool for RG Bookkeeping
Services: capture ideas, draft posts, review, calendar them, and track
manual posting across Facebook, Instagram, LinkedIn, and Google Business
Profile. No direct platform publishing in Phase 1 — the app makes
copy-and-paste posting fast and records what actually went out.

Built from `RG-Bookkeeping-Social-Media-System-Plan.md`. Live in production
at `https://rg-social-planner.onrender.com`. See [BLOCKERS.md](BLOCKERS.md)
for the real-infrastructure verification history (Supabase project,
Supabase Storage bucket, SMTP account) and deployment notes.

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

This is a live runbook — it reflects how the app is actually deployed
today, not a forward-looking checklist. Follow it as-is to redeploy, or as
a reference if setting up a genuinely separate environment later.

1. One Supabase project provides both the Postgres database and Storage
   (a **private** bucket for media). See BLOCKERS.md for why there's only
   one project rather than a separate dev/prod split.
2. A Render Web Service runs this repo on the **free plan**. Zero monthly
   cost is a hard requirement — do not upgrade the plan without an
   explicit decision from the owner.
3. Start command: `node scripts/run-migrations.js && npm start` (migrations
   run automatically before every boot, and are additive/idempotent, so
   this is safe on every deploy).
4. Every variable from `.env.example` is set in the Render dashboard
   (`sync: false` — never commit real values), with `DB_SSL=true` and
   `APP_URL` set to the app's real `onrender.com` URL.
5. Auto-deploy is on: every push to `main` runs migrations, then serves the
   updated app.
6. Verified end to end: signup email arrives, password reset works, an
   upload produces a signed URL that expires, a second browser without a
   session gets 401s on `/api/*`, Render logs show no secrets.
7. Free-tier cold starts are expected: after an idle spell, the first load
   shows a "waking up" screen and recovers within about a minute.

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
  migrations/          001_init.sql, 002-004 (additive only — never edit an applied one)
public/
  index.html  styles.css  app.js (router + shared helpers only)
  pages/               one feature per file (dashboard, calendar, editor, ...)
tests/
  unit/  integration/  helpers/
scripts/
  run-migrations.js
```

## Status

Live in production, Phase 1 and Phase 2 both complete.

**Phase 1** (spec section 32): auth + onboarding, org scoping, audit
logging, brand settings, content pillars, the full post status workflow,
content list with filters, the post editor (autosave, per-platform
character counts, copy-to-clipboard, mark-published), media upload, the
calendar (month/list views, drag-and-drop rescheduling, an .ics
subscription feed), the dashboard, CSV/zip exports, and the Settings/audit
UI.

**Phase 2**: reusable templates, evergreen-post resurfacing (a dashboard
card for content due to be reused), recurrence rules (auto-generating
draft posts from a template on a schedule, including a date-verification
flag for content tied to shifting deadlines), an AI drafting suite
(draft/rewrite/variants via a user-supplied Anthropic key, with a
brand-voice-and-safety system prompt), monthly content planning (a
cadence-vs-target view per week, plus pillar-mix balance), and
topic-repetition warnings (flags accidental reuse of a pillar or a
near-duplicate caption). See [USER_GUIDE.md](USER_GUIDE.md) for how to use
all of it, and BLOCKERS.md for infrastructure verification history.
