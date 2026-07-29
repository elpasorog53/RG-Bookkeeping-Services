// Router + shared helpers ONLY (section 27). Page-specific logic lives in
// public/pages/*.js.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  let body = options.body;

  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (method !== 'GET') {
    headers['x-csrf-token'] = getCookie('rg_csrf');
  }

  const res = await fetch(path, {
    method,
    headers,
    body,
    cache: 'no-store',
    credentials: 'same-origin',
  });

  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.location.hash = '#/login';
    throw new Error('Unauthorized');
  }

  if (res.status === 204) return null;

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const message = (data && data.error) || `Request failed: ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

export function toast(message, { isError = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' toast-error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  setTimeout(() => el.remove(), 3200);
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

const PAGES = {
  login: () => import('./pages/login.js'),
  onboarding: () => import('./pages/onboarding.js'),
  dashboard: () => import('./pages/dashboard.js'),
  content: () => import('./pages/content.js'),
  calendar: () => import('./pages/calendar.js'),
  planning: () => import('./pages/planning.js'),
  editor: () => import('./pages/editor.js'),
  library: () => import('./pages/library.js'),
  media: () => import('./pages/media.js'),
  settings: () => import('./pages/settings.js'),
};

const NAV_ITEMS = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'calendar', label: 'Calendar' },
  { page: 'planning', label: 'Plan' },
  { page: 'content', label: 'Content' },
  { page: 'library', label: 'Library' },
  { page: 'media', label: 'Media' },
  { page: 'settings', label: 'Settings' },
];

let session = null; // { user, org, role }

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/').filter(Boolean);
  return { page: page || 'dashboard', params: rest };
}

function renderShell() {
  document.getElementById('app').innerHTML = `
    <div class="app-shell">
      <nav class="topnav" id="topnav"></nav>
      <main id="page-root" class="page-root"></main>
    </div>
  `;
}

function renderNav(activePage) {
  const nav = document.getElementById('topnav');
  if (!nav) return;
  nav.innerHTML = `
    <div class="topnav-brand">RG Social Planner</div>
    <div class="topnav-links">
      ${NAV_ITEMS.map(
        (item) => `<a href="#/${item.page}" class="${item.page === activePage ? 'active' : ''}">${item.label}</a>`
      ).join('')}
    </div>
    <button type="button" class="topnav-logout" id="logout-btn">Log out</button>
  `;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    session = null;
    window.location.hash = '#/login';
  });
}

async function ensureSession() {
  if (session) return session;
  const data = await api('/api/me');
  session = data;
  return session;
}

async function router() {
  const { page, params } = parseHash();
  const isPublicPage = page === 'login' || page === 'onboarding';

  if (!isPublicPage) {
    try {
      await ensureSession();
    } catch {
      window.location.hash = '#/login';
      return;
    }
  }

  renderShell();

  if (!isPublicPage) {
    renderNav(page);
  } else {
    document.getElementById('topnav').style.display = 'none';
  }

  const loader = PAGES[page] || PAGES.dashboard;
  const mod = await loader();
  const root = document.getElementById('page-root');
  await mod.render(root, { params, session, navigate: (hash) => (window.location.hash = hash) });
}

async function checkOnboarding() {
  try {
    const status = await api('/api/auth/status');
    return status.needsOnboarding;
  } catch {
    return false;
  }
}

const VERIFY_MESSAGES = {
  success: 'Email verified.',
  invalid: 'That verification link is invalid or has expired.',
  missing: 'That verification link is missing its token.',
};

async function boot() {
  const root = document.getElementById('app');
  root.innerHTML = '<p class="waking">Waking up&hellip; this can take up to a minute after a quiet spell.</p>';

  let healthy = false;
  for (let attempt = 0; attempt < 20 && !healthy; attempt += 1) {
    try {
      await fetch('/health', { cache: 'no-store' });
      healthy = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const searchParams = new URLSearchParams(window.location.search);

  // Password reset/invite links arrive as a real path with a query-string
  // token, outside the hash router and reachable without a session.
  if (window.location.pathname === '/reset-password') {
    renderShell();
    document.getElementById('topnav').style.display = 'none';
    const mod = await import('./pages/reset-password.js');
    await mod.render(document.getElementById('page-root'), { token: searchParams.get('token') });
    return;
  }

  const verifyParam = searchParams.get('verify');
  if (verifyParam) {
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  }

  if (!window.location.hash) {
    const needsOnboarding = await checkOnboarding();
    // Default to dashboard, not login: router() below checks the session
    // itself and falls back to #/login only if there isn't a valid one.
    window.location.hash = needsOnboarding ? '#/onboarding' : '#/dashboard';
  }

  window.addEventListener('hashchange', router);
  await router();

  if (verifyParam && VERIFY_MESSAGES[verifyParam]) {
    toast(VERIFY_MESSAGES[verifyParam], { isError: verifyParam !== 'success' });
  }
}

boot();
