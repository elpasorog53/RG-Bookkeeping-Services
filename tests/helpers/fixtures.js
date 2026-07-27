// Direct-SQL test setup for scenarios HTTP-only onboarding can't reach
// quickly: a second org, or an Editor in an existing org. Bypassing the
// route layer here is fine since these are test fixtures, not assertions.
import { hashPassword, createSession } from '../../src/lib/auth-middleware.js';
import { DEFAULT_PILLARS } from '../../src/lib/seed-data.js';

export async function createOrgWithUser(pool, { orgName, email, displayName, role = 'OWNER', seedPillars = true }) {
  const { rows: orgRows } = await pool.query(
    "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
    [orgName]
  );
  const orgId = orgRows[0].id;

  const passwordHash = await hashPassword('irrelevant-fixture-password');
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1, $2, $3, now()) RETURNING id, email, display_name`,
    [email.toLowerCase(), passwordHash, displayName]
  );
  const userId = userRows[0].id;

  await pool.query('INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    userId,
    role,
  ]);

  await pool.query('INSERT INTO brand_settings (org_id, business_name) VALUES ($1, $2)', [orgId, orgName]);

  if (seedPillars) {
    for (const pillar of DEFAULT_PILLARS) {
      await pool.query(
        `INSERT INTO content_pillars (org_id, name, description, color, requires_review)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, pillar.name, pillar.description, pillar.color, pillar.requires_review]
      );
    }
  }

  return { orgId, userId };
}

export async function loginAs(client, userId) {
  const session = await createSession(userId);
  client.setCookie('rg_session', session.token);
  client.setCookie('rg_csrf', session.csrfToken);
  return session;
}
