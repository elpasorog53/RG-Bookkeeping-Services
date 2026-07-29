import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import express from 'express';
import compression from 'compression';

import { createAuthRouter } from './routes/auth.js';
import pillarsRouter from './routes/pillars.js';
import settingsRouter from './routes/settings.js';
import postsRouter from './routes/posts.js';
import meRouter from './routes/me.js';
import mediaRouter from './routes/media.js';
import exportsRouter from './routes/exports.js';
import auditRouter from './routes/audit.js';
import aiRouter from './routes/ai.js';
import calendarFeedRouter from './routes/calendar-feed.js';
import { requireAuth, requireCsrf, requireOrg } from './lib/auth-middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Health check is public and exempt from auth entirely.
app.get('/health', (_req, res) => res.json({ ok: true }));

// Public routes: onboarding/login/verify/reset live here, mounted before the
// blanket authenticated /api gate below (section 27: public routes first).
app.use('/api/auth', createAuthRouter());

// Also public: calendar apps fetch this feed by plain HTTP GET with no
// session, gated only by the secret token in the URL (see routes/calendar-feed.js).
app.use('/api/calendar-feed', calendarFeedRouter);

// Everything under /api past this point requires a valid session, a CSRF
// header on non-GET requests, and a resolved org membership (org_id always
// comes from the session, never from the request body/query).
app.use('/api', requireAuth, requireCsrf, requireOrg);

app.use('/api/pillars', pillarsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/posts', postsRouter);
app.use('/api/me', meRouter);
app.use('/api/media', mediaRouter);
app.use('/api/exports', exportsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/ai', aiRouter);

// No build step means no cache-busted filenames, so every static asset must
// force revalidation (ETag/Last-Modified conditional GET) on every request.
// Without this, browsers apply heuristic caching and can keep serving a
// stale SPA after a deploy until the user hard-refreshes.
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

// SPA fallback: any non-API GET serves the shell so client-side routing works.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[server] listening on :${PORT}`);
  });
}

export default app;
