import { api, escapeHtml, toast, formatDate } from '../app.js';

const STATUS_LABELS = {
  idea: 'Idea',
  draft: 'Draft',
  ready: 'Ready',
  scheduled: 'Scheduled',
  published: 'Published',
  skipped: 'Skipped',
};

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
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

    <div class="filters-bar">
      <select id="filter-status">
        <option value="">All statuses</option>
        ${Object.entries(STATUS_LABELS)
          .map(([key, label]) => `<option value="${key}">${label}</option>`)
          .join('')}
      </select>
      <select id="filter-pillar"><option value="">All pillars</option></select>
      <select id="filter-platform"><option value="">All platforms</option></select>
      <input id="filter-search" placeholder="Search title or caption" />
      <input id="filter-date-from" type="date" title="From" />
      <input id="filter-date-to" type="date" title="To" />
      <a href="#/editor/new" class="btn">+ New</a>
    </div>

    <div id="post-list" class="post-list"><p class="empty-state">Loading&hellip;</p></div>
  `;

  const [pillarsData, platformsData] = await Promise.all([
    api('/api/pillars'),
    api('/api/settings/platforms'),
  ]);
  const pillarsById = new Map(pillarsData.pillars.map((p) => [p.id, p]));

  const quickPillarSelect = document.getElementById('quick-pillar');
  quickPillarSelect.innerHTML =
    '<option value="">No pillar yet</option>' +
    pillarsData.pillars.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  const filterPillarSelect = document.getElementById('filter-pillar');
  filterPillarSelect.innerHTML +=
    pillarsData.pillars.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  const filterPlatformSelect = document.getElementById('filter-platform');
  filterPlatformSelect.innerHTML +=
    platformsData.platforms.map((p) => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join('');

  async function loadPosts() {
    const listEl = document.getElementById('post-list');
    const params = new URLSearchParams();
    const status = document.getElementById('filter-status').value;
    const pillarId = document.getElementById('filter-pillar').value;
    const platform = document.getElementById('filter-platform').value;
    const search = document.getElementById('filter-search').value;
    const dateFrom = document.getElementById('filter-date-from').value;
    const dateTo = document.getElementById('filter-date-to').value;
    if (status) params.set('status', status);
    if (pillarId) params.set('pillar_id', pillarId);
    if (platform) params.set('platform', platform);
    if (search) params.set('search', search);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);

    try {
      const { posts } = await api(`/api/posts?${params.toString()}`);
      if (posts.length === 0) {
        listEl.innerHTML = '<p class="empty-state">No posts match these filters.</p>';
        return;
      }
      listEl.innerHTML = posts
        .map((post) => {
          const pillar = post.pillar_id ? pillarsById.get(post.pillar_id) : null;
          const dot = pillar ? `<span class="pillar-dot" style="background:${escapeHtml(pillar.color || '#999')}"></span>` : '';
          const platforms = (post.platforms || []).join(', ');
          const dateLabel = post.planned_date ? formatDate(post.planned_date) : '';
          return `
            <a class="post-row" href="#/editor/${post.id}">
              ${dot}
              <span class="post-row-title">${escapeHtml(post.title)}</span>
              <span class="status-pill status-${post.status}">${STATUS_LABELS[post.status]}</span>
              ${platforms ? `<span class="post-row-platforms">${escapeHtml(platforms)}</span>` : ''}
              ${dateLabel ? `<span class="post-row-date">${dateLabel}</span>` : ''}
            </a>
          `;
        })
        .join('');
    } catch (err) {
      listEl.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  }

  const debouncedLoad = debounce(loadPosts, 300);
  ['filter-status', 'filter-pillar', 'filter-platform', 'filter-date-from', 'filter-date-to'].forEach((id) => {
    document.getElementById(id).addEventListener('change', loadPosts);
  });
  document.getElementById('filter-search').addEventListener('input', debouncedLoad);

  document.getElementById('quick-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const titleInput = document.getElementById('quick-title');
    const title = titleInput.value.trim();
    if (!title) return;
    try {
      await api('/api/posts', {
        method: 'POST',
        body: { title, pillar_id: quickPillarSelect.value || null },
      });
      titleInput.value = '';
      toast('Idea saved');
      await loadPosts();
    } catch (err) {
      toast(err.message, { isError: true });
    }
  });

  await loadPosts();
}
