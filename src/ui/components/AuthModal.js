// Introvert Authentication & E2EE Unlock Modal Component (OAuth 2.0 PKCE)

import { authStore, bootstrapAuthenticatedData, showToast } from '../../core/state.js';
import { config, OFFICIAL_SERVER_URL } from '../../core/config.js';
import { api } from '../../core/api.js';
import { cryptoEngine } from '../../core/crypto.js';
import { signaling } from '../../core/signaling.js';

export function createAuthModal({ onSuccess }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'auth-modal-root';

  let mode = 'oauth'; // 'oauth' | 'oauth-code' | 'token' | 'unlock'
  let serverUrl = config.serverUrl || OFFICIAL_SERVER_URL;
  let authCodeInput = '';
  let directTokenInput = '';
  let password = '';
  let authorizeUrl = '';
  let isLoading = false;
  let errorMessage = '';

  let broadcastChannel = null;

  try {
    broadcastChannel = new BroadcastChannel('introvert_oauth');
    broadcastChannel.onmessage = (event) => {
      if (event.data && event.data.code && mode === 'oauth-code') {
        authCodeInput = event.data.code;
        completeOAuthFlow(authCodeInput);
      }
    };
  } catch (e) {}

  const onStorageChange = (e) => {
    if (e.key === 'introvert_oauth_received_code' && e.newValue && mode === 'oauth-code') {
      authCodeInput = e.newValue;
      localStorage.removeItem('introvert_oauth_received_code');
      completeOAuthFlow(authCodeInput);
    }
  };
  window.addEventListener('storage', onStorageChange);

  const openExternalUrl = async (url) => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch (e) {
      try {
        window.open(url, '_blank');
      } catch (e2) {
        console.warn('Fallback browser open failed', e2);
      }
    }
  };

  const startOAuthFlow = async () => {
    if (!serverUrl) {
      errorMessage = 'Please enter your Extrovert server URL.';
      render();
      return;
    }

    isLoading = true;
    errorMessage = '';
    render();

    try {
      const { authorizeUrl: authUrl } = await api.initOAuth(serverUrl);
      authorizeUrl = authUrl;
      mode = 'oauth-code';
      isLoading = false;
      render();

      await openExternalUrl(authUrl);
    } catch (err) {
      errorMessage = err.message || 'Failed to initialize OAuth connection to server.';
      isLoading = false;
      render();
    }
  };

  const completeOAuthFlow = async (codeToUse = null) => {
    const code = (codeToUse || authCodeInput).trim();
    if (!code) {
      errorMessage = 'Please paste the authorization code or redirect URL.';
      render();
      return;
    }

    isLoading = true;
    errorMessage = '';
    render();

    try {
      const { user } = await api.completeOAuth(code);
      mode = 'unlock';
      isLoading = false;
      errorMessage = '';
      showToast('success', `Authorized as @${user.username}!`);
      render();
    } catch (err) {
      errorMessage = err.message || 'OAuth token exchange failed.';
      isLoading = false;
      render();
    }
  };

  const loginWithDirectToken = async () => {
    if (!directTokenInput.trim()) {
      errorMessage = 'Please enter a valid bearer access token.';
      render();
      return;
    }

    isLoading = true;
    errorMessage = '';
    render();

    try {
      const { user } = await api.loginWithToken(directTokenInput.trim(), serverUrl);
      mode = 'unlock';
      isLoading = false;
      errorMessage = '';
      showToast('success', `Signed in as @${user.username}!`);
      render();
    } catch (err) {
      errorMessage = err.message || 'Token verification failed.';
      isLoading = false;
      render();
    }
  };

  const handleUnlock = async () => {
    if (!password) {
      errorMessage = 'Please enter your password / passphrase to unlock encryption.';
      render();
      return;
    }

    isLoading = true;
    errorMessage = '';
    render();

    try {
      const activeUser = config.currentUser;
      if (activeUser) {
        await cryptoEngine.unlockWithPassword(password, activeUser.username);
      }
      authStore.set({ isE2eeReady: true, isAuthenticated: true, user: activeUser });
      signaling.connect();
      await bootstrapAuthenticatedData();

      showToast('success', 'Encryption unlocked & connected!');
      cleanup();
      overlay.remove();
      if (onSuccess) onSuccess(activeUser);
    } catch (err) {
      console.warn('Unlock error', err);
      errorMessage = 'Failed to decrypt local key pickle with this password.';
    } finally {
      isLoading = false;
      render();
    }
  };

  const cleanup = () => {
    window.removeEventListener('storage', onStorageChange);
    if (broadcastChannel) {
      broadcastChannel.close();
      broadcastChannel = null;
    }
  };

  const render = () => {
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:420px;">
        <div class="modal-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="nav-logo" style="width:28px; height:28px; font-size:13px; margin:0;">I</div>
            <span class="modal-title">
              ${
                mode === 'unlock'
                  ? 'Unlock End-to-End Encryption'
                  : mode === 'oauth-code'
                  ? 'Authorize Introvert'
                  : mode === 'token'
                  ? 'Sign In with Token'
                  : 'Connect to Extrovert'
              }
            </span>
          </div>
        </div>

        <div class="modal-body">
          ${
            errorMessage
              ? `<div style="background:rgba(244,63,94,0.15); border:1px solid var(--rose); color:var(--rose); padding:10px 12px; border-radius:var(--radius-sm); font-size:12.5px; word-break:break-word;">
                  ${escapeHtml(errorMessage)}
                </div>`
              : ''
          }

          ${
            mode === 'oauth'
              ? `
            <p style="font-size:13px; color:var(--text-muted); line-height:1.45;">
              Sign in securely via OAuth 2.0 PKCE. Your password remains private on your Extrovert server.
            </p>

            <div class="form-group">
              <label class="form-label">Extrovert Instance</label>
              <input type="text" class="form-input" id="auth-server" value="${escapeHtml(serverUrl)}" placeholder="https://extrovert.redforged.eu" />
            </div>

            <div style="margin-top:14px;">
              <button class="btn-pill primary" id="start-oauth-btn" ${isLoading ? 'disabled' : ''} style="width:100%; justify-content:center; height:42px; font-size:14px; font-weight:600;">
                ${isLoading ? 'Connecting to Server...' : 'Sign in with Extrovert (OAuth)'}
              </button>
            </div>
          `
              : mode === 'oauth-code'
              ? `
            <div style="font-size:13px; color:var(--text-main); line-height:1.5;">
              <p style="margin-bottom:8px;">
                <strong>Step 1:</strong> An authorization window has been opened in your browser.
              </p>
              <p style="margin-bottom:12px; font-size:12.5px; color:var(--text-muted);">
                If the window didn't open, <a href="#" id="manual-auth-link" style="color:var(--accent); text-decoration:underline; cursor:pointer;">click here to open it</a>.
              </p>
              <p style="margin-bottom:8px;">
                <strong>Step 2:</strong> Click <strong>Authorize</strong> in your browser, then copy & paste the authorization code below:
              </p>
            </div>

            <div class="form-group">
              <input type="text" class="form-input" id="oauth-code-input" placeholder="Paste authorization code or redirect link..." value="${escapeHtml(authCodeInput)}" autofocus />
            </div>

            <div style="margin-top:12px;">
              <button class="btn-pill primary" id="complete-oauth-btn" ${isLoading ? 'disabled' : ''} style="width:100%; justify-content:center; height:40px; font-size:13.5px; font-weight:600;">
                ${isLoading ? 'Exchanging Token...' : 'Complete Sign In'}
              </button>
            </div>
          `
              : mode === 'token'
              ? `
            <div class="form-group">
              <label class="form-label">Instance Server URL</label>
              <input type="text" class="form-input" id="auth-server" value="${escapeHtml(serverUrl)}" />
            </div>
            <div class="form-group" style="margin-top:10px;">
              <label class="form-label">Bearer Access Token</label>
              <input type="password" class="form-input" id="direct-token-input" placeholder="Paste bearer token" />
            </div>
            <div style="margin-top:12px;">
              <button class="btn-pill primary" id="login-token-btn" ${isLoading ? 'disabled' : ''} style="width:100%; justify-content:center; height:40px;">
                ${isLoading ? 'Verifying...' : 'Sign In with Token'}
              </button>
            </div>
          `
              : `
            <p style="font-size:13px; color:var(--text-muted); line-height:1.45;">
              Signed in as <strong>@${escapeHtml(config.currentUser?.username || '')}</strong>.<br>
              Enter your password to unlock your Double-Ratchet Olm encryption keys and decrypt your messages.
            </p>

            <div class="form-group">
              <label class="form-label">Account Password</label>
              <input type="password" class="form-input" id="auth-password" placeholder="Enter password to unlock E2EE" autofocus />
            </div>

            <div style="margin-top:12px;">
              <button class="btn-pill primary" id="unlock-e2ee-btn" ${isLoading ? 'disabled' : ''} style="width:100%; justify-content:center; height:40px; font-weight:600;">
                ${isLoading ? 'Unlocking Keys...' : 'Unlock Encryption & Enter'}
              </button>
            </div>
          `
          }
        </div>

        <div class="modal-footer" style="justify-content:space-between;">
          ${
            mode === 'oauth'
              ? `<button class="btn-pill" id="switch-to-token-btn" style="border:none; padding:0; background:transparent; color:var(--text-muted); font-size:12px;">
                  Use Direct Access Token
                </button>`
              : mode === 'token' || mode === 'oauth-code'
              ? `<button class="btn-pill" id="switch-to-oauth-btn" style="border:none; padding:0; background:transparent; color:var(--text-muted); font-size:12px;">
                  Back to OAuth Sign In
                </button>`
              : '<div></div>'
          }
        </div>
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    overlay.querySelector('#auth-server')?.addEventListener('input', (e) => (serverUrl = e.target.value));

    overlay.querySelector('#start-oauth-btn')?.addEventListener('click', startOAuthFlow);

    overlay.querySelector('#manual-auth-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      if (authorizeUrl) openExternalUrl(authorizeUrl);
    });

    const codeInput = overlay.querySelector('#oauth-code-input');
    if (codeInput) {
      codeInput.addEventListener('input', (e) => (authCodeInput = e.target.value));
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') completeOAuthFlow();
      });
      codeInput.addEventListener('paste', () => {
        setTimeout(() => {
          authCodeInput = codeInput.value;
          if (authCodeInput.trim()) completeOAuthFlow();
        }, 100);
      });
    }

    overlay.querySelector('#complete-oauth-btn')?.addEventListener('click', () => completeOAuthFlow());

    const tokenInput = overlay.querySelector('#direct-token-input');
    if (tokenInput) {
      tokenInput.addEventListener('input', (e) => (directTokenInput = e.target.value));
      tokenInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loginWithDirectToken();
      });
    }

    overlay.querySelector('#login-token-btn')?.addEventListener('click', loginWithDirectToken);

    const pwInput = overlay.querySelector('#auth-password');
    if (pwInput) {
      pwInput.addEventListener('input', (e) => (password = e.target.value));
      pwInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleUnlock();
      });
    }

    overlay.querySelector('#unlock-e2ee-btn')?.addEventListener('click', handleUnlock);

    overlay.querySelector('#switch-to-token-btn')?.addEventListener('click', () => {
      mode = 'token';
      errorMessage = '';
      render();
    });

    overlay.querySelector('#switch-to-oauth-btn')?.addEventListener('click', () => {
      mode = 'oauth';
      errorMessage = '';
      render();
    });
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
      render();
    },
    destroy: cleanup,
  };
}
