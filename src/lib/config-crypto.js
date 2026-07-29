import crypto from 'node:crypto';

// AES-256-GCM, format "enc:v1:iv:tag:ciphertext" (all hex). Matches the
// Atlas app_config pattern (section 10/18): secrets editable from Settings,
// encrypted at rest, decrypted only in memory when actually used.
const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.CONFIG_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('CONFIG_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload) {
  const parts = payload.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Invalid encrypted payload format');
  }
  const [, , ivHex, tagHex, dataHex] = parts;
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
