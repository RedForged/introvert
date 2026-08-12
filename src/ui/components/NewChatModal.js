// Introvert New Chat Modal Component

import { api } from '../../core/api.js';
import { config } from '../../core/config.js';
import { presenceStore, showToast } from '../../core/state.js';

export function createNewChatModal({ onClose, onSelectUser }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  let query = '';
  let searchResults = [];
  let isSearching = false;
  let debounceTimeout = null;

  const performSearch = async (q) => {
    if (!q || !q.trim()) {
      searchResults = presenceStore.get().contacts || [];
      isSearching = false;
      render();
      return;
    }

    isSearching = true;
    render();

    try {
      const results = await api.searchAccounts(q);
      searchResults = results.filter((a) => a.id !== config.currentUser?.id);
    } catch (e) {
      searchResults = [];
    } finally {
      isSearching = false;
      render();
    }
  };

  const render = () => {
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:420px; max-height:75vh;">
        <div class="modal-header">
          <span class="modal-title">New Direct Message</span>
          <button class="icon-btn" id="close-new-chat-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div style="padding:12px 16px 8px;">
          <div class="search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" class="search-input" id="new-chat-search-input" placeholder="Type username or name..." value="${escapeHtml(query)}" autofocus />
          </div>
        </div>

        <div class="modal-body" style="padding:8px 16px 16px; gap:4px;">
          ${
            isSearching
              ? `<div style="text-align:center; padding:20px; color:var(--text-faint);">Searching instance...</div>`
              : searchResults.length === 0
              ? `<div style="text-align:center; padding:24px; color:var(--text-faint); font-size:13px;">
                  ${query ? 'No users found matching your search.' : 'Type to search users on instance.'}
                </div>`
              : searchResults
                  .map((u) => {
                    const avatarUrl = config.getAvatarUrl(u.avatar);
                    const initial = (u.display_name || u.username || '?')[0].toUpperCase();

                    return `
                      <div class="list-item new-chat-user-item" data-username="${u.username}" style="padding:8px 10px;">
                        <div class="item-avatar" style="width:36px; height:36px;">
                          ${
                            avatarUrl
                              ? `<img src="${avatarUrl}" alt="Avatar" />`
                              : `<div class="avatar-fallback" style="font-size:13px;">${initial}</div>`
                          }
                        </div>
                        <div class="item-info">
                          <div class="item-top">
                            <span class="item-name">${escapeHtml(u.display_name || u.username)}</span>
                          </div>
                          <div class="item-bottom">
                            <span class="item-preview">@${escapeHtml(u.username)}</span>
                          </div>
                        </div>
                        <button class="btn-pill primary" style="height:28px; padding:0 10px; font-size:11.5px;">Chat</button>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    overlay.querySelector('#close-new-chat-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onClose) onClose();
      }
    });

    const searchInput = overlay.querySelector('#new-chat-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        query = e.target.value;
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
          performSearch(query);
        }, 200);
      });
    }

    overlay.querySelectorAll('.new-chat-user-item').forEach((item) => {
      item.addEventListener('click', () => {
        const username = item.getAttribute('data-username');
        overlay.remove();
        if (onSelectUser) onSelectUser(username);
      });
    });
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  render();
  performSearch('');
  document.body.appendChild(overlay);
  return overlay;
}
