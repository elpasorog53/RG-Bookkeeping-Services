# Blockers

Real values and live-service checks. Nothing here was ever guessed or
filled with a fake credential. As of 2026-07-29, every blocker from the
original build-out is resolved: the app is deployed to Render, live at
`https://rg-social-planner.onrender.com`, and in daily real-world use.

## Resolved

**Supabase database.** A real project is live (`mbirlwfqedzqlbytzfsv`).
Migrations run cleanly against it (idempotent, confirmed on every deploy
since). Real onboarding (org + owner + seeded pillars/brand settings in one
transaction), login, logout, and 401-after-logout were all exercised
against the live database.

**Supabase Storage.** A private bucket (`rg-media`) is live. Real upload,
signed-URL generation, thumbnail display, and delete were all exercised
end to end. One real bug surfaced and was fixed: Supabase's newer
`sb_secret_...` key format isn't a JWT, and sending only an `Authorization`
header made the gateway fall through to JWT-parsing logic that rejected it
("Invalid Compact JWS"). Fix: `src/lib/storage.js` now sends both `apikey`
and `Authorization` headers (see git history / the fix itself for detail).

**SMTP (Brevo).** Real password-reset email was sent and received.
Two real-world snags along the way, both resolved:
1. Brevo's SMTP *login* is a generated value (`xxxxx@smtp-brevo.com`), not
   the account's login email — easy to mix up.
2. Brevo blocks SMTP auth from unrecognized IPs by default. Fixed by
   deactivating IP-based restriction for SMTP keys in Brevo's security
   settings (Settings → Security → "Deactivate for SMTP keys"), since this
   dev environment's IP isn't stable across sessions anyway.

Also found and fixed while working through this: three routes
(`onboard`, `request-password-reset`, `settings/users/invite`) treated a
mail-send failure as a full request failure, even though the DB write
they cared about had already committed. A flaky SMTP send could strand a
successful signup/invite, or (worse, for password reset) leak whether an
email was registered via a 200-vs-500 status difference. All three now
catch and log the mail error without failing the request.

**Owner questions from spec section 35** were answered early on (Eastern
timezone, business name "RG Bookkeeping Services", Roger Guzman as a real
Editor, Facebook/LinkedIn priority, ~2 posts/week cadence) and are
reflected in seed defaults and the `posts_per_week_target` brand setting.

**Render deployment.** Live since the initial Phase 1 push, auto-deploying
on every merge to `main`. Free-tier cold starts (the "waking up…" screen
after an idle spell) were verified to recover within about a minute.

**Production Supabase project.** The original plan (spec section 27/30)
called for a separate dev project and prod project. In practice only one
project was ever created — it served as the dev database early on, then
became the real production database the moment the app deployed, and no
second project was ever split off. This is a deliberate, accepted
tradeoff, not an oversight: with automated tests running against a
disposable in-memory Postgres before every deploy (141 tests as of the
Phase 2 build), a second live Supabase project would mainly help on the
rare occasions a feature gets verified by hand against the live database —
low enough value at this app's scale (two users, ~2 posts/week) to not be
worth the ongoing overhead of juggling two databases. Revisit if that
calculus changes (e.g. more users, higher-stakes data).

## Still open

**Brand assets beyond text.** The Brand Voice tab covers business
description, services, target audience, tone, preferred/avoid terms,
website, contact info, and disclaimer text. The schema also has columns
for `default_ctas`, `platform_prefs`, `post_length_pref`, and
`example_posts` (a logo/colors equivalent for voice — sample posts to
imitate), but none of those are exposed in the Settings UI yet. Not
blocking anything today; worth adding if AI-drafted content ever needs
tighter voice-matching than the current text fields give it.
