// Introvert Safety Numbers Verification Modal Component

import { api } from '../../core/api.js';
import { cryptoEngine } from '../../core/crypto.js';

export function createSafetyModal({ username, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  let safetyData = null;
  let isLoading = true;

  const loadKeys = async () => {
    try {
      safetyData = await api.getSafetyKeys(username);
    } catch (e) {
      console.warn('Safety keys fetch error', e);
    } finally {
      isLoading = false;
      render();
    }
  };

  const render = () => {
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:440px;">
        <div class="modal-header">
          <span class="modal-title">Verify Safety Numbers</span>
          <button class="icon-btn" id="close-safety-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <p style="font-size:13px; color:var(--text-muted); line-height:1.45;">
            Compare this safety fingerprint with @${escapeHtml(username)} in person or via a trusted second channel to verify end-to-end encryption integrity.
          </p>

          ${
            isLoading
              ? `<div style="text-align:center; padding:20px; color:var(--text-faint);">Fetching cryptographic keys...</div>`
              : `
            <div class="form-group">
              <label class="form-label">Their Identity Fingerprint</label>
              <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:10px; font-family:var(--font-mono); font-size:11.5px; word-break:break-all;">
                ${safetyData?.their_ed25519 || 'Key not published'}
              </div>
            </div>

            <div class="form-group" style="margin-top:10px;">
              <label class="form-label">Your Identity Fingerprint</label>
              <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:10px; font-family:var(--font-mono); font-size:11.5px; word-break:break-all;">
                ${cryptoEngine.myIdKeys?.ed25519 || 'Your key'}
              </div>
            </div>
          `
          }
        </div>

        <div class="modal-footer">
          <button class="btn-pill primary" id="dismiss-safety-btn">Verified & Done</button>
        </div>
      </div>
    `;

    overlay.querySelector('#close-safety-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.querySelector('#dismiss-safety-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onClose) onClose();
      }
    });
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  render();
  loadKeys();
  document.body.appendChild(overlay);
  return overlay;
}
