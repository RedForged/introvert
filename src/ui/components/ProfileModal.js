// Introvert Minimalist Profile Modal Component
// Strictly shows only Profile Picture, Username / Display Name, and Bio

import { authStore, presenceStore, showToast } from '../../core/state.js';
import { config } from '../../core/config.js';
import { api } from '../../core/api.js';
import { webrtc } from '../../core/webrtc.js';

export function createProfileModal({ user, onClose, onStartChat }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  let isEditing = false;
  let editDisplayName = user.display_name || user.username || '';
  let editBio = user.bio || '';
  let editAvatarFile = null;
  let isSaving = false;

  const isSelf = config.currentUser && String(config.currentUser.id) === String(user.id);

  const render = () => {
    const { onlineUsers, inCallUsers } = presenceStore.get();
    const isOnline = onlineUsers.has(user.username) || user.is_online;
    const inCall = inCallUsers.has(user.username) || user.in_call;
    const avatarUrl = config.getAvatarUrl(user.avatar);
    const initial = (user.display_name || user.username || '?')[0].toUpperCase();

    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <span class="modal-title">${isSelf ? 'Your Profile' : 'User Profile'}</span>
          <button class="icon-btn" id="close-profile-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          ${
            isEditing
              ? `
            <div style="display:flex; flex-direction:column; align-items:center; gap:12px; margin-bottom:12px;">
              <div class="profile-avatar-large" style="cursor:pointer;" id="change-avatar-trigger" title="Click to change avatar">
                ${
                  avatarUrl
                    ? `<img src="${avatarUrl}" alt="Avatar" id="edit-avatar-preview" />`
                    : `<div class="avatar-fallback" id="edit-avatar-fallback">${initial}</div>`
                }
                <div style="position:absolute; inset:0; background:rgba(0,0,0,0.5); border-radius:var(--radius-full); display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
                </div>
              </div>
              <input type="file" id="profile-file-input" style="display:none;" accept="image/*" />
              <span style="font-size:12px; color:var(--text-faint);">Click avatar to upload photo</span>
            </div>

            <div class="form-group">
              <label class="form-label">Display Name</label>
              <input type="text" class="form-input" id="edit-display-name" value="${escapeHtml(editDisplayName)}" maxlength="100" />
            </div>

            <div class="form-group">
              <label class="form-label">Bio</label>
              <textarea class="form-textarea" id="edit-bio" placeholder="Write a short bio..." maxlength="500">${escapeHtml(editBio)}</textarea>
            </div>
          `
              : `
            <div class="profile-card">
              <div class="profile-avatar-large">
                ${
                  avatarUrl
                    ? `<img src="${avatarUrl}" alt="Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                       <div class="avatar-fallback" style="display:none;">${initial}</div>`
                    : `<div class="avatar-fallback">${initial}</div>`
                }
                <span class="presence-dot ${inCall ? 'in-call' : isOnline ? 'online' : ''}" style="width:14px; height:14px; bottom:4px; right:4px;"></span>
              </div>

              <div>
                <h3 class="profile-name">${escapeHtml(user.display_name || user.username)}</h3>
                <p class="profile-username">@${escapeHtml(user.username)}</p>
                <div style="font-size:12px; color:${isOnline ? 'var(--emerald)' : 'var(--text-faint)'}; margin-top:2px;">
                  ${inCall ? '🔴 In a call' : isOnline ? '🟢 Online' : '⚪ Offline'}
                </div>
              </div>

              <div class="profile-bio">
                ${user.bio ? escapeHtml(user.bio) : '<span style="color:var(--text-faint); font-style:italic;">No bio set.</span>'}
              </div>

              ${
                !isSelf
                  ? `
                <div style="display:flex; gap:10px; width:100%; margin-top:8px;">
                  <button class="btn-pill primary" id="profile-msg-btn" style="flex:1; justify-content:center; height:38px;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span>Message</span>
                  </button>

                  <button class="btn-pill" id="profile-call-btn" style="height:38px;" title="Voice Call">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                    </svg>
                  </button>

                  <button class="btn-pill" id="profile-video-btn" style="height:38px;" title="Video Call">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polygon points="23 7 16 12 23 17 23 7"></polygon>
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                    </svg>
                  </button>
                </div>
              `
                  : `
                <button class="btn-pill" id="edit-profile-btn" style="width:100%; justify-content:center; height:38px; margin-top:8px;">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                  </svg>
                  <span>Edit Profile</span>
                </button>
              `
              }
            </div>
          `
          }
        </div>

        ${
          isEditing
            ? `
          <div class="modal-footer">
            <button class="btn-pill" id="cancel-edit-btn">Cancel</button>
            <button class="btn-pill primary" id="save-profile-btn" ${isSaving ? 'disabled' : ''}>
              ${isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        `
            : ''
        }
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    overlay.querySelector('#close-profile-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onClose) onClose();
      }
    });

    if (!isEditing && !isSelf) {
      overlay.querySelector('#profile-msg-btn')?.addEventListener('click', () => {
        overlay.remove();
        if (onStartChat) onStartChat(user.username);
      });
      overlay.querySelector('#profile-call-btn')?.addEventListener('click', () => {
        overlay.remove();
        webrtc.startCall(user.username, false);
      });
      overlay.querySelector('#profile-video-btn')?.addEventListener('click', () => {
        overlay.remove();
        webrtc.startCall(user.username, true);
      });
    }

    if (isSelf && !isEditing) {
      overlay.querySelector('#edit-profile-btn')?.addEventListener('click', () => {
        isEditing = true;
        render();
      });
    }

    if (isEditing) {
      overlay.querySelector('#cancel-edit-btn')?.addEventListener('click', () => {
        isEditing = false;
        render();
      });

      const fileInput = overlay.querySelector('#profile-file-input');
      overlay.querySelector('#change-avatar-trigger')?.addEventListener('click', () => {
        fileInput?.click();
      });

      fileInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          editAvatarFile = file;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const preview = overlay.querySelector('#edit-avatar-preview');
            if (preview) preview.src = ev.target.result;
            const fallback = overlay.querySelector('#edit-avatar-fallback');
            if (fallback) {
              fallback.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
            }
          };
          reader.readAsDataURL(file);
        }
      });

      overlay.querySelector('#save-profile-btn')?.addEventListener('click', async () => {
        const nameInput = overlay.querySelector('#edit-display-name');
        const bioInput = overlay.querySelector('#edit-bio');
        const name = nameInput ? nameInput.value.trim() : '';
        const bio = bioInput ? bioInput.value.trim() : '';

        isSaving = true;
        render();

        try {
          if (editAvatarFile) {
            await api.uploadAvatar(editAvatarFile);
          }
          const updated = await api.updateCredentials({ display_name: name, bio });
          authStore.set({ user: updated });
          user = updated;
          showToast('success', 'Profile updated successfully');
          isEditing = false;
        } catch (err) {
          showToast('danger', 'Failed to update profile', err.message);
        } finally {
          isSaving = false;
          render();
        }
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
  return overlay;
}
