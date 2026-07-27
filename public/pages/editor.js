import { api, escapeHtml, toast } from '../app.js';

const STATUS_LABELS = {
  idea: 'Idea',
  draft: 'Draft',
  ready: 'Ready',
  scheduled: 'Scheduled',
  published: 'Published',
  skipped: 'Skipped',
};

// navigator.clipboard.writeText can reject even when the Permissions API
// reports "granted" (no user-activation, insecure context, browser policy).
// Fall back to the older execCommand path so a denied async write doesn't
// silently do nothing.
async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path below
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function buildPlatformCaption(post, hashtags, linkUrl, platformKey) {
  const base = (post.caption_overrides && post.caption_overrides[platformKey]) || post.caption_main || '';
  const parts = [base];
  if (hashtags) parts.push(hashtags);
  if (linkUrl) parts.push(linkUrl);
  return parts.filter(Boolean).join('\n\n');
}

export async function render(root, { params, session }) {
  const isNew = params[0] === 'new';
  const postId = isNew ? null : params[0];
  const isOwner = session.role === 'OWNER';

  const [pillarsData, platformsData] = await Promise.all([
    api('/api/pillars'),
    api('/api/settings/platforms'),
  ]);
  const platformsByKey = new Map(platformsData.platforms.map((p) => [p.key, p]));

  let post = isNew
    ? {
        id: null,
        title: '',
        status: 'idea',
        pillar_id: null,
        campaign: '',
        platforms: [],
        caption_main: '',
        caption_overrides: {},
        hashtags: '',
        cta: '',
        link_url: '',
        planned_date: null,
        planned_time: null,
        needs_review: false,
        disclaimer_required: false,
        is_evergreen: false,
        reuse_interval_days: null,
        notes: '',
        media_instructions: '',
        archived_at: null,
        updated_at: null,
        published_urls: {},
      }
    : (await api(`/api/posts/${postId}`)).post;

  let mediaItems = post.id ? (await api(`/api/posts/${post.id}/media`)).media : [];

  let dirty = false;
  let saving = false;
  let saveTimer = null;

  function fieldValue(id) {
    const el = document.getElementById(id);
    if (!el) return undefined;
    if (el.type === 'checkbox') return el.checked;
    return el.value;
  }

  function collectFields() {
    const platforms = Array.from(document.querySelectorAll('.platform-check:checked')).map((el) => el.value);
    const captionOverrides = {};
    document.querySelectorAll('.caption-override').forEach((el) => {
      if (el.value.trim()) captionOverrides[el.dataset.platform] = el.value;
    });
    return {
      title: fieldValue('f-title'),
      pillar_id: fieldValue('f-pillar') || null,
      campaign: fieldValue('f-campaign') || null,
      platforms,
      caption_main: fieldValue('f-caption') || null,
      caption_overrides: captionOverrides,
      hashtags: fieldValue('f-hashtags') || null,
      cta: fieldValue('f-cta') || null,
      link_url: fieldValue('f-link') || null,
      planned_date: fieldValue('f-date') || null,
      planned_time: fieldValue('f-time') || null,
      needs_review: fieldValue('f-needs-review'),
      disclaimer_required: fieldValue('f-disclaimer'),
      is_evergreen: fieldValue('f-evergreen'),
      reuse_interval_days: fieldValue('f-reuse-days') ? Number(fieldValue('f-reuse-days')) : null,
      notes: fieldValue('f-notes') || null,
      media_instructions: fieldValue('f-media-instructions') || null,
    };
  }

  async function save({ silent = false } = {}) {
    if (saving) return;
    saving = true;
    try {
      const fields = collectFields();
      if (!fields.title || !fields.title.trim()) {
        saving = false;
        return;
      }

      const wasNew = !post.id;
      if (wasNew) {
        const created = await api('/api/posts', {
          method: 'POST',
          body: { ...fields, status: 'idea' },
        });
        post = created.post;
        window.history.replaceState({}, '', `#/editor/${post.id}`);
        if (!silent) toast('Draft created');
      } else {
        const updated = await api(`/api/posts/${post.id}`, {
          method: 'PUT',
          body: { ...fields, expected_updated_at: post.updated_at },
        });
        post = updated.post;
        if (!silent) toast('Saved');
      }
      dirty = false;

      if (wasNew) {
        // The Media card and the action-button row both depend on post.id
        // existing, so the very first save needs a full re-render, not just
        // the status label. Later saves stay light (see below) so autosave
        // doesn't blur an actively-focused field mid-typing.
        mediaItems = (await api(`/api/posts/${post.id}/media`)).media;
        renderAll();
      } else {
        updateStatusBar();
      }
    } catch (err) {
      if (err.status === 409) {
        toast('This post changed elsewhere. Reload before saving again.', { isError: true });
      } else {
        toast(err.message, { isError: true });
      }
    } finally {
      saving = false;
    }
  }

  function scheduleAutosave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({ silent: true }), 2000);
  }

  async function transition(to, extra = {}) {
    if (!post.id) {
      toast('Save the post first', { isError: true });
      return;
    }
    try {
      const result = await api(`/api/posts/${post.id}/transition`, { method: 'POST', body: { to, ...extra } });
      post = result.post;
      toast(`Status: ${STATUS_LABELS[post.status]}`);
      renderAll();
    } catch (err) {
      toast(err.message, { isError: true });
    }
  }

  async function archiveOrRestore(action) {
    try {
      const result = await api(`/api/posts/${post.id}/${action}`, { method: 'POST' });
      post = result.post;
      toast(action === 'archive' ? 'Archived' : 'Restored');
      renderAll();
    } catch (err) {
      toast(err.message, { isError: true });
    }
  }

  function updateStatusBar() {
    const bar = document.getElementById('status-bar');
    if (bar) bar.textContent = `Status: ${STATUS_LABELS[post.status]}${post.archived_at ? ' (archived)' : ''}`;
  }

  function actionButtons() {
    if (post.archived_at) {
      const buttons = [];
      if (isOwner) buttons.push(`<button class="btn secondary" id="btn-restore">Restore</button>`);
      if (isOwner) buttons.push(`<button class="btn danger" id="btn-delete">Delete permanently</button>`);
      return buttons.join(' ');
    }

    const buttons = [];
    const s = post.status;
    if (s === 'idea') buttons.push(`<button class="btn" data-to="draft">Start writing</button>`);
    if (s === 'draft') {
      buttons.push(`<button class="btn" data-to="ready">Mark ready</button>`);
    }
    if (s === 'ready') {
      buttons.push(`<button class="btn secondary" data-to="draft">Back to draft</button>`);
      buttons.push(`<button class="btn" data-to="scheduled">Schedule</button>`);
    }
    if (s === 'scheduled') {
      buttons.push(`<button class="btn secondary" data-to="draft">Unschedule</button>`);
      buttons.push(`<button class="btn" id="btn-mark-published">Mark Published&hellip;</button>`);
      buttons.push(`<button class="btn secondary" data-to="skipped">Skip</button>`);
    }
    if (s === 'skipped') {
      buttons.push(`<button class="btn secondary" id="btn-reuse">Reuse as new draft</button>`);
    }
    if (post.id && s !== 'published') {
      buttons.push(`<button class="btn secondary" id="btn-archive">Archive</button>`);
    }
    if (post.id && s === 'published' && isOwner) {
      buttons.push(`<button class="btn secondary" id="btn-archive">Archive</button>`);
    }
    return buttons.join(' ');
  }

  function needsReviewNotice() {
    if (post.status !== 'draft' || !post.needs_review) return '';
    if (post.reviewed_by) return '<p class="notice">Previously approved; re-approval needed if the caption changes again.</p>';
    if (!isOwner) return '<p class="notice">This post is flagged for review. Only the Owner can approve it.</p>';
    return `
      <div class="notice">
        <label><input type="checkbox" id="f-approve" /> I approve this flagged post</label>
      </div>
    `;
  }

  function platformCheckboxes() {
    return platformsData.platforms
      .map((p) => {
        const checked = post.platforms.includes(p.key) ? 'checked' : '';
        return `<label class="platform-toggle"><input type="checkbox" class="platform-check" value="${p.key}" ${checked} /> ${escapeHtml(p.label)}</label>`;
      })
      .join(' ');
  }

  function captionOverrideBlocks() {
    return post.platforms
      .map((key) => {
        const platform = platformsByKey.get(key);
        const value = (post.caption_overrides && post.caption_overrides[key]) || '';
        return `
          <div class="form-field">
            <label>${escapeHtml(platform ? platform.label : key)} override (optional)</label>
            <textarea class="caption-override" data-platform="${key}" rows="2">${escapeHtml(value)}</textarea>
            <span class="char-count" data-platform-count="${key}"></span>
          </div>
        `;
      })
      .join('');
  }

  function copyButtons() {
    return post.platforms
      .map((key) => `<button class="btn secondary copy-btn" data-platform="${key}">Copy ${escapeHtml(key)}</button>`)
      .join(' ');
  }

  function mediaListMarkup() {
    if (mediaItems.length === 0) return '<p class="empty-state">No media attached.</p>';
    return mediaItems
      .map(
        (m, i) => `
      <div class="editor-media-item">
        ${
          m.kind === 'image'
            ? `<img src="${escapeHtml(m.signedUrl)}" alt="${escapeHtml(m.file_name)}" />`
            : `<video src="${escapeHtml(m.signedUrl)}" muted></video>`
        }
        ${
          post.status !== 'published'
            ? `
          <div class="editor-media-item-actions">
            <button class="media-move-up" data-id="${m.id}" ${i === 0 ? 'disabled' : ''} title="Move earlier">&uarr;</button>
            <button class="media-move-down" data-id="${m.id}" ${i === mediaItems.length - 1 ? 'disabled' : ''} title="Move later">&darr;</button>
            <button class="media-detach" data-id="${m.id}" title="Remove">&times;</button>
          </div>
        `
            : ''
        }
      </div>
    `
      )
      .join('');
  }

  function updateCharCounts() {
    const hashtags = fieldValue('f-hashtags') || '';
    const linkUrl = fieldValue('f-link') || '';
    post.platforms.forEach((key) => {
      const platform = platformsByKey.get(key);
      if (!platform) return;
      const overrideEl = document.querySelector(`.caption-override[data-platform="${key}"]`);
      const text = buildPlatformCaption(
        { ...post, caption_main: fieldValue('f-caption'), caption_overrides: { [key]: overrideEl ? overrideEl.value : '' } },
        hashtags,
        linkUrl,
        key
      );
      const countEl = document.querySelector(`[data-platform-count="${key}"]`);
      if (!countEl) return;
      const len = text.length;
      let cls = '';
      if (platform.char_hard_limit && len > platform.char_hard_limit) cls = 'char-count-over';
      else if (platform.char_soft_limit && len > platform.char_soft_limit) cls = 'char-count-warn';
      countEl.className = `char-count ${cls}`;
      countEl.textContent = `${len}${platform.char_hard_limit ? ` / ${platform.char_hard_limit}` : ''}`;
    });
  }

  function renderAll() {
    const locked = post.status === 'published';
    root.innerHTML = `
      <div class="editor-page">
        <div class="editor-header">
          <a href="#/content" class="btn secondary">&larr; Back</a>
          <span id="status-bar" class="status-bar">Status: ${STATUS_LABELS[post.status]}${post.archived_at ? ' (archived)' : ''}</span>
        </div>

        ${needsReviewNotice()}

        <div class="form-field">
          <label for="f-title">Title</label>
          <input id="f-title" value="${escapeHtml(post.title)}" maxlength="300" ${locked ? '' : ''} />
        </div>

        <div class="editor-row">
          <div class="form-field">
            <label for="f-pillar">Pillar</label>
            <select id="f-pillar" ${locked ? 'disabled' : ''}>
              <option value="">No pillar</option>
              ${pillarsData.pillars
                .map(
                  (p) =>
                    `<option value="${p.id}" ${post.pillar_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="form-field">
            <label for="f-campaign">Campaign</label>
            <input id="f-campaign" value="${escapeHtml(post.campaign || '')}" ${locked ? 'disabled' : ''} />
          </div>
        </div>

        <div class="form-field">
          <label>Platforms</label>
          <div class="platform-toggles" id="platform-toggles">${platformCheckboxes()}</div>
        </div>

        <div class="editor-columns">
          <div>
            <div class="form-field">
              <label for="f-caption">Caption</label>
              <textarea id="f-caption" rows="6" ${locked ? 'disabled' : ''}>${escapeHtml(post.caption_main || '')}</textarea>
            </div>
            <div id="caption-overrides">${captionOverrideBlocks()}</div>
            <div class="editor-row">
              <div class="form-field">
                <label for="f-hashtags">Hashtags</label>
                <input id="f-hashtags" value="${escapeHtml(post.hashtags || '')}" ${locked ? 'disabled' : ''} />
              </div>
              <div class="form-field">
                <label for="f-cta">CTA</label>
                <input id="f-cta" value="${escapeHtml(post.cta || '')}" ${locked ? 'disabled' : ''} />
              </div>
            </div>
            <div class="form-field">
              <label for="f-link">Link URL</label>
              <input id="f-link" value="${escapeHtml(post.link_url || '')}" ${locked ? 'disabled' : ''} />
            </div>
          </div>
          <div>
            <div class="editor-row">
              <div class="form-field">
                <label for="f-date">Date</label>
                <input id="f-date" type="date" value="${post.planned_date || ''}" ${locked ? 'disabled' : ''} />
              </div>
              <div class="form-field">
                <label for="f-time">Time</label>
                <input id="f-time" type="time" value="${post.planned_time ? post.planned_time.slice(0, 5) : ''}" ${locked ? 'disabled' : ''} />
              </div>
            </div>
            <div class="form-field">
              <label><input type="checkbox" id="f-needs-review" ${post.needs_review ? 'checked' : ''} ${locked ? 'disabled' : ''} /> Needs review</label>
            </div>
            <div class="form-field">
              <label><input type="checkbox" id="f-disclaimer" ${post.disclaimer_required ? 'checked' : ''} ${locked ? 'disabled' : ''} /> Disclaimer required</label>
            </div>
            <div class="form-field">
              <label><input type="checkbox" id="f-evergreen" ${post.is_evergreen ? 'checked' : ''} ${locked ? 'disabled' : ''} /> Evergreen</label>
            </div>
            <div class="form-field">
              <label for="f-reuse-days">Reuse every (days)</label>
              <input id="f-reuse-days" type="number" min="1" value="${post.reuse_interval_days || ''}" ${locked ? 'disabled' : ''} />
            </div>
            <div class="form-field">
              <label for="f-media-instructions">Media instructions</label>
              <input id="f-media-instructions" value="${escapeHtml(post.media_instructions || '')}" ${locked ? 'disabled' : ''} />
            </div>
            <div class="form-field">
              <label for="f-notes">Notes</label>
              <textarea id="f-notes" rows="3">${escapeHtml(post.notes || '')}</textarea>
            </div>
          </div>
        </div>

        <div class="card">
          <strong>Media</strong>
          <div class="editor-media-list" id="editor-media-list">${mediaListMarkup()}</div>
          ${
            post.id && !locked
              ? '<input type="file" id="media-file-input" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4" />'
              : post.id
                ? ''
                : '<p class="empty-state">Save the post before attaching media.</p>'
          }
        </div>

        <div class="card">
          <strong>Copy for posting</strong>
          <div class="copy-buttons">${copyButtons() || '<span class="empty-state">Select at least one platform</span>'}</div>
          ${
            post.id && isOwner
              ? `<p><a class="btn secondary" href="/api/exports/posts/${post.id}/package.zip">Download posting package (zip)</a></p>`
              : ''
          }
        </div>

        ${
          locked
            ? `
          <div class="card">
            <strong>Published URLs</strong>
            ${post.platforms
              .map(
                (key) => `
              <div class="form-field">
                <label>${escapeHtml(key)}</label>
                <input class="published-url-edit" data-platform="${key}" value="${escapeHtml((post.published_urls && post.published_urls[key]) || '')}" placeholder="https://" />
              </div>
            `
              )
              .join('')}
            <button class="btn secondary" id="btn-update-urls">Update URLs</button>
          </div>
        `
            : ''
        }

        <div class="editor-actions">
          <button class="btn" id="btn-save">Save</button>
          ${actionButtons()}
        </div>

        <div id="publish-dialog" class="card" hidden>
          <strong>Mark Published</strong>
          ${post.platforms
            .map(
              (key) => `
            <div class="form-field">
              <label>${escapeHtml(key)} URL</label>
              <input class="publish-url" data-platform="${key}" placeholder="https://" />
            </div>
          `
            )
            .join('')}
          <button class="btn" id="btn-confirm-publish">Confirm</button>
        </div>
      </div>
    `;

    updateCharCounts();
    wireEvents();
  }

  function wireEvents() {
    const inputs = root.querySelectorAll('input:not([type=checkbox]):not([type=file]), textarea, select');
    inputs.forEach((el) => {
      el.addEventListener('input', () => {
        updateCharCounts();
        if (post.status !== 'published') scheduleAutosave();
      });
    });
    root.querySelectorAll('input[type=checkbox]:not(.platform-check)').forEach((el) => {
      el.addEventListener('change', () => scheduleAutosave());
    });
    root.querySelectorAll('.platform-check').forEach((el) => {
      el.addEventListener('change', () => {
        // Re-rendering rebuilds the platform section (and its caption-
        // override textareas) from `post`, so anything only in the DOM
        // (unsaved edits) must be folded back in first or it's lost.
        Object.assign(post, collectFields());
        renderAll();
        scheduleAutosave();
      });
    });

    document.getElementById('btn-save').addEventListener('click', () => save());

    root.querySelectorAll('[data-to]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const to = btn.dataset.to;
        if (to === 'ready' && post.needs_review && isOwner) {
          const approveEl = document.getElementById('f-approve');
          transition('ready', { approve: approveEl ? approveEl.checked : false });
        } else {
          transition(to);
        }
      });
    });

    const archiveBtn = document.getElementById('btn-archive');
    if (archiveBtn) archiveBtn.addEventListener('click', () => archiveOrRestore('archive'));
    const restoreBtn = document.getElementById('btn-restore');
    if (restoreBtn) restoreBtn.addEventListener('click', () => archiveOrRestore('restore'));
    const reuseBtn = document.getElementById('btn-reuse');
    if (reuseBtn) {
      reuseBtn.addEventListener('click', async () => {
        const result = await api(`/api/posts/${post.id}/reuse`, { method: 'POST' });
        toast('New draft created');
        window.location.hash = `#/editor/${result.post.id}`;
      });
    }
    const deleteBtn = document.getElementById('btn-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!window.confirm('Permanently delete this post? This cannot be undone.')) return;
        await api(`/api/posts/${post.id}`, { method: 'DELETE' });
        toast('Deleted');
        window.location.hash = '#/content';
      });
    }

    const markPublishedBtn = document.getElementById('btn-mark-published');
    if (markPublishedBtn) {
      markPublishedBtn.addEventListener('click', () => {
        document.getElementById('publish-dialog').hidden = false;
      });
    }
    const confirmPublishBtn = document.getElementById('btn-confirm-publish');
    if (confirmPublishBtn) {
      confirmPublishBtn.addEventListener('click', () => {
        const urls = {};
        root.querySelectorAll('.publish-url').forEach((el) => {
          if (el.value.trim()) urls[el.dataset.platform] = el.value.trim();
        });
        transition('published', { published_urls: urls });
      });
    }

    const updateUrlsBtn = document.getElementById('btn-update-urls');
    if (updateUrlsBtn) {
      updateUrlsBtn.addEventListener('click', async () => {
        const urls = {};
        root.querySelectorAll('.published-url-edit').forEach((el) => {
          if (el.value.trim()) urls[el.dataset.platform] = el.value.trim();
        });
        try {
          const result = await api(`/api/posts/${post.id}`, {
            method: 'PUT',
            body: { published_urls: urls, expected_updated_at: post.updated_at },
          });
          post = result.post;
          toast('Published URLs updated');
        } catch (err) {
          toast(err.message, { isError: true });
        }
      });
    }

    root.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.platform;
        const overrideEl = document.querySelector(`.caption-override[data-platform="${key}"]`);
        const text = buildPlatformCaption(
          { ...post, caption_main: fieldValue('f-caption'), caption_overrides: { [key]: overrideEl ? overrideEl.value : '' } },
          fieldValue('f-hashtags'),
          fieldValue('f-link'),
          key
        );

        const copied = await copyToClipboard(text);
        if (!copied) {
          toast(`Could not copy automatically. Select and copy the ${key} caption manually.`, { isError: true });
          return;
        }

        if (post.id) {
          api(`/api/posts/${post.id}/copy-log`, { method: 'POST', body: { platform: key } }).catch(() => {});
        }
        toast(`Copied ${key} caption`);
      });
    });

    const mediaFileInput = document.getElementById('media-file-input');
    if (mediaFileInput) {
      mediaFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        formData.append('post_id', post.id);
        try {
          await api('/api/media/upload', { method: 'POST', body: formData });
          mediaItems = (await api(`/api/posts/${post.id}/media`)).media;
          toast('Media attached');
          Object.assign(post, collectFields());
          renderAll();
        } catch (err) {
          toast(err.message, { isError: true });
        }
      });
    }

    root.querySelectorAll('.media-detach').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/api/posts/${post.id}/media/${btn.dataset.id}`, { method: 'DELETE' });
        mediaItems = (await api(`/api/posts/${post.id}/media`)).media;
        Object.assign(post, collectFields());
        renderAll();
      });
    });

    async function moveMedia(id, direction) {
      const ids = mediaItems.map((m) => m.id);
      const idx = ids.indexOf(id);
      const swapWith = idx + direction;
      if (swapWith < 0 || swapWith >= ids.length) return;
      [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
      await api(`/api/posts/${post.id}/media/reorder`, { method: 'PUT', body: { order: ids } });
      mediaItems = (await api(`/api/posts/${post.id}/media`)).media;
      Object.assign(post, collectFields());
      renderAll();
    }

    root.querySelectorAll('.media-move-up').forEach((btn) => {
      btn.addEventListener('click', () => moveMedia(btn.dataset.id, -1));
    });
    root.querySelectorAll('.media-move-down').forEach((btn) => {
      btn.addEventListener('click', () => moveMedia(btn.dataset.id, 1));
    });
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  document.addEventListener('keydown', function keyHandler(e) {
    if (!document.body.contains(root)) {
      document.removeEventListener('keydown', keyHandler);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });

  renderAll();
}
