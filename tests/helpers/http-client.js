// Minimal cookie-jar fetch wrapper so integration tests can carry a session
// across requests the same way a browser would.
export function createClient(baseUrl) {
  let cookies = {};

  function cookieHeader() {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  function updateCookies(res) {
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of setCookie) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }

  async function request(method, requestPath, body) {
    const headers = {};
    const ch = cookieHeader();
    if (ch) headers.cookie = ch;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && cookies.rg_csrf) {
      headers['x-csrf-token'] = decodeURIComponent(cookies.rg_csrf);
    }

    const res = await fetch(`${baseUrl}${requestPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    updateCookies(res);

    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : null;
    return { status: res.status, data, headers: res.headers };
  }

  return {
    get: (p) => request('GET', p),
    post: (p, body) => request('POST', p, body),
    put: (p, body) => request('PUT', p, body),
    del: (p) => request('DELETE', p),
    getCookie: (name) => cookies[name],
    setCookie: (name, value) => {
      cookies[name] = encodeURIComponent(value);
    },
    clearCookies: () => {
      cookies = {};
    },
  };
}
