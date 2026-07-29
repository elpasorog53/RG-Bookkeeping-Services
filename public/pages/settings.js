import { api, escapeHtml, toast } from '../app.js';

const TABS = ['brand', 'pillars', 'templates', 'recurrence', 'platforms', 'ai', 'users', 'audit'];
const TAB_LABELS = {
  brand: 'Brand Voice',
  pillars: 'Pillars',
  templates: 'Templates',
  recurrence: 'Recurrence',
  platforms: 'Platforms',
  ai: 'AI',
  users: 'Users',
  audit: 'Audit',
};
const OWNER_ONLY_TABS = new Set(['ai', 'users', 'audit']);

const DAY_OF_WEEK_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  if (rem10 === 1) return `${n}st`;
  if (rem10 === 2) return `${n}nd`;
  if (rem10 === 3) return `${n}rd`;
  return `${n}th`;
}

function describeRuleFrequency(r) {
  if (r.frequency === 'weekly') return `Weekly on ${DAY_OF_WEEK_LABELS[r.day_of_week]}`;
  if (r.frequency === 'monthly') return `Monthly on the ${ordinal(r.day_of_month)}`;
  if (r.frequency === 'quarterly') return `Quarterly on the ${ordinal(r.day_of_month)}`;
  if (r.frequency === 'yearly') return `Yearly on ${MONTH_LABELS[r.month_of_year - 1]} ${ordinal(r.day_of_month)}`;
  return r.frequency;
}

export async function render(root, { session }) {
  const isOwner = session.role === 'OWNER';
  let activeTab = 'brand';
  let editingTemplateId = null;
  let editingRuleId = null;

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

  async function renderTemplatesTab() {
    const [{ templates }, { pillars }, { platforms }] = await Promise.all([
      api('/api/templates?includeArchived=true'),
      api('/api/pillars'),
      api('/api/settings/platforms'),
    ]);
    const pillarsById = new Map(pillars.map((p) => [p.id, p]));
    const panel = document.getElementById('settings-panel');

    function pillarOptions(selectedId) {
      return `<option value="">No pillar</option>${pillars
        .map((p) => `<option value="${p.id}" ${selectedId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
        .join('')}`;
    }

    function platformCheckboxes(prefix, selected) {
      return platforms
        .map(
          (p) => `
        <label class="platform-toggle">
          <input type="checkbox" class="${prefix}-platform-check" value="${p.key}" ${selected.includes(p.key) ? 'checked' : ''} />
          ${escapeHtml(p.label)}
        </label>
      `
        )
        .join(' ');
    }

    function templateRow(t) {
      if (editingTemplateId === t.id) {
        return `
          <div class="card" data-id="${t.id}">
            <div class="form-field"><label>Name</label><input id="edit-template-name" value="${escapeHtml(t.name)}" /></div>
            <div class="form-field"><label>Pillar</label><select id="edit-template-pillar">${pillarOptions(t.pillar_id)}</select></div>
            <div class="form-field">
              <label>Platforms</label>
              <div class="platform-toggles">${platformCheckboxes('edit-template', t.platforms || [])}</div>
            </div>
            <div class="form-field"><label>Body</label><textarea id="edit-template-body" rows="4">${escapeHtml(t.body)}</textarea></div>
            <div class="editor-actions">
              <button class="btn" id="btn-save-template-edit">Save</button>
              <button class="btn secondary" id="btn-cancel-template-edit">Cancel</button>
            </div>
          </div>
        `;
      }

      const pillar = t.pillar_id ? pillarsById.get(t.pillar_id) : null;
      const platformLabels = (t.platforms || [])
        .map((key) => platforms.find((p) => p.key === key)?.label || key)
        .join(', ');

      return `
        <div class="post-row" data-id="${t.id}">
          <span class="post-row-title">${escapeHtml(t.name)}${t.archived_at ? ' (archived)' : ''}</span>
          ${pillar ? `<span class="status-pill">${escapeHtml(pillar.name)}</span>` : ''}
          ${platformLabels ? `<span class="empty-state">${escapeHtml(platformLabels)}</span>` : ''}
          ${
            isOwner
              ? `
            <button class="btn secondary template-edit" data-id="${t.id}">Edit</button>
            ${
              t.archived_at
                ? `<button class="btn secondary template-restore" data-id="${t.id}">Restore</button>`
                : `<button class="btn secondary template-archive" data-id="${t.id}">Archive</button>`
            }
          `
              : ''
          }
        </div>
      `;
    }

    panel.innerHTML = `
      <h2>Templates</h2>
      <p class="empty-state">Reusable starting points for new posts &mdash; pick one from the New Post screen.</p>
      ${
        isOwner
          ? `
        <div class="card">
          <strong>New template</strong>
          <div class="form-field"><label>Name</label><input id="new-template-name" placeholder="e.g. Weekly bookkeeping tip" /></div>
          <div class="form-field"><label>Pillar</label><select id="new-template-pillar">${pillarOptions(null)}</select></div>
          <div class="form-field">
            <label>Platforms</label>
            <div class="platform-toggles">${platformCheckboxes('new-template', [])}</div>
          </div>
          <div class="form-field"><label>Body</label><textarea id="new-template-body" rows="4" placeholder="The starting caption text"></textarea></div>
          <button class="btn" id="btn-add-template">Add template</button>
        </div>
      `
          : ''
      }
      <div class="post-list" id="template-list">
        ${templates.length === 0 ? '<p class="empty-state">No templates yet.</p>' : templates.map(templateRow).join('')}
      </div>
    `;

    if (isOwner) {
      document.getElementById('btn-add-template').addEventListener('click', async () => {
        const name = document.getElementById('new-template-name').value.trim();
        if (!name) {
          toast('Enter a name first', { isError: true });
          return;
        }
        const body = document.getElementById('new-template-body').value.trim();
        if (!body) {
          toast('Enter body text first', { isError: true });
          return;
        }
        const platformKeys = Array.from(panel.querySelectorAll('.new-template-platform-check:checked')).map(
          (el) => el.value
        );
        try {
          await api('/api/templates', {
            method: 'POST',
            body: {
              name,
              pillar_id: document.getElementById('new-template-pillar').value || null,
              platforms: platformKeys,
              body,
            },
          });
          toast('Template added');
          renderTemplatesTab();
        } catch (err) {
          toast(err.message, { isError: true });
        }
      });

      panel.querySelectorAll('.template-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
          editingTemplateId = btn.dataset.id;
          renderTemplatesTab();
        });
      });
      panel.querySelectorAll('.template-archive').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await api(`/api/templates/${btn.dataset.id}/archive`, { method: 'POST' });
          renderTemplatesTab();
        });
      });
      panel.querySelectorAll('.template-restore').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await api(`/api/templates/${btn.dataset.id}/restore`, { method: 'POST' });
          renderTemplatesTab();
        });
      });

      const saveEditBtn = document.getElementById('btn-save-template-edit');
      if (saveEditBtn) {
        saveEditBtn.addEventListener('click', async () => {
          const platformKeys = Array.from(panel.querySelectorAll('.edit-template-platform-check:checked')).map(
            (el) => el.value
          );
          try {
            await api(`/api/templates/${editingTemplateId}`, {
              method: 'PUT',
              body: {
                name: document.getElementById('edit-template-name').value.trim(),
                pillar_id: document.getElementById('edit-template-pillar').value || null,
                platforms: platformKeys,
                body: document.getElementById('edit-template-body').value.trim(),
              },
            });
            toast('Template saved');
            editingTemplateId = null;
            renderTemplatesTab();
          } catch (err) {
            toast(err.message, { isError: true });
          }
        });
      }
      const cancelEditBtn = document.getElementById('btn-cancel-template-edit');
      if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', () => {
          editingTemplateId = null;
          renderTemplatesTab();
        });
      }
    }
  }

  function frequencyFieldsMarkup(prefix, frequency, values) {
    if (frequency === 'weekly') {
      return `
        <div class="form-field">
          <label for="${prefix}-day-of-week">Day of week</label>
          <select id="${prefix}-day-of-week">
            ${DAY_OF_WEEK_LABELS.map(
              (label, i) => `<option value="${i}" ${values.day_of_week === i ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </div>
      `;
    }
    if (frequency === 'monthly' || frequency === 'quarterly') {
      return `
        <div class="form-field">
          <label for="${prefix}-day-of-month">Day of month</label>
          <input id="${prefix}-day-of-month" type="number" min="1" max="31" value="${values.day_of_month ?? ''}" />
        </div>
      `;
    }
    if (frequency === 'yearly') {
      return `
        <div class="editor-row">
          <div class="form-field">
            <label for="${prefix}-month-of-year">Month</label>
            <select id="${prefix}-month-of-year">
              ${MONTH_LABELS.map(
                (label, i) =>
                  `<option value="${i + 1}" ${values.month_of_year === i + 1 ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </div>
          <div class="form-field">
            <label for="${prefix}-day-of-month">Day</label>
            <input id="${prefix}-day-of-month" type="number" min="1" max="31" value="${values.day_of_month ?? ''}" />
          </div>
        </div>
      `;
    }
    return '';
  }

  async function renderRecurrenceTab() {
    const [{ rules }, { templates }] = await Promise.all([api('/api/recurrence-rules'), api('/api/templates')]);
    const panel = document.getElementById('settings-panel');

    function templateOptions(selectedId) {
      if (templates.length === 0) return '<option value="">No templates yet</option>';
      return templates
        .map((t) => `<option value="${t.id}" ${selectedId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
        .join('');
    }

    function readFrequencyFields(prefix, frequency) {
      const fields = { frequency };
      if (frequency === 'weekly') {
        fields.day_of_week = Number(document.getElementById(`${prefix}-day-of-week`).value);
      } else if (frequency === 'monthly' || frequency === 'quarterly') {
        fields.day_of_month = Number(document.getElementById(`${prefix}-day-of-month`).value);
      } else if (frequency === 'yearly') {
        fields.month_of_year = Number(document.getElementById(`${prefix}-month-of-year`).value);
        fields.day_of_month = Number(document.getElementById(`${prefix}-day-of-month`).value);
      }
      return fields;
    }

    function wireFrequencySelect(prefix, values) {
      const select = document.getElementById(`${prefix}-frequency`);
      const container = document.getElementById(`${prefix}-frequency-fields`);
      select.addEventListener('change', () => {
        container.innerHTML = frequencyFieldsMarkup(prefix, select.value, values);
      });
    }

    function ruleRow(r) {
      if (editingRuleId === r.id) {
        return `
          <div class="card" data-id="${r.id}">
            <div class="form-field"><label>Template</label><select id="edit-rule-template">${templateOptions(r.template_id)}</select></div>
            <div class="form-field">
              <label>Frequency</label>
              <select id="edit-rule-frequency">
                ${['weekly', 'monthly', 'quarterly', 'yearly']
                  .map(
                    (f) =>
                      `<option value="${f}" ${r.frequency === f ? 'selected' : ''}>${f[0].toUpperCase()}${f.slice(1)}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div id="edit-rule-frequency-fields">${frequencyFieldsMarkup('edit-rule', r.frequency, r)}</div>
            <div class="editor-row">
              <div class="form-field"><label>Lead time (days)</label><input id="edit-rule-lead-time" type="number" min="0" value="${r.lead_time_days}" /></div>
              <div class="form-field"><label>Start on</label><input id="edit-rule-start-on" type="date" value="${r.start_on}" /></div>
              <div class="form-field"><label>End on (optional)</label><input id="edit-rule-end-on" type="date" value="${r.end_on || ''}" /></div>
            </div>
            <div class="form-field"><label><input type="checkbox" id="edit-rule-requires-review" ${r.requires_review ? 'checked' : ''} /> Needs review before publishing</label></div>
            <div class="form-field"><label><input type="checkbox" id="edit-rule-requires-date-verification" ${r.requires_date_verification ? 'checked' : ''} /> References a date/deadline that must be verified each time (e.g. tax deadlines)</label></div>
            <div class="editor-actions">
              <button class="btn" id="btn-save-rule-edit">Save</button>
              <button class="btn secondary" id="btn-cancel-rule-edit">Cancel</button>
            </div>
          </div>
        `;
      }

      return `
        <div class="post-row" data-id="${r.id}">
          <span class="post-row-title">${escapeHtml(r.template_name)}${r.is_paused ? ' (paused)' : ''}</span>
          <span class="status-pill">${describeRuleFrequency(r)}</span>
          <span class="empty-state">${r.lead_time_days}d lead</span>
          ${
            isOwner
              ? `
            <button class="btn secondary rule-edit" data-id="${r.id}">Edit</button>
            <button class="btn secondary rule-toggle-pause" data-id="${r.id}" data-paused="${r.is_paused}">${r.is_paused ? 'Resume' : 'Pause'}</button>
            <button class="btn danger rule-delete" data-id="${r.id}">Delete</button>
          `
              : ''
          }
        </div>
      `;
    }

    panel.innerHTML = `
      <h2>Recurrence</h2>
      <p class="empty-state">Automatically generate draft posts from a template on a schedule &mdash; new drafts appear whenever the app is opened after one comes due.</p>
      ${
        isOwner
          ? `
        <div class="card">
          <strong>New recurrence rule</strong>
          ${
            templates.length === 0
              ? '<p class="empty-state">Create a template first (Templates tab) before adding a recurrence rule.</p>'
              : `
            <div class="form-field"><label>Template</label><select id="new-rule-template">${templateOptions(null)}</select></div>
            <div class="form-field">
              <label>Frequency</label>
              <select id="new-rule-frequency">
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
            <div id="new-rule-frequency-fields">${frequencyFieldsMarkup('new-rule', 'weekly', { day_of_week: 1 })}</div>
            <div class="editor-row">
              <div class="form-field"><label>Lead time (days)</label><input id="new-rule-lead-time" type="number" min="0" value="7" /></div>
              <div class="form-field"><label>Start on</label><input id="new-rule-start-on" type="date" /></div>
              <div class="form-field"><label>End on (optional)</label><input id="new-rule-end-on" type="date" /></div>
            </div>
            <div class="form-field"><label><input type="checkbox" id="new-rule-requires-review" checked /> Needs review before publishing</label></div>
            <div class="form-field"><label><input type="checkbox" id="new-rule-requires-date-verification" /> References a date/deadline that must be verified each time (e.g. tax deadlines)</label></div>
            <button class="btn" id="btn-add-rule">Add rule</button>
          `
          }
        </div>
      `
          : ''
      }
      <div class="post-list" id="rule-list">
        ${rules.length === 0 ? '<p class="empty-state">No recurrence rules yet.</p>' : rules.map(ruleRow).join('')}
      </div>
    `;

    if (isOwner && templates.length > 0 && document.getElementById('new-rule-frequency')) {
      wireFrequencySelect('new-rule', { day_of_week: 1 });
    }
    if (editingRuleId) {
      const editingRule = rules.find((r) => r.id === editingRuleId);
      if (editingRule) wireFrequencySelect('edit-rule', editingRule);
    }

    if (isOwner) {
      const addBtn = document.getElementById('btn-add-rule');
      if (addBtn) {
        addBtn.addEventListener('click', async () => {
          const frequency = document.getElementById('new-rule-frequency').value;
          const startOn = document.getElementById('new-rule-start-on').value;
          if (!startOn) {
            toast('Pick a start date first', { isError: true });
            return;
          }
          const endOn = document.getElementById('new-rule-end-on').value;
          try {
            await api('/api/recurrence-rules', {
              method: 'POST',
              body: {
                template_id: document.getElementById('new-rule-template').value,
                frequency,
                ...readFrequencyFields('new-rule', frequency),
                lead_time_days: Number(document.getElementById('new-rule-lead-time').value),
                start_on: startOn,
                end_on: endOn || null,
                requires_review: document.getElementById('new-rule-requires-review').checked,
                requires_date_verification: document.getElementById('new-rule-requires-date-verification').checked,
              },
            });
            toast('Recurrence rule added');
            renderRecurrenceTab();
          } catch (err) {
            toast(err.message, { isError: true });
          }
        });
      }

      panel.querySelectorAll('.rule-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
          editingRuleId = btn.dataset.id;
          renderRecurrenceTab();
        });
      });
      panel.querySelectorAll('.rule-toggle-pause').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const isPaused = btn.dataset.paused === 'true';
          await api(`/api/recurrence-rules/${btn.dataset.id}`, { method: 'PUT', body: { is_paused: !isPaused } });
          renderRecurrenceTab();
        });
      });
      panel.querySelectorAll('.rule-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!window.confirm('Delete this recurrence rule? This does not delete any posts it already generated.')) return;
          await api(`/api/recurrence-rules/${btn.dataset.id}`, { method: 'DELETE' });
          toast('Recurrence rule deleted');
          renderRecurrenceTab();
        });
      });

      const saveEditBtn = document.getElementById('btn-save-rule-edit');
      if (saveEditBtn) {
        saveEditBtn.addEventListener('click', async () => {
          const frequency = document.getElementById('edit-rule-frequency').value;
          const startOn = document.getElementById('edit-rule-start-on').value;
          const endOn = document.getElementById('edit-rule-end-on').value;
          try {
            await api(`/api/recurrence-rules/${editingRuleId}`, {
              method: 'PUT',
              body: {
                template_id: document.getElementById('edit-rule-template').value,
                frequency,
                ...readFrequencyFields('edit-rule', frequency),
                lead_time_days: Number(document.getElementById('edit-rule-lead-time').value),
                start_on: startOn,
                end_on: endOn || null,
                requires_review: document.getElementById('edit-rule-requires-review').checked,
                requires_date_verification: document.getElementById('edit-rule-requires-date-verification').checked,
              },
            });
            toast('Recurrence rule saved');
            editingRuleId = null;
            renderRecurrenceTab();
          } catch (err) {
            toast(err.message, { isError: true });
          }
        });
      }
      const cancelEditBtn = document.getElementById('btn-cancel-rule-edit');
      if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', () => {
          editingRuleId = null;
          renderRecurrenceTab();
        });
      }
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
      templates: renderTemplatesTab,
      recurrence: renderRecurrenceTab,
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
