// Introvert Rooms & Group Spaces List Component

import { roomStore, refreshRoomsList } from '../../core/state.js';
import { config } from '../../core/config.js';

export function createRoomList({ onSelectRoom, onCreateRoom }) {
  const container = document.createElement('div');
  container.className = 'sidebar-pane';

  let searchQuery = '';

  const render = () => {
    const { rooms, activeRoom } = roomStore.get();

    const filtered = rooms.filter((r) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        (r.name && r.name.toLowerCase().includes(q)) ||
        (r.description && r.description.toLowerCase().includes(q))
      );
    });

    container.innerHTML = `
      <div class="sidebar-header">
        <h2 class="sidebar-title">Rooms & Voice</h2>
        <button class="icon-btn" id="create-room-btn" title="Create Room">
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
          <input type="text" class="search-input" placeholder="Search rooms..." value="${searchQuery}" id="room-search-input" />
        </div>
      </div>

      <div class="sidebar-list">
        ${
          filtered.length === 0
            ? `<div style="padding: 24px 16px; text-align: center; color: var(--text-faint); font-size: 13px;">
                ${searchQuery ? 'No rooms found.' : 'No rooms joined yet.<br>Click + to create or join a space.'}
              </div>`
            : filtered
                .map((r) => {
                  const isActive = activeRoom && activeRoom.id === r.id;
                  const initial = (r.name || '?')[0].toUpperCase();

                  return `
                    <div class="list-item ${isActive ? 'active' : ''}" data-room-id="${r.id}">
                      <div class="item-avatar">
                        <div class="avatar-fallback" style="background: linear-gradient(135deg, var(--bg-elevated), var(--bg-hover)); font-weight: 600;">
                          ${initial}
                        </div>
                      </div>
                      <div class="item-info">
                        <div class="item-top">
                          <span class="item-name">
                            ${escapeHtml(r.name)}
                            ${r.is_public ? '' : '<span title="Private Room" style="font-size:11px;">🔒</span>'}
                          </span>
                          <span class="item-time">${r.member_count || 1} members</span>
                        </div>
                        <div class="item-bottom">
                          <span class="item-preview">${escapeHtml(r.description) || 'Group space'}</span>
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join('')
        }
      </div>
    `;

    // Handlers
    const searchInput = container.querySelector('#room-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        render();
        const inputAfter = container.querySelector('#room-search-input');
        if (inputAfter) {
          inputAfter.focus();
          inputAfter.selectionStart = inputAfter.selectionEnd = inputAfter.value.length;
        }
      });
    }

    const createBtn = container.querySelector('#create-room-btn');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        if (onCreateRoom) onCreateRoom();
      });
    }

    container.querySelectorAll('.list-item').forEach((item) => {
      item.addEventListener('click', () => {
        const roomId = Number(item.getAttribute('data-room-id'));
        if (onSelectRoom) onSelectRoom(roomId);
      });
    });
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  roomStore.subscribe(render);
  render();
  return container;
}
