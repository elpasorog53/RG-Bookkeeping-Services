import { api, escapeHtml, toast } from '../app.js';

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

function startOfWeek(d) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

export async function render(root) {
  const today = new Date();
  let refYear = today.getFullYear();
  let refMonth = today.getMonth();

  const [pillarsData, brandData] = await Promise.all([api('/api/pillars'), api('/api/settings/brand')]);
  const pillarsById = new Map(pillarsData.pillars.map((p) => [p.id, p]));
  const target = (brandData.brandSettings && brandData.brandSettings.posts_per_week_target) ?? 2;

  root.innerHTML = `
    <div class="calendar-toolbar">
      <button class="btn secondary" id="plan-prev">&larr;</button>
      <strong id="plan-label"></strong>
      <button class="btn secondary" id="plan-next">&rarr;</button>
    </div>
    <div class="card">
      <h2>Weekly cadence</h2>
      <p class="empty-state">
        Target: ${target} post${target === 1 ? '' : 's'}/week (set in Settings &rarr; Brand Voice). Counts include
        draft, ready, scheduled, and published posts planned for that week &mdash; not skipped or archived.
      </p>
      <div id="week-breakdown"></div>
    </div>
    <div class="card">
      <h2>Pillar mix this month</h2>
      <div id="pillar-mix"></div>
    </div>
    <div class="card">
      <h2>Unscheduled ideas</h2>
      <p class="empty-state">Ideas with no date yet &mdash; give one a date to slot it into the plan.</p>
      <div id="idea-backlog"></div>
    </div>
  `;

  function weeksInMonth() {
    const first = new Date(refYear, refMonth, 1);
    const last = new Date(refYear, refMonth, daysInMonth(refYear, refMonth));
    const weeks = [];
    let cursor = startOfWeek(first);
    while (cursor <= last) {
      const start = new Date(cursor);
      const end = new Date(cursor);
      end.setDate(end.getDate() + 6);
      weeks.push({ start, end });
      cursor.setDate(cursor.getDate() + 7);
    }
    return weeks;
  }

  async function loadAndRender() {
    document.getElementById('plan-label').textContent = `${MONTH_NAMES[refMonth]} ${refYear}`;

    const from = dateKey(refYear, refMonth, 1);
    const to = dateKey(refYear, refMonth, daysInMonth(refYear, refMonth));
    const [{ posts: monthPosts }, { posts: ideaPosts }] = await Promise.all([
      api(`/api/posts?date_from=${from}&date_to=${to}`),
      api('/api/posts?status=idea'),
    ]);

    const counted = monthPosts.filter((p) => p.status !== 'skipped');

    const weekRows = weeksInMonth().map((w, i) => {
      const startKey = dateKey(w.start.getFullYear(), w.start.getMonth(), w.start.getDate());
      const endKey = dateKey(w.end.getFullYear(), w.end.getMonth(), w.end.getDate());
      const count = counted.filter((p) => p.planned_date >= startKey && p.planned_date <= endKey).length;
      const short = count < target;
      return `
        <div class="post-row">
          <span class="post-row-title">Week ${i + 1} (${startKey} &ndash; ${endKey})</span>
          <span class="status-pill ${short ? 'status-scheduled' : 'status-published'}">${count} / ${target}</span>
        </div>
      `;
    });
    document.getElementById('week-breakdown').innerHTML = weekRows.join('');

    const pillarCounts = new Map();
    let noPillarCount = 0;
    counted.forEach((p) => {
      if (p.pillar_id) pillarCounts.set(p.pillar_id, (pillarCounts.get(p.pillar_id) || 0) + 1);
      else noPillarCount += 1;
    });
    const pillarRows = [...pillarCounts.entries()].map(([pillarId, count]) => {
      const pillar = pillarsById.get(pillarId);
      return `
        <div class="post-row">
          <span class="pillar-dot" style="background:${escapeHtml(pillar ? pillar.color || '#999' : '#999')}"></span>
          <span class="post-row-title">${escapeHtml(pillar ? pillar.name : 'Unknown pillar')}</span>
          <span class="status-pill">${count}</span>
        </div>
      `;
    });
    if (noPillarCount > 0) {
      pillarRows.push(`
        <div class="post-row">
          <span class="post-row-title">No pillar</span>
          <span class="status-pill">${noPillarCount}</span>
        </div>
      `);
    }
    document.getElementById('pillar-mix').innerHTML =
      pillarRows.length === 0 ? '<p class="empty-state">Nothing planned this month yet.</p>' : pillarRows.join('');

    const unassignedIdeas = ideaPosts.filter((p) => !p.planned_date);
    const ideaBacklog = document.getElementById('idea-backlog');
    if (unassignedIdeas.length === 0) {
      ideaBacklog.innerHTML = '<p class="empty-state">No unscheduled ideas.</p>';
    } else {
      ideaBacklog.innerHTML = unassignedIdeas
        .map(
          (p) => `
        <div class="post-row" data-id="${p.id}">
          <a href="#/editor/${p.id}" class="post-row-title">${escapeHtml(p.title)}</a>
          <input type="date" class="idea-date-input" data-id="${p.id}" />
          <button class="btn secondary idea-assign-btn" data-id="${p.id}">Plan it</button>
        </div>
      `
        )
        .join('');
      ideaBacklog.querySelectorAll('.idea-assign-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const dateInput = ideaBacklog.querySelector(`.idea-date-input[data-id="${btn.dataset.id}"]`);
          if (!dateInput.value) {
            toast('Pick a date first', { isError: true });
            return;
          }
          try {
            await api(`/api/posts/${btn.dataset.id}`, { method: 'PUT', body: { planned_date: dateInput.value } });
            toast('Added to the plan');
            await loadAndRender();
          } catch (err) {
            toast(err.message, { isError: true });
          }
        });
      });
    }
  }

  document.getElementById('plan-prev').addEventListener('click', () => {
    refMonth -= 1;
    if (refMonth < 0) {
      refMonth = 11;
      refYear -= 1;
    }
    loadAndRender();
  });
  document.getElementById('plan-next').addEventListener('click', () => {
    refMonth += 1;
    if (refMonth > 11) {
      refMonth = 0;
      refYear += 1;
    }
    loadAndRender();
  });

  await loadAndRender();
}
