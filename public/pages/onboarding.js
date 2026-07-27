import { api } from '../app.js';

export async function render(root) {
  root.innerHTML = `
    <div class="auth-page card">
      <h1>Set up RG Bookkeeping Social Planner</h1>
      <p>This one-time setup creates the owner account and your organization.</p>
      <form id="onboard-form">
        <div class="form-field">
          <label for="orgName">Business name</label>
          <input id="orgName" required value="RG Bookkeeping Services" />
        </div>
        <div class="form-field">
          <label for="timezone">Timezone</label>
          <select id="timezone">
            <option value="America/New_York" selected>Eastern (America/New_York)</option>
            <option value="America/Chicago">Central (America/Chicago)</option>
            <option value="America/Denver">Mountain (America/Denver)</option>
            <option value="America/Los_Angeles">Pacific (America/Los_Angeles)</option>
          </select>
        </div>
        <div class="form-field">
          <label for="displayName">Your name</label>
          <input id="displayName" required />
        </div>
        <div class="form-field">
          <label for="email">Email</label>
          <input id="email" type="email" required autocomplete="username" />
        </div>
        <div class="form-field">
          <label for="password">Password (at least 10 characters)</label>
          <input id="password" type="password" minlength="10" required autocomplete="new-password" />
        </div>
        <p class="error-text" id="onboard-error" hidden></p>
        <button class="btn" type="submit">Create account</button>
      </form>
    </div>
  `;

  document.getElementById('onboard-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('onboard-error');
    errorEl.hidden = true;
    try {
      await api('/api/auth/onboard', {
        method: 'POST',
        body: {
          orgName: document.getElementById('orgName').value,
          timezone: document.getElementById('timezone').value,
          displayName: document.getElementById('displayName').value,
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        },
      });
      window.location.hash = '#/dashboard';
      window.location.reload();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}
