// Introvert Direct Chats List Component

import { chatStore, presenceStore } from '../../core/state.js';
import { config } from '../../core/config.js';

export function createChatList({ onSelectConversation, onStartNewDm }) {
  const container = document.createElement('div');
  container.className = 'sidebar-pane';

  let searchQuery = '';

  const formatTime = (ts) => {
    if (!ts) return '';
    const now = Date.now();
    const diff = Math.floor((now - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  container.innerHTML = `
    <div class="sidebar-header">
      <h2 class="sidebar-title">Direct Messages</h2>
      <button class="icon-btn" id="new-chat-btn" title="New Message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14"></path>
        </svg>
      </button>
    </div>

    <div class="search-box">
      <div class="search-input-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="search-input" placeholder="Search conversations..." id="chat-search-input" />
      </div>
    </div>

    <div class="sidebar-list" id="chat-sidebar-list"></div>
  `;

  const searchInput = container.querySelector('#chat-search-input');
  searchInput?.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    updateList();
  });

  const newChatBtn = container.querySelector('#new-chat-btn');
  newChatBtn?.addEventListener('click', () => {
    if (onStartNewDm) onStartNewDm();
  });

  const updateList = () => {
    const listEl = container.querySelector('#chat-sidebar-list');
    if (!listEl) return;

    const { conversations, activeConversation } = chatStore.get();
    const { onlineUsers, inCallUsers } = presenceStore.get();

    const filtered = (conversations || []).filter((c) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        (c.display_name && c.display_name.toLowerCase().includes(q)) ||
        (c.username && c.username.toLowerCase().includes(q))
      );
    });

    listEl.innerHTML = filtered.length === 0
      ? `<div style="padding: 24px 16px; text-align: center; color: var(--text-faint); font-size: 13px;">
          ${searchQuery ? 'No conversations found.' : 'No messages yet.<br>Click + to start a chat.'}
        </div>`
      : filtered
          .map((c) => {
            const isActive = activeConversation === c.username;
            const isOnline = onlineUsers.has(c.username) || c.online;
            const inCall = inCallUsers.has(c.username) || c.in_call;
            const avatarUrl = config.getAvatarUrl(c.avatar);
            const initial = (c.display_name || c.username || '?')[0].toUpperCase();

            return `
              <div class="list-item ${isActive ? 'active' : ''}" data-username="${c.username}">
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
                    <span class="item-name">
                      ${escapeHtml(c.display_name || c.username)}
                      ${c.secure ? '<span title="Additional Security Enabled" style="font-size:11px;">🔒</span>' : ''}
                    </span>
                    <span class="item-time">${formatTime(c.last_message_ts)}</span>
                  </div>
                  <div class="item-bottom">
                    <span class="item-preview">${escapeHtml(c.last_message) || 'Start chatting'}</span>
                    ${c.unread_count > 0 ? `<span class="item-badge">${c.unread_count}</span>` : ''}
                  </div>
                </div>
              </div>
            `;
          })
          .join('');

    listEl.querySelectorAll('.list-item').forEach((item) => {
      item.addEventListener('click', () => {
        const username = item.getAttribute('data-username');
        if (onSelectConversation) onSelectConversation(username);
      });
    });
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  chatStore.subscribe(updateList);
  presenceStore.subscribe(updateList);

  updateList();
  return container;
}
