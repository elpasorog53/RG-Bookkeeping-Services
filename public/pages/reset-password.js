import { api } from '../app.js';

export async function render(root, { token }) {
  if (!token) {
    root.innerHTML = `<div class="auth-page card"><p class="error-text">Missing reset token.</p></div>`;
    return;
  }

  root.innerHTML = `
    <div class="auth-page card">
      <h1>Set a new password</h1>
      <form id="reset-form">
        <div class="form-field">
          <label for="password">New password (at least 10 characters)</label>
          <input id="password" type="password" minlength="10" required autocomplete="new-password" />
        </div>
        <p class="error-text" id="reset-error" hidden></p>
        <p id="reset-success" hidden>Password set. <a href="/">Log in</a>.</p>
        <button class="btn" type="submit">Set password</button>
      </form>
    </div>
  `;

  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('reset-error');
    errorEl.hidden = true;
    try {
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword: document.getElementById('password').value },
      });
      document.getElementById('reset-form').hidden = true;
      document.getElementById('reset-success').hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}
