import { api, escapeHtml, toast, formatTime } from '../app.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateKey(year, monthIndex, day) {
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export async function render(root) {
  const today = new Date();
  let refYear = today.getFullYear();
  let refMonth = today.getMonth();
  let view = window.innerWidth < 700 ? 'list' : 'month';

  const [pillarsData] = await Promise.all([api('/api/pillars')]);
  const pillarsById = new Map(pillarsData.pillars.map((p) => [p.id, p]));

  root.innerHTML = `
    <details class="card subscribe-card">
      <summary>Subscribe to this calendar (Apple/Google Calendar)</summary>
      <p class="empty-state">
        Add scheduled posts as events on your phone/computer calendar automatically.
        Subscribe once and it stays in sync as you add or reschedule posts.
      </p>
      <div class="subscribe-row">
        <input id="feed-url" readonly value="Loading&hellip;" />
        <button class="btn secondary" id="copy-feed-url">Copy link</button>
      </div>
      <p class="empty-state">
        <strong>Apple Calendar:</strong> File &rarr; New Calendar Subscription &rarr; paste the link.<br />
        <strong>Google Calendar:</strong> Other calendars (+) &rarr; From URL &rarr; paste the link.
      </p>
    </details>
    <div class="calendar-toolbar">
      <button class="btn secondary" id="cal-prev">&larr;</button>
      <strong id="cal-label"></strong>
      <button class="btn secondary" id="cal-next">&rarr;</button>
      <div class="calendar-view-toggle">
        <button class="btn secondary" id="cal-view-month">Month</button>
        <button class="btn secondary" id="cal-view-list">List</button>
      </div>
    </div>
    <div class="calendar-body">
      <div id="cal-grid"></div>
      <div class="unscheduled-tray">
        <strong>Unscheduled</strong>
        <div id="unscheduled-list"></div>
      </div>
    </div>
  `;

  function chipHtml(post) {
    const pillar = post.pillar_id ? pillarsById.get(post.pillar_id) : null;
    const dot = pillar ? `<span class="pillar-dot" style="background:${escapeHtml(pillar.color || '#999')}"></span>` : '';
    const ghosted = post.status === 'draft' ? ' chip-ghosted' : '';
    const struck = post.status === 'skipped' ? ' chip-struck' : '';
    const check = post.status === 'published' ? ' &#10003;' : '';
    const time = post.planned_time ? formatTime(post.planned_time) : '';
    return `
      <a href="#/editor/${post.id}" class="calendar-chip${ghosted}${struck}" draggable="true" data-id="${post.id}">
        ${dot}<span class="chip-title">${escapeHtml(post.title)}</span>${check}
        ${time ? `<span class="chip-time">${time}</span>` : ''}
      </a>
    `;
  }

  function wireChipDrag() {
    root.querySelectorAll('.calendar-chip[draggable="true"]').forEach((chip) => {
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', chip.dataset.id);
      });
    });
  }

  function wireDropTargets() {
    root.querySelectorAll('.calendar-day, .unscheduled-tray').forEach((target) => {
      target.addEventListener('dragover', (e) => {
        e.preventDefault();
        target.classList.add('drop-target-active');
      });
      target.addEventListener('dragleave', () => target.classList.remove('drop-target-active'));
      target.addEventListener('drop', async (e) => {
        e.preventDefault();
        target.classList.remove('drop-target-active');
        const postId = e.dataTransfer.getData('text/plain');
        const newDate = target.dataset.date || null;
        try {
          await api(`/api/posts/${postId}`, {
            method: 'PUT',
            body: { planned_date: newDate, planned_time: newDate ? '09:00' : null },
          });
          await loadAndRenderBody();
        } catch (err) {
          toast(err.message, { isError: true });
        }
      });
    });
  }

  async function loadPosts() {
    const params = new URLSearchParams();
    if (view === 'month') {
      const from = dateKey(refYear, refMonth, 1);
      const to = dateKey(refYear, refMonth, daysInMonth(refYear, refMonth));
      params.set('date_from', from);
      params.set('date_to', to);
    }
    const { posts } = await api(`/api/posts?${params.toString()}`);
    return posts;
  }

  function renderMonthGrid(posts) {
    document.getElementById('cal-label').textContent = `${MONTH_NAMES[refMonth]} ${refYear}`;
    const byDate = new Map();
    posts.forEach((p) => {
      if (!p.planned_date) return;
      if (!byDate.has(p.planned_date)) byDate.set(p.planned_date, []);
      byDate.get(p.planned_date).push(p);
    });

    const firstDow = new Date(refYear, refMonth, 1).getDay();
    const totalDays = daysInMonth(refYear, refMonth);
    const cells = [];
    for (let i = 0; i < firstDow; i += 1) cells.push(null);
    for (let d = 1; d <= totalDays; d += 1) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    const dowHeader = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .map((d) => `<div class="calendar-dow">${d}</div>`)
      .join('');

    const cellsHtml = cells
      .map((day) => {
        if (!day) return '<div class="calendar-day calendar-day-empty"></div>';
        const key = dateKey(refYear, refMonth, day);
        const dayPosts = byDate.get(key) || [];
        const visible = dayPosts.slice(0, 3);
        const overflow = dayPosts.length - visible.length;
        return `
          <div class="calendar-day" data-date="${key}">
            <div class="calendar-day-number">${day}</div>
            ${visible.map(chipHtml).join('')}
            ${overflow > 0 ? `<button class="calendar-overflow" data-date="${key}">+${overflow} more</button>` : ''}
          </div>
        `;
      })
      .join('');

    document.getElementById('cal-grid').innerHTML = `
      <div class="calendar-grid">
        ${dowHeader}
        ${cellsHtml}
      </div>
    `;

    root.querySelectorAll('.calendar-overflow').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.date;
        const dayPosts = byDate.get(key) || [];
        toast(`${key}: ${dayPosts.map((p) => p.title).join(', ')}`);
      });
    });
  }

  function renderListView(posts) {
    document.getElementById('cal-label').textContent = 'Upcoming';
    const dated = posts.filter((p) => p.planned_date).sort((a, b) => (a.planned_date < b.planned_date ? -1 : 1));
    document.getElementById('cal-grid').innerHTML = `
      <div class="calendar-list">
        ${
          dated.length === 0
            ? '<p class="empty-state">Nothing scheduled.</p>'
            : dated
                .map(
                  (p) => `
          <div class="calendar-list-row">
            <span class="calendar-list-date">${p.planned_date}${p.planned_time ? ' ' + formatTime(p.planned_time) : ''}</span>
            ${chipHtml(p)}
          </div>
        `
                )
                .join('')
        }
      </div>
    `;
  }

  async function loadAndRenderBody() {
    const posts = await loadPosts();
    if (view === 'month') renderMonthGrid(posts);
    else renderListView(posts);

    const unscheduled = (await api('/api/posts?status=ready')).posts.filter((p) => !p.planned_date);
    document.getElementById('unscheduled-list').innerHTML =
      unscheduled.length === 0
        ? '<p class="empty-state">Nothing waiting.</p>'
        : unscheduled.map(chipHtml).join('');
    document.querySelector('.unscheduled-tray').dataset.date = '';

    wireChipDrag();
    wireDropTargets();
  }

  document.getElementById('cal-prev').addEventListener('click', () => {
    refMonth -= 1;
    if (refMonth < 0) {
      refMonth = 11;
      refYear -= 1;
    }
    loadAndRenderBody();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    refMonth += 1;
    if (refMonth > 11) {
      refMonth = 0;
      refYear += 1;
    }
    loadAndRenderBody();
  });
  document.getElementById('cal-view-month').addEventListener('click', () => {
    view = 'month';
    loadAndRenderBody();
  });
  document.getElementById('cal-view-list').addEventListener('click', () => {
    view = 'list';
    loadAndRenderBody();
  });

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

  api('/api/settings/calendar-feed-url')
    .then(({ feedUrl }) => {
      document.getElementById('feed-url').value = feedUrl;
    })
    .catch(() => {
      document.getElementById('feed-url').value = 'Could not load link';
    });

  document.getElementById('copy-feed-url').addEventListener('click', async () => {
    const input = document.getElementById('feed-url');
    const copied = await copyToClipboard(input.value);
    toast(copied ? 'Link copied' : 'Could not copy automatically — select and copy manually', {
      isError: !copied,
    });
  });

  await loadAndRenderBody();
}
