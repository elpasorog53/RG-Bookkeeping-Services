import crypto from 'node:crypto';

// Raw REST calls to Supabase Storage using the service-role key, exactly the
// Atlas pattern (section 9/18/27) but private + signed URLs instead of a
// public bucket, since nothing here needs Meta to fetch images by URL.

function bucket() {
  return process.env.STORAGE_BUCKET_MEDIA || 'rg-media';
}

function baseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url || url === 'your-supabase-project-url') {
    throw new Error('Storage is not configured: SUPABASE_URL is missing');
  }
  return url.replace(/\/$/, '');
}

function authHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key === 'your-service-role-key') {
    throw new Error('Storage is not configured: SUPABASE_SERVICE_ROLE_KEY is missing');
  }
  // Supabase's gateway routes on the `apikey` header and only uses the
  // Authorization bearer token for the actual permission check; omitting
  // apikey can make it fall through to JWT-parsing logic that rejects the
  // newer non-JWT `sb_secret_...` key format ("Invalid Compact JWS").
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(-100);
}

export function buildObjectPath(orgId, fileName) {
  return `org/${orgId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
}

export async function uploadObject(objectPath, buffer, mimeType) {
  const res = await fetch(`${baseUrl()}/storage/v1/object/${bucket()}/${objectPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': mimeType, 'x-upsert': 'false' },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed (${res.status}): ${await res.text()}`);
  }
}

export async function createSignedUrl(objectPath, expiresInSeconds = 3600) {
  const res = await fetch(`${baseUrl()}/storage/v1/object/sign/${bucket()}/${objectPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) {
    throw new Error(`Storage sign failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return `${baseUrl()}/storage/v1${data.signedURL}`;
}

export async function deleteObjects(objectPaths) {
  if (objectPaths.length === 0) return;
  const res = await fetch(`${baseUrl()}/storage/v1/object/${bucket()}`, {
    method: 'DELETE',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: objectPaths }),
  });
  if (!res.ok) {
    throw new Error(`Storage delete failed (${res.status}): ${await res.text()}`);
  }
}

export async function listAllObjects(prefix) {
  const res = await fetch(`${baseUrl()}/storage/v1/object/list/${bucket()}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000 }),
  });
  if (!res.ok) {
    throw new Error(`Storage list failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4']);
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
