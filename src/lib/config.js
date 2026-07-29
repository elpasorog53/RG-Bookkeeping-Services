import { query } from './db.js';
import { encryptSecret, decryptSecret } from './config-crypto.js';

const PLACEHOLDER_PREFIX = 'your-';

// Resolution order: app_config (encrypted, UI-editable) first, then an env
// var fallback -- matches the Atlas getConfig() pattern (section 27).
export async function getConfig(key) {
  const { rows } = await query('SELECT encrypted_value FROM app_config WHERE key = $1', [key]);
  if (rows.length > 0) {
    try {
      return decryptSecret(rows[0].encrypted_value);
    } catch {
      return null;
    }
  }
  const envVal = process.env[key];
  if (envVal && !envVal.startsWith(PLACEHOLDER_PREFIX)) return envVal;
  return null;
}

export async function setConfig(key, value) {
  const encrypted = encryptSecret(value);
  await query(
    `INSERT INTO app_config (key, encrypted_value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET encrypted_value = $2, updated_at = now()`,
    [key, encrypted]
  );
}

export async function clearConfig(key) {
  await query('DELETE FROM app_config WHERE key = $1', [key]);
}

export async function hasConfig(key) {
  const value = await getConfig(key);
  return Boolean(value);
}
