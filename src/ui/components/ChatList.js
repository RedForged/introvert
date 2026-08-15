// Introvert Chats (Direct Messages & Rooms) List Component

import { chatStore, roomStore, presenceStore } from '../../core/state.js';
import { config } from '../../core/config.js';

export function createChatList({ onSelectConversation, onSelectRoom, onStartNewDm, onCreateRoom }) {
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
      <h2 class="sidebar-title">Chats</h2>
      <div style="display:flex; align-items:center; gap:4px;">
        <button class="icon-btn" id="create-room-btn" title="Create Room">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
        </button>
        <button class="icon-btn" id="new-chat-btn" title="New Message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14"></path>
          </svg>
        </button>
      </div>
    </div>

    <div class="search-box">
      <div class="search-input-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="search-input" placeholder="Search chats..." id="chat-search-input" />
      </div>
    </div>

    <div class="sidebar-list" id="chat-sidebar-list"></div>
  `;

  // Persistent Event Delegation
  container.addEventListener('click', (e) => {
    const createRoomBtn = e.target.closest('#create-room-btn');
    if (createRoomBtn) {
      if (onCreateRoom) onCreateRoom();
      return;
    }

    const newBtn = e.target.closest('#new-chat-btn');
    if (newBtn) {
      if (onStartNewDm) onStartNewDm();
      return;
    }

    const item = e.target.closest('.list-item');
    if (item) {
      const type = item.getAttribute('data-type');
      if (type === 'dm') {
        const username = item.getAttribute('data-username');
        if (username && onSelectConversation) onSelectConversation(username);
      } else if (type === 'room') {
        const roomId = Number(item.getAttribute('data-room-id'));
        if (roomId && onSelectRoom) onSelectRoom(roomId);
      }
    }
  });

  const searchInput = container.querySelector('#chat-search-input');
  searchInput?.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    updateList();
  });

  const updateList = () => {
    const listEl = container.querySelector('#chat-sidebar-list');
    if (!listEl) return;

    const { conversations, activeConversation } = chatStore.get();
    const { rooms, activeRoom } = roomStore.get();
    const { onlineUsers, inCallUsers } = presenceStore.get();

    // Map DM conversations
    const dmItems = (conversations || []).map((c) => ({
      itemType: 'dm',
      id: c.username,
      username: c.username,
      name: c.display_name || c.username,
      subtitle: c.last_message || 'Start chatting',
      timeTs: c.last_message_ts ? Number(c.last_message_ts) : 0,
      timeLabel: formatTime(c.last_message_ts),
      avatarUrl: config.getAvatarUrl(c.avatar),
      initial: (c.display_name || c.username || '?')[0].toUpperCase(),
      unreadCount: c.unread_count || 0,
      isOnline: onlineUsers.has(c.username) || c.online,
      inCall: inCallUsers.has(c.username) || c.in_call,
      isSecure: !!c.secure,
      isActive: (!activeRoom && activeConversation && activeConversation.toLowerCase() === c.username.toLowerCase()),
      raw: c,
    }));

    // Map Rooms to display like chats
    const roomItems = (rooms || []).map((r) => {
      let roomTs = 0;
      if (r.last_message_ts) {
        roomTs = Number(r.last_message_ts);
      } else if (r.updated_at) {
        roomTs = new Date(r.updated_at).getTime() || 0;
      } else if (r.created_at) {
        roomTs = new Date(r.created_at).getTime() || 0;
      }

      const membersText = `${r.member_count || 1} ${r.member_count === 1 ? 'member' : 'members'}`;
      return {
        itemType: 'room',
        id: `room_${r.id}`,
        roomId: r.id,
        name: r.name,
        subtitle: r.last_message || r.description || membersText,
        timeTs: roomTs,
        timeLabel: r.last_message_ts ? formatTime(r.last_message_ts) : membersText,
        avatarUrl: r.avatar ? config.getAvatarUrl(r.avatar) : null,
        initial: (r.name || '#')[0].toUpperCase(),
        unreadCount: r.unread_count || 0,
        isPublic: r.is_public !== false,
        isActive: Boolean(activeRoom && Number(activeRoom.id) === Number(r.id)),
        raw: r,
      };
    });

    const allItems = [...dmItems, ...roomItems];

    // Filter by search query
    const filtered = allItems.filter((item) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      if (item.itemType === 'dm') {
        return (
          (item.name && item.name.toLowerCase().includes(q)) ||
          (item.username && item.username.toLowerCase().includes(q))
        );
      } else {
        return (
          (item.name && item.name.toLowerCase().includes(q)) ||
          (item.raw?.description && item.raw.description.toLowerCase().includes(q))
        );
      }
    });

    // Sort: newest activity first, then alphabetical
    filtered.sort((a, b) => {
      if (a.timeTs && b.timeTs) return b.timeTs - a.timeTs;
      if (a.timeTs && !b.timeTs) return -1;
      if (!a.timeTs && b.timeTs) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    listEl.innerHTML = filtered.length === 0
      ? `<div style="padding: 24px 16px; text-align: center; color: var(--text-faint); font-size: 13px;">
          ${searchQuery ? 'No chats found.' : 'No messages or rooms yet.<br>Click + to start a chat or create a room.'}
        </div>`
      : filtered
          .map((item) => {
            if (item.itemType === 'dm') {
              return `
                <div class="list-item ${item.isActive ? 'active' : ''}" data-type="dm" data-username="${item.username}">
                  <div class="item-avatar">
                    ${
                      item.avatarUrl
                        ? `<img src="${item.avatarUrl}" alt="Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                           <div class="avatar-fallback" style="display:none;">${item.initial}</div>`
                        : `<div class="avatar-fallback">${item.initial}</div>`
                    }
                    <span class="presence-dot ${item.inCall ? 'in-call' : item.isOnline ? 'online' : ''}"></span>
                  </div>
                  <div class="item-info">
                    <div class="item-top">
                      <span class="item-name">
                        ${escapeHtml(item.name)}
                        ${item.isSecure ? '<span title="Additional Security Enabled" style="font-size:11px;">🔒</span>' : ''}
                      </span>
                      <span class="item-time">${item.timeLabel}</span>
                    </div>
                    <div class="item-bottom">
                      <span class="item-preview">${escapeHtml(item.subtitle)}</span>
                      ${item.unreadCount > 0 ? `<span class="item-badge">${item.unreadCount}</span>` : ''}
                    </div>
                  </div>
                </div>
              `;
            } else {
              return `
                <div class="list-item ${item.isActive ? 'active' : ''}" data-type="room" data-room-id="${item.roomId}">
                  <div class="item-avatar">
                    ${
                      item.avatarUrl
                        ? `<img src="${item.avatarUrl}" alt="Room Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                           <div class="avatar-fallback" style="display:none; background: linear-gradient(135deg, var(--bg-elevated), var(--bg-hover)); font-weight: 600;">${item.initial}</div>`
                        : `<div class="avatar-fallback" style="background: linear-gradient(135deg, var(--bg-elevated), var(--bg-hover)); font-weight: 600;">${item.initial}</div>`
                    }
                    <span class="presence-dot" style="background: var(--accent); opacity: 0.85;" title="Room Space"></span>
                  </div>
                  <div class="item-info">
                    <div class="item-top">
                      <span class="item-name">
                        <span style="color: var(--accent); font-weight: 600; margin-right: 2px;">#</span>
                        ${escapeHtml(item.name)}
                        ${item.isPublic ? '' : '<span title="Private Room" style="font-size:11px;">🔒</span>'}
                      </span>
                      <span class="item-time">${item.timeLabel}</span>
                    </div>
                    <div class="item-bottom">
                      <span class="item-preview">${escapeHtml(item.subtitle)}</span>
                      ${item.unreadCount > 0 ? `<span class="item-badge">${item.unreadCount}</span>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }
          })
          .join('');
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  chatStore.subscribe(updateList);
  roomStore.subscribe(updateList);
  presenceStore.subscribe(updateList);

  updateList();
  return container;
}
