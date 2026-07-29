import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CONFIG_ENCRYPTION_KEY = '0'.repeat(64);
const { encryptSecret, decryptSecret } = await import('../../src/lib/config-crypto.js');

test('encryptSecret/decryptSecret round-trips a plaintext value', () => {
  const encrypted = encryptSecret('sk-ant-super-secret-key-12345');
  assert.notEqual(encrypted, 'sk-ant-super-secret-key-12345');
  assert.match(encrypted, /^enc:v1:[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
  assert.equal(decryptSecret(encrypted), 'sk-ant-super-secret-key-12345');
});

test('encrypting the same value twice produces different ciphertext (random IV)', () => {
  const a = encryptSecret('same-value');
  const b = encryptSecret('same-value');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'same-value');
  assert.equal(decryptSecret(b), 'same-value');
});

test('decryptSecret rejects a tampered ciphertext (GCM auth tag catches it)', () => {
  const encrypted = encryptSecret('sk-ant-secret');
  const parts = encrypted.split(':');
  // Flip a hex character in the ciphertext portion.
  const tampered = parts[4][0] === 'a' ? 'b' + parts[4].slice(1) : 'a' + parts[4].slice(1);
  parts[4] = tampered;
  assert.throws(() => decryptSecret(parts.join(':')));
});

test('decryptSecret rejects a malformed payload', () => {
  assert.throws(() => decryptSecret('not-the-right-format'));
  assert.throws(() => decryptSecret('enc:v2:aa:bb:cc'));
});

test('encryptSecret throws a clear error when CONFIG_ENCRYPTION_KEY is missing or the wrong length', async () => {
  const original = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = 'too-short';
  assert.throws(() => encryptSecret('x'), /64-character hex string/);
  process.env.CONFIG_ENCRYPTION_KEY = original;
});
