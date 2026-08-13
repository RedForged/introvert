// Introvert E2EE Restore Backup Modal

import { config } from '../../core/config.js';
import { cryptoEngine } from '../../core/crypto.js';
import { showToast } from '../../core/state.js';

export function createRestoreBackupModal({ onSuccess, onClose } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'restore-backup-modal-root';

  let password = '';
  let isLoading = false;
  let error = '';

  const render = () => {
    const username = config.currentUser?.username || 'user';

    overlay.innerHTML = `
      <div class="modal-card" style="max-width:400px;">
        <div class="modal-header">
          <span class="modal-title">Restore E2EE Backup</span>
          <button class="icon-btn" id="close-restore-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body" style="padding:16px 20px 24px; gap:14px;">
          <p style="font-size:13px; color:var(--text-muted); line-height:1.5;">
            Enter your <strong>Extrovert account password</strong> for <strong>@${escapeHtml(username)}</strong> to restore your End-to-End Encryption key backup from the server and decrypt past messages.
          </p>

          ${
            error
              ? `<div style="padding:8px 12px; background:rgba(244,63,94,0.12); border:1px solid rgba(244,63,94,0.3); border-radius:var(--radius-sm); color:var(--rose); font-size:12.5px;">
                  ${escapeHtml(error)}
                </div>`
              : ''
          }

          <form id="restore-backup-form" style="display:flex; flex-direction:column; gap:12px;">
            <div class="form-group">
              <label class="form-label">Account Password</label>
              <input
                type="password"
                class="form-input"
                id="restore-password-input"
                placeholder="Enter password..."
                value="${escapeHtml(password)}"
                autofocus
                required
              />
            </div>

            <button type="submit" class="btn-pill primary" style="width:100%; height:38px; font-weight:600; margin-top:4px;" ${isLoading ? 'disabled' : ''}>
              ${isLoading ? 'Restoring Keys...' : 'Restore Encryption Keys'}
            </button>
          </form>
        </div>
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    overlay.querySelector('#close-restore-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onClose) onClose();
      }
    });

    const form = overlay.querySelector('#restore-backup-form');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = overlay.querySelector('#restore-password-input');
      password = input?.value || '';
      if (!password.trim() || isLoading) return;

      isLoading = true;
      error = '';
      render();

      try {
        await cryptoEngine.restoreFromBackup(password.trim());
        showToast('success', 'E2EE Keys Restored', 'Your encryption keys have been restored and verified.');
        overlay.remove();
        if (onSuccess) onSuccess();
      } catch (err) {
        isLoading = false;
        error = err.message || 'Incorrect password or backup corrupted.';
        render();
      }
    });
  };

  document.body.appendChild(overlay);
  render();

  return {
    destroy: () => overlay.remove(),
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
