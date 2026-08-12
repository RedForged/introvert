// Introvert Authentication & E2EE Unlock Modal Component

import { authStore, bootstrapAuthenticatedData, showToast } from '../../core/state.js';
import { config } from '../../core/config.js';
import { api } from '../../core/api.js';
import { cryptoEngine } from '../../core/crypto.js';
import { signaling } from '../../core/signaling.js';

export function createAuthModal({ onSuccess }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'auth-modal-root';

  let mode = 'login'; // 'login' | 'register' | 'unlock'
  let serverUrl = config.serverUrl;
  let username = '';
  let password = '';
  let displayName = '';
  let refCode = '';
  let captchaAnswer = '';
  let captchaSvg = '';
  let isLoading = false;
  let errorMessage = '';

  const loadCaptcha = async () => {
    try {
      captchaSvg = await api.getCaptchaSvg();
      render();
    } catch (e) {
      console.warn('Captcha load failed', e);
    }
  };

  const handleLogin = async () => {
    if (!username || !password) {
      errorMessage = 'Please enter your username and password.';
      render();
      return;
    }

    isLoading = true;
    errorMessage = '';
    render();

    try {
      await config.setServerUrl(serverUrl);
      const { user } = await api.login(username, password);

      // Attempt E2EE unlock
      try {
        await cryptoEngine.unlockWithPassword(password, username);
      } catch (e) {
        console.warn('Initial E2EE unlock with login password', e);
      }

      signaling.connect();
      await bootstrapAuthenticatedData();

      showToast('success', `Welcome back, ${user.display_name || user.username}!`);
      overlay.remove();
      if (onSuccess) onSuccess(user);
    } catch (err) {
      errorMessage = err.message || 'Login failed.';
    } finally {
      isLoading = false;
      render();
    }
  };

  const handleRegister = async () => {
    if (!username || !password) {
      errorMessage = 'Username and password are required.';
      render();
      return;
    }

    isLoading = true;
    errorMessage = '';
    render();

    try {
      await config.setServerUrl(serverUrl);
      const { user } = await api.register({
        username,
        password,
        displayName: displayName || username,
        ref: refCode,
        captcha: captchaAnswer,
      });

      // Init and publish Olm Account
      try {
        await cryptoEngine.unlockWithPassword(password, username);
      } catch (e) {}

      signaling.connect();
      await bootstrapAuthenticatedData();

      showToast('success', `Account created! Welcome, ${user.display_name || user.username}`);
      overlay.remove();
      if (onSuccess) onSuccess(user);
    } catch (err) {
      errorMessage = err.message || 'Registration failed.';
      loadCaptcha();
    } finally {
      isLoading = false;
      render();
    }
  };

  const handleUnlock = async () => {
    if (!password) {
      errorMessage = 'Please enter your password to unlock encryption.';
      render();
      return;
    }

    isLoading = true;
    errorMessage = '';
    render();

    try {
      const activeUser = config.currentUser;
      await cryptoEngine.unlockWithPassword(password, activeUser.username);
      authStore.set({ isE2eeReady: true });
      showToast('success', 'Encryption keys unlocked!');
      overlay.remove();
      if (onSuccess) onSuccess(activeUser);
    } catch (err) {
      errorMessage = 'Incorrect password or failed to unpickle keys.';
    } finally {
      isLoading = false;
      render();
    }
  };

  const render = () => {
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:400px;">
        <div class="modal-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="nav-logo" style="width:28px; height:28px; font-size:13px; margin:0;">I</div>
            <span class="modal-title">${mode === 'login' ? 'Sign In to Introvert' : mode === 'register' ? 'Create Account' : 'Unlock E2EE'}</span>
          </div>
        </div>

        <div class="modal-body">
          ${
            errorMessage
              ? `<div style="background:rgba(244,63,94,0.15); border:1px solid var(--rose); color:var(--rose); padding:10px 12px; border-radius:var(--radius-sm); font-size:12.5px;">
                  ${escapeHtml(errorMessage)}
                </div>`
              : ''
          }

          ${
            mode === 'unlock'
              ? `
            <p style="font-size:13px; color:var(--text-muted); line-height:1.45;">
              Enter your account password to decrypt your Olm Double-Ratchet keys and access your encrypted chats.
            </p>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input type="password" class="form-input" id="auth-password" placeholder="Enter password" />
            </div>
          `
              : `
            <div class="form-group">
              <label class="form-label">Server Instance URL</label>
              <input type="text" class="form-input" id="auth-server" value="${escapeHtml(serverUrl)}" placeholder="http://localhost:3000" />
            </div>

            <div class="form-group">
              <label class="form-label">Username</label>
              <input type="text" class="form-input" id="auth-username" value="${escapeHtml(username)}" placeholder="e.g. alice" autocomplete="username" />
            </div>

            ${
              mode === 'register'
                ? `
              <div class="form-group">
                <label class="form-label">Display Name</label>
                <input type="text" class="form-input" id="auth-display-name" value="${escapeHtml(displayName)}" placeholder="e.g. Alice" />
              </div>
            `
                : ''
            }

            <div class="form-group">
              <label class="form-label">Password</label>
              <input type="password" class="form-input" id="auth-password" placeholder="Password (min 12 characters)" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" />
            </div>

            ${
              mode === 'register'
                ? `
              <div class="form-group">
                <label class="form-label">Referral Code (Optional)</label>
                <input type="text" class="form-input" id="auth-ref" value="${escapeHtml(refCode)}" placeholder="Referral code if you have one" />
              </div>

              <div class="form-group">
                <label class="form-label">Anti-Bot Verification</label>
                <div style="display:flex; align-items:center; gap:8px;">
                  <div id="captcha-svg-container" style="background:#fff; border-radius:var(--radius-sm); padding:4px; max-height:48px; overflow:hidden; flex-shrink:0;">
                    ${captchaSvg || '<span style="color:#000; font-size:11px;">Loading...</span>'}
                  </div>
                  <button class="icon-btn" id="reload-captcha-btn" title="Reload Challenge">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="23 4 23 10 17 10"></polyline>
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                    </svg>
                  </button>
                </div>
                <input type="text" class="form-input" id="auth-captcha" placeholder="Type the text shown above" style="margin-top:6px;" />
              </div>
            `
                : ''
            }
          `
          }
        </div>

        <div class="modal-footer" style="justify-content:space-between;">
          ${
            mode !== 'unlock'
              ? `
            <button class="btn-pill" id="switch-mode-btn" style="border:none; padding:0; background:transparent; color:var(--text-muted);">
              ${mode === 'login' ? "Don't have an account? Register" : 'Already registered? Sign In'}
            </button>
          `
              : '<div></div>'
          }

          <button class="btn-pill primary" id="auth-submit-btn" ${isLoading ? 'disabled' : ''} style="height:36px; padding:0 20px;">
            ${isLoading ? 'Connecting...' : mode === 'login' ? 'Sign In' : mode === 'register' ? 'Register' : 'Unlock'}
          </button>
        </div>
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    const serverInput = overlay.querySelector('#auth-server');
    if (serverInput) {
      serverInput.addEventListener('input', (e) => (serverUrl = e.target.value));
    }

    const usernameInput = overlay.querySelector('#auth-username');
    if (usernameInput) {
      usernameInput.addEventListener('input', (e) => (username = e.target.value.trim()));
    }

    const displayNameInput = overlay.querySelector('#auth-display-name');
    if (displayNameInput) {
      displayNameInput.addEventListener('input', (e) => (displayName = e.target.value));
    }

    const passwordInput = overlay.querySelector('#auth-password');
    if (passwordInput) {
      passwordInput.addEventListener('input', (e) => (password = e.target.value));
      passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (mode === 'login') handleLogin();
          else if (mode === 'register') handleRegister();
          else if (mode === 'unlock') handleUnlock();
        }
      });
    }

    const refInput = overlay.querySelector('#auth-ref');
    if (refInput) {
      refInput.addEventListener('input', (e) => (refCode = e.target.value));
    }

    const captchaInput = overlay.querySelector('#auth-captcha');
    if (captchaInput) {
      captchaInput.addEventListener('input', (e) => (captchaAnswer = e.target.value));
    }

    const reloadCaptchaBtn = overlay.querySelector('#reload-captcha-btn');
    if (reloadCaptchaBtn) {
      reloadCaptchaBtn.addEventListener('click', loadCaptcha);
    }

    const switchBtn = overlay.querySelector('#switch-mode-btn');
    if (switchBtn) {
      switchBtn.addEventListener('click', () => {
        mode = mode === 'login' ? 'register' : 'login';
        errorMessage = '';
        if (mode === 'register') loadCaptcha();
        render();
      });
    }

    const submitBtn = overlay.querySelector('#auth-submit-btn');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        if (mode === 'login') handleLogin();
        else if (mode === 'register') handleRegister();
        else if (mode === 'unlock') handleUnlock();
      });
    }
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  render();
  document.body.appendChild(overlay);
  return {
    element: overlay,
    setMode: (m) => {
      mode = m;
      if (m === 'register') loadCaptcha();
      render();
    },
  };
}
