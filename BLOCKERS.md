# Blockers

Real values and live-service checks. Nothing here was ever guessed or
filled with a fake credential. As of 2026-07-27, all three original
blockers are resolved — the app has a real Supabase project, a real
Storage bucket, and a real SMTP account, all verified end to end.

## Resolved

**Supabase database.** A real project is live (`mbirlwfqedzqlbytzfsv`).
Migrations run cleanly against it (idempotent, confirmed with a second
no-op run). Real onboarding (org + owner + seeded pillars/brand settings
in one transaction), login, logout, and 401-after-logout were all
exercised against the live database.

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

## Still open

**Owner questions from spec section 35** were answered in an earlier
session (Eastern timezone, business name "RG Bookkeeping Services",
Roger Guzman as a real Editor, Facebook/LinkedIn priority, ~2 posts/week
cadence) and are already reflected in seed defaults. Brand assets
(logo/colors/example posts) haven't been collected yet — they're entered
through Settings whenever the owner has them, never hardcoded.

**Production Supabase project** — everything above was verified against
what's effectively the dev project. A separate prod project (per spec
section 27/30) hasn't been created yet; that's a "when you're ready to
deploy" step, not a blocker on further development.

**Render deployment** hasn't happened yet — local/dev verification only
so far.
