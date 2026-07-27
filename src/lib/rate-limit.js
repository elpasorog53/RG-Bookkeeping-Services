// Simple in-memory fixed-window limiter (section 18: 10/min/IP on auth,
// 30/hour/user on AI). Single Node process, no external store needed.
const buckets = new Map();

export function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too many requests, try again shortly' });
    }

    bucket.count += 1;
    next();
  };
}

export function ipKey(req) {
  return req.ip;
}

// Test-only: clears all buckets so integration tests don't trip a shared
// limiter just because many tests run against the same loopback IP.
export function __resetRateLimits() {
  buckets.clear();
}
