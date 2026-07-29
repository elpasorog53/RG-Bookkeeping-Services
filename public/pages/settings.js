import { api, escapeHtml, toast } from '../app.js';

const TABS = ['brand', 'pillars', 'platforms', 'ai', 'users', 'audit'];
const TAB_LABELS = {
  brand: 'Brand Voice',
  pillars: 'Pillars',
  platforms: 'Platforms',
  ai: 'AI',
  users: 'Users',
  audit: 'Audit',
};
const OWNER_ONLY_TABS = new Set(['ai', 'users', 'audit']);

export async function render(root, { session }) {
  const isOwner = session.role === 'OWNER';
  let activeTab = 'brand';

  function shell() {
    root.innerHTML = `
      <div class="settings-tabs">
        ${TABS.filter((t) => isOwner || !OWNER_ONLY_TABS.has(t))
          .map((t) => `<button class="btn secondary settings-tab" data-tab="${t}">${TAB_LABELS[t]}</button>`)
          .join('')}
      </div>
      <div id="settings-panel" class="card"></div>
    `;
    root.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        renderPanel();
      });
    });
  }

  async function renderBrandTab() {
    const { brandSettings } = await api('/api/settings/brand');
    const b = brandSettings || {};
    const panel = document.getElementById('settings-panel');
    panel.innerHTML = `
      <h2>Brand Voice</h2>
      <div class="form-field"><label>Business name</label><input id="s-business-name" value="${escapeHtml(b.business_name || '')}" ${isOwner ? '' : 'disabled'} /></div>
      <div class="form-field"><label>Business description</label><textarea id="s-business-description" rows="3" ${isOwner ? '' : 'disabled'}>${escapeHtml(b.business_description || '')}</textarea></div>
      <div class="form-field"><label>Services</label><textarea id="s-services" rows="2" ${isOwner ? '' : 'disabled'}>${escapeHtml(b.services || '')}</textarea></div>
      <div class="form-field"><label>Target audience</label><input id="s-target-audience" value="${escapeHtml(b.target_audience || '')}" ${isOwner ? '' : 'disabled'} /></div>
      <div class="form-field"><label>Geographic area</label><input id="s-geographic-area" value="${escapeHtml(b.geographic_area || '')}" ${isOwner ? '' : 'disabled'} /></div>
      <div class="form-field"><label>Tone</label><input id="s-tone" value="${escapeHtml(b.tone || '')}" ${isOwner ? '' : 'disabled'} /></div>
      <div class="form-field"><label>Website URL</label><input id="s-website-url" value="${escapeHtml(b.website_url || '')}" ${isOwner ? '' : 'disabled'} /></div>
      <div class="form-field"><label>Contact info</label><input id="s-contact-info" value="${escapeHtml(b.contact_info || '')}" ${isOwner ? '' : 'disabled'} /></div>
      <div class="form-field"><label>Disclaimer text</label><textarea id="s-disclaimer-text" rows="2" ${isOwner ? '' : 'disabled'}>${escapeHtml(b.disclaimer_text || '')}</textarea></div>
      ${isOwner ? '<button class="btn" id="btn-save-brand">Save</button>' : '<p class="empty-state">Only the Owner can edit brand settings.</p>'}
    `;
    if (isOwner) {
      document.getElementById('btn-save-brand').addEventListener('click', async () => {
        try {
          await api('/api/settings/brand', {
            method: 'PUT',
            body: {
              business_name: document.getElementById('s-business-name').value,
              business_description: document.getElementById('s-business-description').value,
              services: document.getElementById('s-services').value,
              target_audience: document.getElementById('s-target-audience').value,
              geographic_area: document.getElementById('s-geographic-area').value,
              tone: document.getElementById('s-tone').value,
              website_url: document.getElementById('s-website-url').value,
              contact_info: document.getElementById('s-contact-info').value,
              disclaimer_text: document.getElementById('s-disclaimer-text').value,
            },
          });
          toast('Saved');
        } catch (err) {
          toast(err.message, { isError: true });
        }
      });
    }
  }

  async function renderPillarsTab() {
    const { pillars } = await api('/api/pillars?includeArchived=true');
    const panel = document.getElementById('settings-panel');
    panel.innerHTML = `
      <h2>Pillars</h2>
      ${
        isOwner
          ? `
        <form id="new-pillar-form" class="quick-add">
          <input id="new-pillar-name" placeholder="New pillar name" required />
          <button class="btn" type="submit">Add</button>
        </form>
      `
          : ''
      }
      <div class="post-list" id="pillar-list">
        ${pillars
          .map(
            (p) => `
          <div class="post-row" data-id="${p.id}">
            <span class="pillar-dot" style="background:${escapeHtml(p.color || '#999')}"></span>
            <span class="post-row-title">${escapeHtml(p.name)}${p.archived_at ? ' (archived)' : ''}</span>
            ${
              isOwner
                ? p.archived_at
                  ? `<button class="btn secondary pillar-restore" data-id="${p.id}">Restore</button>`
                  : `<button class="btn secondary pillar-archive" data-id="${p.id}">Archive</button>`
                : ''
            }
          </div>
        `
          )
          .join('')}
      </div>
    `;

    if (isOwner) {
      document.getElementById('new-pillar-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('new-pillar-name');
        try {
          await api('/api/pillars', { method: 'POST', body: { name: input.value } });
          toast('Pillar added');
          renderPillarsTab();
        } catch (err) {
          toast(err.message, { isError: true });
        }
      });
      panel.querySelectorAll('.pillar-archive').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await api(`/api/pillars/${btn.dataset.id}/archive`, { method: 'POST' });
          renderPillarsTab();
        });
      });
      panel.querySelectorAll('.pillar-restore').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await api(`/api/pillars/${btn.dataset.id}/restore`, { method: 'POST' });
          renderPillarsTab();
        });
      });
    }
  }

  async function renderPlatformsTab() {
    const { platforms } = await api('/api/settings/platforms');
    const panel = document.getElementById('settings-panel');
    panel.innerHTML = `
      <h2>Platforms</h2>
      <p class="empty-state">Character limits are starting points &mdash; verify against current platform documentation.</p>
      ${platforms
        .map(
          (p) => `
        <div class="card">
          <strong>${escapeHtml(p.label)}</strong>
          <div class="editor-row">
            <div class="form-field"><label>Soft limit</label><input class="platform-soft" data-key="${p.key}" type="number" value="${p.char_soft_limit ?? ''}" ${isOwner ? '' : 'disabled'} /></div>
            <div class="form-field"><label>Hard limit</label><input class="platform-hard" data-key="${p.key}" type="number" value="${p.char_hard_limit ?? ''}" ${isOwner ? '' : 'disabled'} /></div>
            <div class="form-field"><label>Media max</label><input class="platform-media" data-key="${p.key}" type="number" value="${p.media_max_count ?? ''}" ${isOwner ? '' : 'disabled'} /></div>
          </div>
          ${isOwner ? `<button class="btn secondary platform-save" data-key="${p.key}">Save</button>` : ''}
        </div>
      `
        )
        .join('')}
    `;
    if (isOwner) {
      panel.querySelectorAll('.platform-save').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.key;
          const soft = panel.querySelector(`.platform-soft[data-key="${key}"]`).value;
          const hard = panel.querySelector(`.platform-hard[data-key="${key}"]`).value;
          const media = panel.querySelector(`.platform-media[data-key="${key}"]`).value;
          try {
            await api(`/api/settings/platforms/${key}`, {
              method: 'PUT',
              body: {
                char_soft_limit: Number(soft),
                char_hard_limit: Number(hard),
                media_max_count: Number(media),
              },
            });
            toast('Saved');
          } catch (err) {
            toast(err.message, { isError: true });
          }
        });
      });
    }
  }

  async function renderUsersTab() {
    const { users } = await api('/api/settings/users');
    const panel = document.getElementById('settings-panel');
    panel.innerHTML = `
      <h2>Users</h2>
      <form id="invite-form" class="editor-row">
        <div class="form-field"><label>Name</label><input id="invite-name" required /></div>
        <div class="form-field"><label>Email</label><input id="invite-email" type="email" required /></div>
        <div class="form-field">
          <label>Role</label>
          <select id="invite-role"><option value="EDITOR">Editor</option><option value="OWNER">Owner</option></select>
        </div>
        <button class="btn" type="submit" style="align-self:flex-end">Invite</button>
      </form>
      <div class="post-list">
        ${users
          .map(
            (u) => `
          <div class="post-row">
            <span class="post-row-title">${escapeHtml(u.display_name)} &mdash; ${escapeHtml(u.email)}</span>
            <span class="status-pill">${u.role}</span>
            ${!u.is_active ? '<span class="status-pill status-skipped">Deactivated</span>' : ''}
            ${
              u.is_active && u.id !== session.user.id
                ? `<button class="btn secondary user-deactivate" data-id="${u.id}">Deactivate</button>`
                : ''
            }
          </div>
        `
          )
          .join('')}
      </div>
    `;
    document.getElementById('invite-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/settings/users/invite', {
          method: 'POST',
          body: {
            displayName: document.getElementById('invite-name').value,
            email: document.getElementById('invite-email').value,
            role: document.getElementById('invite-role').value,
          },
        });
        toast('Invitation sent');
        renderUsersTab();
      } catch (err) {
        toast(err.message, { isError: true });
      }
    });
    panel.querySelectorAll('.user-deactivate').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('Deactivate this user?')) return;
        await api(`/api/settings/users/${btn.dataset.id}/deactivate`, { method: 'POST' });
        renderUsersTab();
      });
    });
  }

  async function renderAuditTab() {
    const { entries } = await api('/api/audit');
    const panel = document.getElementById('settings-panel');
    panel.innerHTML = `
      <h2>Audit Log</h2>
      <p><a class="btn secondary" href="/api/exports/posts.csv">Export all posts (CSV)</a></p>
      <div class="post-list">
        ${
          entries.length === 0
            ? '<p class="empty-state">Nothing recorded yet.</p>'
            : entries
                .map(
                  (e) => `
          <div class="post-row">
            <span class="post-row-title">${escapeHtml(e.action)} &mdash; ${escapeHtml(e.record_type)}</span>
            <span class="empty-state">${escapeHtml(e.actor_name || 'system')}</span>
            <span class="empty-state">${new Date(e.created_at).toLocaleString()}</span>
          </div>
        `
                )
                .join('')
        }
      </div>
    `;
  }

  async function renderAiTab() {
    const { configured } = await api('/api/settings/ai-config');
    const panel = document.getElementById('settings-panel');
    panel.innerHTML = `
      <h2>AI Assist</h2>
      <p class="empty-state">
        Drafting help uses your own Anthropic API key, billed directly to you.
        Nothing AI-related is available anywhere in the app until a key is set here.
      </p>
      <p><strong>Status:</strong> ${configured ? 'Key configured' : 'Not configured'}</p>
      <div class="form-field">
        <label for="ai-key-input">Anthropic API key</label>
        <div class="subscribe-row">
          <input
            id="ai-key-input"
            type="text"
            inputmode="text"
            placeholder="sk-ant-..."
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            style="-webkit-text-security: disc; text-security: disc;"
          />
          <button class="btn secondary" id="btn-toggle-ai-key" type="button">Show</button>
        </div>
      </div>
      <div class="editor-actions">
        <button class="btn" id="btn-save-ai-key">Save key</button>
        <button class="btn secondary" id="btn-test-ai-key" ${configured ? '' : 'disabled'}>Test connection</button>
        ${configured ? '<button class="btn danger" id="btn-remove-ai-key">Remove key</button>' : ''}
      </div>
      <p id="ai-test-result"></p>
    `;

    document.getElementById('btn-toggle-ai-key').addEventListener('click', (e) => {
      const input = document.getElementById('ai-key-input');
      const showing = input.style.webkitTextSecurity === 'none';
      input.style.webkitTextSecurity = showing ? 'disc' : 'none';
      input.style.textSecurity = showing ? 'disc' : 'none';
      e.target.textContent = showing ? 'Show' : 'Hide';
    });

    document.getElementById('btn-save-ai-key').addEventListener('click', async () => {
      const input = document.getElementById('ai-key-input');
      if (!input.value.trim()) {
        toast('Enter a key first', { isError: true });
        return;
      }
      try {
        await api('/api/settings/ai-config', { method: 'PUT', body: { apiKey: input.value.trim() } });
        toast('Key saved');
        renderAiTab();
      } catch (err) {
        toast(err.message, { isError: true });
      }
    });

    const testBtn = document.getElementById('btn-test-ai-key');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const resultEl = document.getElementById('ai-test-result');
        resultEl.textContent = 'Testing…';
        try {
          const result = await api('/api/settings/ai-config/test', { method: 'POST' });
          resultEl.textContent = result.ok ? 'Success — the key works.' : `Failed: ${result.error}`;
          resultEl.className = result.ok ? '' : 'error-text';
        } catch (err) {
          resultEl.textContent = `Failed: ${err.message}`;
          resultEl.className = 'error-text';
        }
      });
    }

    const removeBtn = document.getElementById('btn-remove-ai-key');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!window.confirm('Remove the stored API key? AI features will be hidden again until a new key is added.')) return;
        await api('/api/settings/ai-config', { method: 'DELETE' });
        toast('Key removed');
        renderAiTab();
      });
    }
  }

  async function renderPanel() {
    root.querySelectorAll('.settings-tab').forEach((btn) => {
      btn.classList.toggle('active-tab', btn.dataset.tab === activeTab);
    });
    const renderers = {
      brand: renderBrandTab,
      pillars: renderPillarsTab,
      platforms: renderPlatformsTab,
      ai: renderAiTab,
      users: renderUsersTab,
      audit: renderAuditTab,
    };
    await renderers[activeTab]();
  }

  shell();
  await renderPanel();
}
