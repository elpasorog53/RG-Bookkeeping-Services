import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupTestDatabase, teardownTestDatabase, resetTestData } from '../helpers/db-fixture.js';
import { createClient } from '../helpers/http-client.js';
import { createOrgWithUser, loginAs } from '../helpers/fixtures.js';

process.env.NODE_ENV = 'test';

let server;
let baseUrl;
let pool;

const todayStr = new Date().toISOString().slice(0, 10);
const todayDayOfMonth = Number(todayStr.slice(8, 10));

test.before(async () => {
  await setupTestDatabase();
  const dbModule = await import('../../src/lib/db.js');
  pool = dbModule.getPool();
  const { default: app } = await import('../../src/index.js');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await teardownTestDatabase();
});

test.beforeEach(async () => {
  await resetTestData(pool);
});

async function setupOrgWithTemplate(pool, orgName, emailPrefix) {
  const { orgId, userId: ownerId } = await createOrgWithUser(pool, {
    orgName,
    email: `${emailPrefix}-owner@example.com`,
    displayName: 'Owner',
    role: 'OWNER',
  });
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1, 'x', 'Editor', now()) RETURNING id`,
    [`${emailPrefix}-editor@example.com`]
  );
  const editorId = rows[0].id;
  await pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')", [orgId, editorId]);

  const owner = createClient(baseUrl);
  await loginAs(owner, ownerId);
  const editor = createClient(baseUrl);
  await loginAs(editor, editorId);

  const template = await owner.post('/api/templates', {
    name: 'Quarterly Tip',
    body: 'Here is a scheduled tip.',
    platforms: ['facebook'],
  });

  return { orgId, owner, editor, templateId: template.data.template.id };
}

test('owner can create, list, update, and delete a recurrence rule; editor is read-only', async () => {
  const { owner, editor, templateId } = await setupOrgWithTemplate(pool, 'Recurrence Org A', 'ra');

  const created = await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2026-06-01',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.rule.frequency, 'weekly');

  const editorList = await editor.get('/api/recurrence-rules');
  assert.equal(editorList.status, 200);
  assert.equal(editorList.data.rules.length, 1);
  assert.equal(editorList.data.rules[0].template_name, 'Quarterly Tip');

  const editorCreate = await editor.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'weekly',
    day_of_week: 2,
    start_on: '2026-06-01',
  });
  assert.equal(editorCreate.status, 403);

  const updated = await owner.put(`/api/recurrence-rules/${created.data.rule.id}`, { lead_time_days: 14 });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.rule.lead_time_days, 14);

  const editorDelete = await editor.del(`/api/recurrence-rules/${created.data.rule.id}`);
  assert.equal(editorDelete.status, 403);

  const deleted = await owner.del(`/api/recurrence-rules/${created.data.rule.id}`);
  assert.equal(deleted.status, 204);

  const afterDelete = await owner.get('/api/recurrence-rules');
  assert.equal(afterDelete.data.rules.length, 0);
});

test('create rejects a template from another org, and missing frequency-specific fields', async () => {
  const { owner } = await setupOrgWithTemplate(pool, 'Recurrence Org B', 'rb');
  const { templateId: otherOrgTemplateId } = await setupOrgWithTemplate(pool, 'Recurrence Org B2', 'rb2');

  const foreignTemplate = await owner.post('/api/recurrence-rules', {
    template_id: otherOrgTemplateId,
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2026-06-01',
  });
  assert.equal(foreignTemplate.status, 400);
  assert.match(foreignTemplate.data.error, /Template not found/);

  const templateId = (await owner.get('/api/templates')).data.templates[0].id;
  const missingDay = await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'weekly',
    start_on: '2026-06-01',
  });
  assert.equal(missingDay.status, 400);
  assert.match(missingDay.data.error, /day_of_week/);

  const missingYearly = await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'yearly',
    day_of_month: 15,
    start_on: '2026-06-01',
  });
  assert.equal(missingYearly.status, 400);
  assert.match(missingYearly.data.error, /month_of_year/);
});

test('create rejects end_on before start_on', async () => {
  const { owner, templateId } = await setupOrgWithTemplate(pool, 'Recurrence Org C', 'rc');
  const res = await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'monthly',
    day_of_month: 15,
    start_on: '2026-06-01',
    end_on: '2026-01-01',
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /end_on cannot be before start_on/);
});

test('update re-validates the merged state: switching frequency without its fields is rejected', async () => {
  const { owner, templateId } = await setupOrgWithTemplate(pool, 'Recurrence Org D', 'rd');
  const created = await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2026-06-01',
  });

  const switched = await owner.put(`/api/recurrence-rules/${created.data.rule.id}`, { frequency: 'yearly' });
  assert.equal(switched.status, 400);
  assert.match(switched.data.error, /day_of_month/);
});

test('a rule created with a start_on far in the past is fast-forwarded so it does not backfill history', async () => {
  const { owner, templateId } = await setupOrgWithTemplate(pool, 'Recurrence Org E', 're');
  const created = await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2020-01-01',
    lead_time_days: 0,
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.rule.last_generated_for, 'last_generated_for should be fast-forwarded, not null');
  assert.ok(created.data.rule.last_generated_for < todayStr);

  const run = await owner.post('/api/recurrence-rules/run');
  assert.equal(run.status, 200);
  assert.equal(run.data.generated.length, 0, 'no backlog of missed weekly occurrences should be generated');
});

test('/run generates a due post from the template, is idempotent, and honors requires_date_verification', async () => {
  const { owner, templateId } = await setupOrgWithTemplate(pool, 'Recurrence Org F', 'rf');
  const created = await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'monthly',
    day_of_month: todayDayOfMonth,
    start_on: todayStr,
    lead_time_days: 0,
    requires_review: false,
    requires_date_verification: true,
  });
  assert.equal(created.status, 201);

  const firstRun = await owner.post('/api/recurrence-rules/run');
  assert.equal(firstRun.status, 200);
  assert.equal(firstRun.data.generated.length, 1);
  assert.equal(firstRun.data.generated[0].plannedDate, todayStr);

  const post = await owner.get(`/api/posts/${firstRun.data.generated[0].postId}`);
  assert.equal(post.status, 200);
  assert.equal(post.data.post.status, 'draft');
  assert.equal(post.data.post.caption_main, 'Here is a scheduled tip.');
  assert.deepEqual(post.data.post.platforms, ['facebook']);
  assert.equal(post.data.post.needs_review, true, 'requires_date_verification forces needs_review even if requires_review is false');
  assert.match(post.data.post.notes, /verify the specific date/);

  const secondRun = await owner.post('/api/recurrence-rules/run');
  assert.equal(secondRun.status, 200);
  assert.equal(secondRun.data.generated.length, 0, 'the same occurrence must not be generated twice');
});

test('/run generates nothing for a paused rule', async () => {
  const { owner, templateId } = await setupOrgWithTemplate(pool, 'Recurrence Org G', 'rg');
  await owner.post('/api/recurrence-rules', {
    template_id: templateId,
    frequency: 'monthly',
    day_of_month: todayDayOfMonth,
    start_on: todayStr,
    lead_time_days: 0,
    is_paused: true,
  });

  const run = await owner.post('/api/recurrence-rules/run');
  assert.equal(run.status, 200);
  assert.equal(run.data.generated.length, 0);
});

test('a recurrence rule belonging to another org is invisible (404, not leaked)', async () => {
  const { owner: ownerH, templateId: templateHId } = await setupOrgWithTemplate(pool, 'Recurrence Org H', 'rh');
  const { owner: ownerI } = await setupOrgWithTemplate(pool, 'Recurrence Org I', 'ri');

  const created = await ownerH.post('/api/recurrence-rules', {
    template_id: templateHId,
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2026-06-01',
  });
  assert.equal(created.status, 201);

  const crossOrgUpdate = await ownerI.put(`/api/recurrence-rules/${created.data.rule.id}`, { lead_time_days: 1 });
  assert.equal(crossOrgUpdate.status, 404);

  const crossOrgDelete = await ownerI.del(`/api/recurrence-rules/${created.data.rule.id}`);
  assert.equal(crossOrgDelete.status, 404);
});
