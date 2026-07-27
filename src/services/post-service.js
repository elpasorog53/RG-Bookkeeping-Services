// Section 15's status transition matrix, enforced server-side so illegal
// transitions are rejected the same way no matter what hits the API
// (the UI, a script, curl). 'archived' is not a post_status value -- it's
// the separate archived_at flag, handled by its own functions below.

const FORWARD_TRANSITIONS = {
  idea: ['draft'],
  draft: ['idea', 'ready'],
  ready: ['draft', 'scheduled'],
  scheduled: ['draft', 'published', 'skipped'],
  published: [],
  skipped: [],
};

// Who may archive a post directly from each status (published locks it down
// to Owner only; everything else is O,E per the matrix).
const ARCHIVE_ROLES = {
  idea: ['OWNER', 'EDITOR'],
  draft: ['OWNER', 'EDITOR'],
  ready: ['OWNER', 'EDITOR'],
  scheduled: ['OWNER', 'EDITOR'],
  published: ['OWNER'],
  skipped: ['OWNER', 'EDITOR'],
};

class TransitionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export { TransitionError };

export function canArchive(status, orgRole) {
  return (ARCHIVE_ROLES[status] || []).includes(orgRole);
}

// Validates a requested status change and returns the extra column patches
// it implies (review-gate stamps, cleared schedule, locked timestamps).
// Throws TransitionError on anything illegal; never mutates its input.
export function validateTransition(post, toStatus, { orgRole, actorId, approve, publishedUrls, publishedAt } = {}) {
  const fromStatus = post.status;

  if (!FORWARD_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new TransitionError(`Cannot move a post from "${fromStatus}" to "${toStatus}"`, 409);
  }

  const patch = {};

  if (toStatus === 'ready') {
    if (!post.caption_main || !post.caption_main.trim()) {
      throw new TransitionError('A post needs a caption before it can be marked ready', 400);
    }
    if (!post.platforms || post.platforms.length === 0) {
      throw new TransitionError('A post needs at least one platform before it can be marked ready', 400);
    }
    if (post.needs_review) {
      if (orgRole !== 'OWNER') {
        throw new TransitionError('This post is flagged for review; only the Owner can approve it', 403);
      }
      if (!approve) {
        throw new TransitionError('This post is flagged for review and needs explicit approval (approve: true)', 400);
      }
      patch.reviewed_by = actorId;
      patch.reviewed_at = new Date();
    }
  }

  if (toStatus === 'scheduled') {
    if (!post.planned_date || !post.planned_time) {
      throw new TransitionError('A post needs both a planned date and time before it can be scheduled', 400);
    }
  }

  if (fromStatus === 'ready' && toStatus === 'draft') {
    // Any manual step back out of ready invalidates a prior review approval.
    patch.reviewed_by = null;
    patch.reviewed_at = null;
  }

  if (fromStatus === 'scheduled' && toStatus === 'draft') {
    patch.planned_date = null;
    patch.planned_time = null;
    patch.reviewed_by = null;
    patch.reviewed_at = null;
  }

  if (toStatus === 'published') {
    patch.published_at = publishedAt || new Date();
    if (publishedUrls) patch.published_urls = publishedUrls;
  }

  return patch;
}

// Called from the general PUT handler when a caption field changes on a
// ready/scheduled post ("caption edits return it to draft", section 15) or
// when a scheduled post's date/time is cleared ("auto (date cleared)").
export function autoTransitionForFieldChange(post, incomingFields) {
  const status = post.status;

  // Compares actual values, not mere key presence: the editor always PUTs
  // the whole form, so every key is "in incomingFields" on every save
  // whether or not its value actually changed. Checking presence alone
  // would downgrade a ready/scheduled post back to draft on every edit,
  // even ones that never touched the caption.
  const captionChanged =
    'caption_main' in incomingFields && (incomingFields.caption_main || null) !== (post.caption_main || null);
  const overridesChanged =
    'caption_overrides' in incomingFields &&
    JSON.stringify(incomingFields.caption_overrides || {}) !== JSON.stringify(post.caption_overrides || {});
  const touchesCaption = captionChanged || overridesChanged;

  const dateWasCleared =
    'planned_date' in incomingFields && !incomingFields.planned_date && post.planned_date;
  const timeWasCleared =
    'planned_time' in incomingFields && !incomingFields.planned_time && post.planned_time;
  const clearingDate = status === 'scheduled' && (dateWasCleared || timeWasCleared);

  if ((status === 'ready' || status === 'scheduled') && touchesCaption) {
    return { status: 'draft', reviewed_by: null, reviewed_at: null };
  }
  if (clearingDate) {
    return { status: 'ready' };
  }
  return null;
}

export function lockedFieldsForStatus(status) {
  if (status !== 'published') return null;
  return new Set(['published_urls', 'notes']);
}
