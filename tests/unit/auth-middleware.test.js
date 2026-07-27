import test from 'node:test';
import assert from 'node:assert/strict';
import { requireCsrf } from '../../src/lib/auth-middleware.js';

function mockReqRes({ method, cookie, csrfHeader }) {
  const req = { method, headers: { cookie, 'x-csrf-token': csrfHeader } };
  let statusCode = 200;
  let body;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, getStatus: () => statusCode, getBody: () => body, wasNextCalled: () => nextCalled };
}

test('requireCsrf allows GET requests without a csrf header', () => {
  const { req, res, next, wasNextCalled } = mockReqRes({ method: 'GET' });
  requireCsrf(req, res, next);
  assert.equal(wasNextCalled(), true);
});

test('requireCsrf rejects a POST with a missing csrf header', () => {
  const { req, res, next, wasNextCalled, getStatus } = mockReqRes({
    method: 'POST',
    cookie: 'rg_csrf=abc123',
  });
  requireCsrf(req, res, next);
  assert.equal(wasNextCalled(), false);
  assert.equal(getStatus(), 403);
});

test('requireCsrf rejects a POST where the header does not match the cookie', () => {
  const { req, res, next, wasNextCalled, getStatus } = mockReqRes({
    method: 'POST',
    cookie: 'rg_csrf=abc123',
    csrfHeader: 'different-token',
  });
  requireCsrf(req, res, next);
  assert.equal(wasNextCalled(), false);
  assert.equal(getStatus(), 403);
});

test('requireCsrf allows a POST where the header matches the cookie', () => {
  const { req, res, next, wasNextCalled } = mockReqRes({
    method: 'POST',
    cookie: 'rg_csrf=abc123',
    csrfHeader: 'abc123',
  });
  requireCsrf(req, res, next);
  assert.equal(wasNextCalled(), true);
});
