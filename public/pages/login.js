import { api } from '../app.js';

export async function render(root) {
  root.innerHTML = `
    <div class="auth-page card">
      <h1>Log in</h1>
      <form id="login-form">
        <div class="form-field">
          <label for="email">Email</label>
          <input id="email" type="email" required autocomplete="username" />
        </div>
        <div class="form-field">
          <label for="password">Password</label>
          <input id="password" type="password" required autocomplete="current-password" />
        </div>
        <p class="error-text" id="login-error" hidden></p>
        <button class="btn" type="submit">Log in</button>
      </form>
      <p><a href="#" id="forgot-toggle">Forgot password?</a></p>
      <form id="forgot-form" hidden>
        <div class="form-field">
          <label for="forgot-email">Email</label>
          <input id="forgot-email" type="email" required />
        </div>
        <p id="forgot-message"></p>
        <button class="btn secondary" type="submit">Send reset link</button>
      </form>
    </div>
  `;

  const loginForm = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: {
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

  document.getElementById('forgot-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('forgot-form').hidden = false;
  });

  document.getElementById('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const messageEl = document.getElementById('forgot-message');
    try {
      const result = await api('/api/auth/request-password-reset', {
        method: 'POST',
        body: { email: document.getElementById('forgot-email').value },
      });
      messageEl.textContent = result.message;
    } catch (err) {
      messageEl.textContent = err.message;
    }
  });
}
