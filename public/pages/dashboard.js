import { api, escapeHtml, toast, formatDate, formatTime } from '../app.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function toDateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfWeek(d) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

function endOfWeek(d) {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return end;
}

export async function render(root) {
  root.innerHTML = `
    <div class="card">
      <h2>Quick idea</h2>
      <form id="quick-add" class="quick-add">
        <input id="quick-title" placeholder="What's the idea?" required maxlength="300" />
        <select id="quick-pillar"></select>
        <button class="btn" type="submit">Save idea</button>
      </form>
    </div>

    <div class="dashboard-grid">
      <div class="card">
        <h2>This week</h2>
        <div id="week-counts"><p class="empty-state">Loading&hellip;</p></div>
      </div>
      <div class="card">
        <h2>Next up</h2>
        <div id="next-up"><p class="empty-state">Loading&hellip;</p></div>
      </div>
      <div class="card">
        <h2>Needs review</h2>
        <div id="needs-review"><p class="empty-state">Loading&hellip;</p></div>
      </div>
      <div class="card">
        <h2>Evergreen due for reuse</h2>
        <div id="evergreen-due"><p class="empty-state">Loading&hellip;</p></div>
      </div>
    </div>
  `;

  const { pillars } = await api('/api/pillars');
  const quickPillarSelect = document.getElementById('quick-pillar');
  quickPillarSelect.innerHTML =
    '<option value="">No pillar yet</option>' +
    pillars.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  document.getElementById('quick-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const titleInput = document.getElementById('quick-title');
    const title = titleInput.value.trim();
    if (!title) return;
    try {
      await api('/api/posts', { method: 'POST', body: { title, pillar_id: quickPillarSelect.value || null } });
      titleInput.value = '';
      toast('Idea saved');
    } catch (err) {
      toast(err.message, { isError: true });
    }
  });

  async function loadNextUp() {
    const el = document.getElementById('next-up');
    const { posts } = await api('/api/posts?status=scheduled');
    const next5 = posts.slice(0, 5);
    if (next5.length === 0) {
      el.innerHTML = '<p class="empty-state">Nothing scheduled yet.</p>';
      return;
    }
    el.innerHTML = next5
      .map(
        (p) => `
      <a href="#/editor/${p.id}" class="post-row">
        <span class="post-row-title">${escapeHtml(p.title)}</span>
        <span class="post-row-date">${formatDate(p.planned_date)} ${p.planned_time ? formatTime(p.planned_time) : ''}</span>
      </a>
    `
      )
      .join('');
  }

  async function loadNeedsReview() {
    const el = document.getElementById('needs-review');
    const { posts } = await api('/api/posts?status=draft');
    const flagged = posts.filter((p) => p.needs_review);
    if (flagged.length === 0) {
      el.innerHTML = '<p class="empty-state">Nothing flagged right now.</p>';
      return;
    }
    el.innerHTML = flagged
      .map(
        (p) => `
      <a href="#/editor/${p.id}" class="post-row">
        <span class="post-row-title">${escapeHtml(p.title)}</span>
        <span class="status-pill status-draft">Review</span>
      </a>
    `
      )
      .join('');
  }

  async function loadEvergreenDue() {
    const el = document.getElementById('evergreen-due');
    const { posts } = await api('/api/posts/evergreen/due');
    if (posts.length === 0) {
      el.innerHTML = '<p class="empty-state">Nothing due right now.</p>';
      return;
    }
    el.innerHTML = posts
      .map((p) => {
        const anchor = new Date(p.last_reused_at || p.published_at || p.created_at);
        const dueDate = new Date(anchor.getTime() + p.reuse_interval_days * 86400000);
        const overdueDays = Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / 86400000));
        return `
        <div class="post-row">
          <a href="#/editor/${p.id}" class="post-row-title">${escapeHtml(p.title)}</a>
          <span class="status-pill">${overdueDays === 0 ? 'Due today' : `Due ${overdueDays}d ago`}</span>
          <button class="btn secondary evergreen-reuse-btn" data-id="${p.id}">Reuse now</button>
        </div>
      `;
      })
      .join('');

    el.querySelectorAll('.evergreen-reuse-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const result = await api(`/api/posts/${btn.dataset.id}/reuse`, { method: 'POST' });
          toast('New draft created');
          window.location.hash = `#/editor/${result.post.id}`;
        } catch (err) {
          toast(err.message, { isError: true });
        }
      });
    });
  }

  async function loadWeekCounts() {
    const el = document.getElementById('week-counts');
    const today = new Date();
    const from = toDateKey(startOfWeek(today));
    const to = toDateKey(endOfWeek(today));
    const { posts } = await api(`/api/posts?date_from=${from}&date_to=${to}`);
    const counts = { scheduled: 0, draft: 0, ready: 0, published: 0, skipped: 0 };
    posts.forEach((p) => {
      if (counts[p.status] !== undefined) counts[p.status] += 1;
    });
    el.innerHTML = `
      <ul class="week-count-list">
        <li>${counts.scheduled} scheduled</li>
        <li>${counts.draft} draft</li>
        <li>${counts.ready} ready</li>
        <li>${counts.published} published</li>
        <li>${counts.skipped} skipped</li>
      </ul>
    `;
  }

  async function runRecurrenceGeneration() {
    try {
      const { generated } = await api('/api/recurrence-rules/run', { method: 'POST' });
      if (generated.length > 0) {
        toast(`${generated.length} recurring post${generated.length === 1 ? '' : 's'} generated from your schedule`);
      }
    } catch {
      // Non-critical background maintenance -- a failure here shouldn't
      // interrupt the rest of the dashboard.
    }
  }

  await Promise.all([loadWeekCounts(), loadNextUp(), loadNeedsReview(), loadEvergreenDue(), runRecurrenceGeneration()]);
}
