import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTransition,
  autoTransitionForFieldChange,
  canArchive,
  TransitionError,
} from '../../src/services/post-service.js';

function basePost(overrides = {}) {
  return {
    status: 'idea',
    caption_main: 'Some caption',
    platforms: ['facebook'],
    needs_review: false,
    planned_date: null,
    planned_time: null,
    ...overrides,
  };
}

const ALL_STATUSES = ['idea', 'draft', 'ready', 'scheduled', 'published', 'skipped'];

const LEGAL_PAIRS = new Set([
  'idea->draft',
  'draft->idea',
  'draft->ready',
  'ready->draft',
  'ready->scheduled',
  'scheduled->draft',
  'scheduled->published',
  'scheduled->skipped',
]);

test('every legal transition pair is accepted with satisfied preconditions', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (from === to) continue;
      const key = `${from}->${to}`;
      const post = basePost({
        status: from,
        planned_date: '2026-08-01',
        planned_time: '09:00',
      });
      if (LEGAL_PAIRS.has(key)) {
        assert.doesNotThrow(() => validateTransition(post, to, { orgRole: 'OWNER' }), `${key} should be legal`);
      } else {
        assert.throws(() => validateTransition(post, to, { orgRole: 'OWNER' }), TransitionError, `${key} should be illegal`);
      }
    }
  }
});

test('draft->ready requires a non-empty caption', () => {
  const post = basePost({ status: 'draft', caption_main: '   ' });
  assert.throws(() => validateTransition(post, 'ready', { orgRole: 'OWNER' }), /caption/);
});

test('draft->ready requires at least one platform', () => {
  const post = basePost({ status: 'draft', platforms: [] });
  assert.throws(() => validateTransition(post, 'ready', { orgRole: 'OWNER' }), /platform/);
});

test('ready->scheduled requires both planned_date and planned_time', () => {
  const post = basePost({ status: 'ready', planned_date: null, planned_time: null });
  assert.throws(() => validateTransition(post, 'scheduled', { orgRole: 'OWNER' }), /date and time/);
});

test('draft->ready is blocked for a review-flagged post without owner approval', () => {
  const post = basePost({ status: 'draft', needs_review: true });
  assert.throws(() => validateTransition(post, 'ready', { orgRole: 'EDITOR' }), /Owner/);
  assert.throws(() => validateTransition(post, 'ready', { orgRole: 'OWNER' }), /explicit approval/);
});

test('draft->ready succeeds for a review-flagged post when the owner approves', () => {
  const post = basePost({ status: 'draft', needs_review: true });
  const patch = validateTransition(post, 'ready', { orgRole: 'OWNER', approve: true, actorId: 'owner-1' });
  assert.equal(patch.reviewed_by, 'owner-1');
  assert.ok(patch.reviewed_at instanceof Date);
});

test('ready->draft clears a prior review approval', () => {
  const post = basePost({ status: 'ready' });
  const patch = validateTransition(post, 'draft', { orgRole: 'EDITOR' });
  assert.equal(patch.reviewed_by, null);
  assert.equal(patch.reviewed_at, null);
});

test('scheduled->draft (unschedule) clears the planned date/time and review stamp', () => {
  const post = basePost({ status: 'scheduled', planned_date: '2026-08-01', planned_time: '09:00' });
  const patch = validateTransition(post, 'draft', { orgRole: 'OWNER' });
  assert.equal(patch.planned_date, null);
  assert.equal(patch.planned_time, null);
});

test('scheduled->published stamps published_at and accepts published_urls', () => {
  const post = basePost({ status: 'scheduled', planned_date: '2026-08-01', planned_time: '09:00' });
  const patch = validateTransition(post, 'published', {
    orgRole: 'EDITOR',
    publishedUrls: { facebook: 'https://facebook.com/x' },
  });
  assert.ok(patch.published_at instanceof Date);
  assert.equal(patch.published_urls.facebook, 'https://facebook.com/x');
});

test('published is a dead end for forward transitions', () => {
  const post = basePost({ status: 'published' });
  for (const to of ['idea', 'draft', 'ready', 'scheduled', 'skipped']) {
    assert.throws(() => validateTransition(post, to, { orgRole: 'OWNER' }), TransitionError);
  }
});

test('autoTransitionForFieldChange drops a ready post back to draft on caption edit', () => {
  const post = basePost({ status: 'ready' });
  const result = autoTransitionForFieldChange(post, { caption_main: 'new text' });
  assert.equal(result.status, 'draft');
  assert.equal(result.reviewed_by, null);
});

test('autoTransitionForFieldChange drops a scheduled post back to draft on caption edit', () => {
  const post = basePost({ status: 'scheduled' });
  const result = autoTransitionForFieldChange(post, { caption_overrides: { facebook: 'x' } });
  assert.equal(result.status, 'draft');
});

test('autoTransitionForFieldChange promotes scheduled back to ready when the date is cleared', () => {
  const post = basePost({ status: 'scheduled', planned_date: '2026-08-01', planned_time: '09:00' });
  const result = autoTransitionForFieldChange(post, { planned_date: null });
  assert.equal(result.status, 'ready');
});

test('autoTransitionForFieldChange is a no-op for unrelated field changes or other statuses', () => {
  const draftPost = basePost({ status: 'draft' });
  assert.equal(autoTransitionForFieldChange(draftPost, { caption_main: 'x' }), null);

  const readyPost = basePost({ status: 'ready' });
  assert.equal(autoTransitionForFieldChange(readyPost, { notes: 'x' }), null);
});

test('autoTransitionForFieldChange is a no-op when the editor resubmits the full form unchanged (regression: presence vs value)', () => {
  // The real editor always PUTs every field, not a diff. If the check only
  // asked "is caption_main a key here" it would misfire on every save.
  const post = basePost({
    status: 'ready',
    caption_main: 'Unchanged caption',
    caption_overrides: { facebook: 'Unchanged override' },
    planned_date: '2026-08-01',
    planned_time: '09:00',
  });
  const fullFormResubmit = {
    title: post.title,
    pillar_id: null,
    campaign: null,
    platforms: post.platforms,
    caption_main: post.caption_main,
    caption_overrides: post.caption_overrides,
    hashtags: null,
    cta: null,
    link_url: null,
    planned_date: post.planned_date,
    planned_time: post.planned_time,
    needs_review: false,
    disclaimer_required: false,
    is_evergreen: false,
    reuse_interval_days: null,
    notes: 'just updating notes',
    media_instructions: null,
  };
  assert.equal(autoTransitionForFieldChange(post, fullFormResubmit), null);
});

test('autoTransitionForFieldChange still fires when the full form carries an actually-changed caption', () => {
  const post = basePost({ status: 'ready', caption_main: 'Original' });
  const fullForm = { ...post, caption_main: 'Original text, edited' };
  const result = autoTransitionForFieldChange(post, fullForm);
  assert.equal(result.status, 'draft');
});

test('autoTransitionForFieldChange does not treat an unchanged planned_date as clearing it', () => {
  const post = basePost({ status: 'scheduled', planned_date: '2026-08-01', planned_time: '09:00' });
  const fullFormResubmit = { ...post, planned_date: '2026-08-01', planned_time: '09:00' };
  assert.equal(autoTransitionForFieldChange(post, fullFormResubmit), null);
});

test('canArchive follows the matrix: published requires Owner, everything else allows Editor', () => {
  assert.equal(canArchive('idea', 'EDITOR'), true);
  assert.equal(canArchive('draft', 'EDITOR'), true);
  assert.equal(canArchive('ready', 'EDITOR'), true);
  assert.equal(canArchive('scheduled', 'EDITOR'), true);
  assert.equal(canArchive('skipped', 'EDITOR'), true);
  assert.equal(canArchive('published', 'EDITOR'), false);
  assert.equal(canArchive('published', 'OWNER'), true);
});
