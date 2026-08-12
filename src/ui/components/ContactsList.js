// Introvert Contacts & Mutual Followers List Component

import { presenceStore } from '../../core/state.js';
import { config } from '../../core/config.js';
import { webrtc } from '../../core/webrtc.js';

export function createContactsList({ onStartChat, onOpenProfile }) {
  const container = document.createElement('div');
  container.className = 'sidebar-pane';

  let searchQuery = '';

  const render = () => {
    const { contacts, onlineUsers, inCallUsers } = presenceStore.get();

    const filtered = contacts.filter((c) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        (c.display_name && c.display_name.toLowerCase().includes(q)) ||
        (c.username && c.username.toLowerCase().includes(q))
      );
    });

    container.innerHTML = `
      <div class="sidebar-header">
        <h2 class="sidebar-title">Contacts & Mutuals</h2>
      </div>

      <div class="search-box">
        <div class="search-input-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input type="text" class="search-input" placeholder="Search contacts..." value="${searchQuery}" id="contacts-search-input" />
        </div>
      </div>

      <div class="sidebar-list">
        ${
          filtered.length === 0
            ? `<div style="padding: 24px 16px; text-align: center; color: var(--text-faint); font-size: 13px;">
                ${searchQuery ? 'No matching contacts.' : 'No mutual contacts online.<br>Mutual followers will appear here.'}
              </div>`
            : filtered
                .map((c) => {
                  const isOnline = onlineUsers.has(c.username) || c.online;
                  const inCall = inCallUsers.has(c.username) || c.in_call;
                  const avatarUrl = config.getAvatarUrl(c.avatar);
                  const initial = (c.display_name || c.username || '?')[0].toUpperCase();

                  return `
                    <div class="list-item" data-username="${c.username}">
                      <div class="item-avatar">
                        ${
                          avatarUrl
                            ? `<img src="${avatarUrl}" alt="Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                               <div class="avatar-fallback" style="display:none;">${initial}</div>`
                            : `<div class="avatar-fallback">${initial}</div>`
                        }
                        <span class="presence-dot ${inCall ? 'in-call' : isOnline ? 'online' : ''}"></span>
                      </div>
                      <div class="item-info">
                        <div class="item-top">
                          <span class="item-name">${escapeHtml(c.display_name || c.username)}</span>
                        </div>
                        <div class="item-bottom">
                          <span class="item-preview">@${escapeHtml(c.username)} • ${inCall ? 'In call' : isOnline ? 'Online' : 'Offline'}</span>
                        </div>
                      </div>
                      <div style="display:flex; gap:4px;">
                        <button class="icon-btn start-call-icon-btn" data-username="${c.username}" title="Voice Call" style="width:28px; height:28px;">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                          </svg>
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    `;

    // Handlers
    const searchInput = container.querySelector('#contacts-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        render();
        const inputAfter = container.querySelector('#contacts-search-input');
        if (inputAfter) {
          inputAfter.focus();
          inputAfter.selectionStart = inputAfter.selectionEnd = inputAfter.value.length;
        }
      });
    }

    container.querySelectorAll('.list-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.start-call-icon-btn')) return;
        const username = item.getAttribute('data-username');
        if (onStartChat) onStartChat(username);
      });
    });

    container.querySelectorAll('.start-call-icon-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const username = btn.getAttribute('data-username');
        webrtc.startCall(username, false);
      });
    });
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  presenceStore.subscribe(render);
  render();
  return container;
}
