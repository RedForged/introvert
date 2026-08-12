// Introvert Create Room & Channel Modal Component

import { api } from '../../core/api.js';
import { refreshRoomsList, showToast } from '../../core/state.js';

export function createCreateRoomModal({ onClose, onCreated }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  let name = '';
  let description = '';
  let isPublic = true;
  let isSubmitting = false;

  const render = () => {
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:400px;">
        <div class="modal-header">
          <span class="modal-title">Create Group Room</span>
          <button class="icon-btn" id="close-create-room-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Room Name</label>
            <input type="text" class="form-input" id="new-room-name" value="${escapeHtml(name)}" placeholder="e.g. Design Space" maxlength="60" />
          </div>

          <div class="form-group">
            <label class="form-label">Description (Optional)</label>
            <textarea class="form-textarea" id="new-room-desc" placeholder="What is this room about?">${escapeHtml(description)}</textarea>
          </div>

          <div class="form-group" style="flex-direction:row; align-items:center; justify-content:space-between; margin-top:6px;">
            <div>
              <div style="font-size:13px; font-weight:500;">Public Room</div>
              <div style="font-size:11.5px; color:var(--text-faint);">Anyone on instance can join</div>
            </div>
            <input type="checkbox" id="new-room-public" ${isPublic ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer;" />
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-pill" id="cancel-create-room-btn">Cancel</button>
          <button class="btn-pill primary" id="submit-create-room-btn" ${isSubmitting ? 'disabled' : ''}>
            ${isSubmitting ? 'Creating...' : 'Create Room'}
          </button>
        </div>
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    overlay.querySelector('#close-create-room-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.querySelector('#cancel-create-room-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onClose) onClose();
      }
    });

    overlay.querySelector('#new-room-name')?.addEventListener('input', (e) => (name = e.target.value));
    overlay.querySelector('#new-room-desc')?.addEventListener('input', (e) => (description = e.target.value));
    overlay.querySelector('#new-room-public')?.addEventListener('change', (e) => (isPublic = e.target.checked));

    overlay.querySelector('#submit-create-room-btn')?.addEventListener('click', async () => {
      if (!name.trim()) {
        showToast('danger', 'Please enter a room name');
        return;
      }
      isSubmitting = true;
      render();

      try {
        await api.createRoom({ name: name.trim(), description: description.trim(), is_public: isPublic });
        await refreshRoomsList();
        showToast('success', `Room "${name}" created!`);
        overlay.remove();
        if (onCreated) onCreated();
      } catch (err) {
        showToast('danger', 'Failed to create room', err.message);
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
