// Introvert Create Channel Modal Component

import { api } from '../../core/api.js';
import { showToast } from '../../core/state.js';

export function createCreateChannelModal({ roomId, onClose, onCreated }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  let name = '';
  let type = 'text'; // 'text' | 'voice'
  let isSubmitting = false;

  const render = () => {
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:380px;">
        <div class="modal-header">
          <span class="modal-title">Create Channel</span>
          <button class="icon-btn" id="close-create-ch-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Channel Type</label>
            <div style="display:flex; gap:8px;">
              <button class="btn-pill ${type === 'text' ? 'primary' : ''}" id="type-text-btn" style="flex:1; justify-content:center;">
                # Text Chat
              </button>
              <button class="btn-pill ${type === 'voice' ? 'primary' : ''}" id="type-voice-btn" style="flex:1; justify-content:center;">
                🔊 Voice Channel
              </button>
            </div>
          </div>

          <div class="form-group" style="margin-top:8px;">
            <label class="form-label">Channel Name</label>
            <input type="text" class="form-input" id="new-ch-name" value="${escapeHtml(name)}" placeholder="e.g. general or lounge" maxlength="50" />
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-pill" id="cancel-create-ch-btn">Cancel</button>
          <button class="btn-pill primary" id="submit-create-ch-btn" ${isSubmitting ? 'disabled' : ''}>
            ${isSubmitting ? 'Creating...' : 'Create Channel'}
          </button>
        </div>
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    overlay.querySelector('#close-create-ch-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.querySelector('#cancel-create-ch-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onClose) onClose();
      }
    });

    overlay.querySelector('#type-text-btn')?.addEventListener('click', () => {
      type = 'text';
      render();
    });

    overlay.querySelector('#type-voice-btn')?.addEventListener('click', () => {
      type = 'voice';
      render();
    });

    overlay.querySelector('#new-ch-name')?.addEventListener('input', (e) => (name = e.target.value));

    overlay.querySelector('#submit-create-ch-btn')?.addEventListener('click', async () => {
      if (!name.trim()) {
        showToast('danger', 'Please enter a channel name');
        return;
      }
      isSubmitting = true;
      render();

      try {
        await api.createChannel(roomId, { name: name.trim().toLowerCase().replace(/\s+/g, '-'), type });
        showToast('success', `Channel "${name}" created!`);
        overlay.remove();
        if (onCreated) onCreated();
      } catch (err) {
        showToast('danger', 'Failed to create channel', err.message);
      } finally {
        isSubmitting = false;
        render();
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
  document.body.appendChild(overlay);
  return overlay;
}
