import test from 'node:test';
import assert from 'node:assert/strict';
import { onboardSchema, loginSchema, resetSchema } from '../../src/routes/auth.js';

test('onboardSchema rejects a short password', () => {
  const result = onboardSchema.safeParse({
    orgName: 'RG Bookkeeping',
    displayName: 'Jeremy',
    email: 'jeremy@example.com',
    password: 'short',
  });
  assert.equal(result.success, false);
});

test('onboardSchema defaults timezone when omitted', () => {
  const result = onboardSchema.safeParse({
    orgName: 'RG Bookkeeping',
    displayName: 'Jeremy',
    email: 'jeremy@example.com',
    password: 'a-long-enough-password',
  });
  assert.equal(result.success, true);
  assert.equal(result.data.timezone, 'America/New_York');
});

test('loginSchema rejects invalid email', () => {
  const result = loginSchema.safeParse({ email: 'not-an-email', password: 'x' });
  assert.equal(result.success, false);
});

test('resetSchema requires both token and newPassword', () => {
  const result = resetSchema.safeParse({ token: 'abc' });
  assert.equal(result.success, false);
});
