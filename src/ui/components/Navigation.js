// Introvert Left Rail Navigation Component

import { authStore, chatStore, callStore, notificationStore } from '../../core/state.js';
import { config } from '../../core/config.js';

export function createNavigation({ onTabChange, onOpenProfile, onOpenSettings, onLogout }) {
  const nav = document.createElement('nav');
  nav.className = 'nav-rail';

  let currentTab = 'chats';

  // Persistent Event Delegation
  nav.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.nav-btn[data-tab]');
    if (tabBtn) {
      const tab = tabBtn.getAttribute('data-tab');
      if (tab === 'settings') {
        if (onOpenSettings) onOpenSettings();
        return;
      }
      currentTab = tab;
      render();
      if (onTabChange) onTabChange(tab);
      return;
    }
    const logoutBtn = e.target.closest('#nav-logout-btn');
    if (logoutBtn) {
      if (onLogout) onLogout();
      return;
    }
    const profileTrigger = e.target.closest('#nav-profile-trigger');
    if (profileTrigger) {
      const auth = authStore.get();
      if (onOpenProfile) onOpenProfile(auth.user);
    }
  });

  const render = () => {
    const auth = authStore.get();
    const chats = chatStore.get();
    const call = callStore.get();
    const notifs = notificationStore.get();

    // Total unread DMs
    const totalUnreadDms = (chats.conversations || []).reduce((sum, c) => sum + (c.unread_count || 0), 0);

    const user = auth.user;
    const avatarUrl = user ? config.getAvatarUrl(user.avatar) : null;
    const initial = user ? (user.display_name || user.username || '?')[0].toUpperCase() : '?';

    nav.innerHTML = `
      <div class="nav-logo" title="Introvert">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <circle cx="12" cy="12" r="6"></circle>
          <circle cx="12" cy="12" r="2"></circle>
        </svg>
      </div>

      <button class="nav-btn ${currentTab === 'chats' ? 'active' : ''}" data-tab="chats" title="Direct Chats">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        ${totalUnreadDms > 0 ? `<span class="nav-badge">${totalUnreadDms > 99 ? '99+' : totalUnreadDms}</span>` : ''}
      </button>

      <button class="nav-btn ${currentTab === 'rooms' ? 'active' : ''}" data-tab="rooms" title="Rooms & Voice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"></rect>
          <rect x="14" y="3" width="7" height="7"></rect>
          <rect x="14" y="14" width="7" height="7"></rect>
          <rect x="3" y="14" width="7" height="7"></rect>
        </svg>
      </button>

      <button class="nav-btn ${currentTab === 'contacts' ? 'active' : ''}" data-tab="contacts" title="Contacts">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
      </button>

      ${call.callState !== 'idle' ? `
        <button class="nav-btn active call-indicator-btn" data-tab="call" title="Active Call" style="background: var(--emerald); box-shadow: 0 0 12px var(--emerald-glow);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
          </svg>
        </button>
      ` : ''}

      <div class="nav-spacer"></div>

      <button class="nav-btn ${currentTab === 'settings' ? 'active' : ''}" data-tab="settings" title="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>

      <button class="nav-btn" id="nav-logout-btn" title="Log Out" style="color:var(--text-muted);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
      </button>

      <div class="nav-divider"></div>

      <div class="nav-user-avatar" id="nav-profile-trigger" title="${user ? user.display_name || user.username : 'Profile'}">
        ${avatarUrl
          ? `<img src="${avatarUrl}" alt="Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
             <div class="avatar-fallback" style="display:none;">${initial}</div>`
          : `<div class="avatar-fallback">${initial}</div>`
        }
        <span class="presence-dot online"></span>
      </div>
    `;
  };

  authStore.subscribe(render);
  chatStore.subscribe(render);
  callStore.subscribe(render);
  notificationStore.subscribe(render);

  render();
  return nav;
}
