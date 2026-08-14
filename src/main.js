import { initAppStores, authStore, chatStore, roomStore, callStore, notificationStore, bootstrapAuthenticatedData, showToast } from './core/state.js';
import { config } from './core/config.js';
import { api } from './core/api.js';
import { cryptoEngine } from './core/crypto.js';
import { signaling } from './core/signaling.js';
import { createNavigation } from './ui/components/Navigation.js';
import { createChatList } from './ui/components/ChatList.js';
import { createChatView } from './ui/components/ChatView.js';
import { createRoomList } from './ui/components/RoomList.js';
import { createRoomView } from './ui/components/RoomView.js';
import { createContactsList } from './ui/components/ContactsList.js';
import { createCallOverlay } from './ui/components/CallOverlay.js';
import { createAuthModal } from './ui/components/AuthModal.js';
import { createProfileModal } from './ui/components/ProfileModal.js';
import { createSettingsModal } from './ui/components/SettingsModal.js';
import { createSafetyModal } from './ui/components/SafetyModal.js';
import { createCreateRoomModal } from './ui/components/CreateRoomModal.js';
import { createCreateChannelModal } from './ui/components/CreateChannelModal.js';
import { createNewChatModal } from './ui/components/NewChatModal.js';

async function bootstrap() {
  const app = document.getElementById('app');
  if (!app) return;

  // Handle OAuth Callback landing in the app. The code can arrive either in
  // the URL (?code=..., in-app mobile flow: the native listener redirects the
  // WebView back to tauri://localhost/?code=...) or captured by the native
  // OAuth listener (system-browser flow on desktop).
  const params = new URLSearchParams(window.location.search);
  let oauthCode = params.get('code');
  if (!oauthCode && (window.__TAURI_INTERNALS__ || window.__TAURI__)) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      oauthCode = (await invoke('get_oauth_code')) || null;
    } catch (e) {}
  }
  if (oauthCode && (window.location.pathname.includes('/oauth/callback') || window.location.search.includes('code=') || oauthCode.length >= 32)) {
    try {
      const channel = new BroadcastChannel('introvert_oauth');
      channel.postMessage({ type: 'oauth_code', code: oauthCode });
    } catch (e) {}
    try {
      localStorage.setItem('introvert_oauth_received_code', oauthCode);
    } catch (e) {}

    // Try to complete the login automatically (in-app mobile flow).
    let completed = false;
    try {
      const { user } = await api.completeOAuth(oauthCode);
      await cryptoEngine.ensureReady();
      authStore.set({ isE2eeReady: true, isAuthenticated: true, user });
      signaling.connect();
      await bootstrapAuthenticatedData();
      completed = true;
      showToast('success', `Authorized as @${user.username}!`);
    } catch (e) {
      console.warn('Automatic OAuth completion failed; showing copy fallback', e);
    }

    if (completed) {
      // Fall through to the normal bootstrap — the app is now authenticated.
    } else {
      app.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; width:100vw; background:var(--bg-canvas); color:var(--text-main); font-family:var(--font-sans); text-align:center; padding:24px;">
        <div class="nav-logo" style="width:54px; height:54px; font-size:24px; margin-bottom:16px; box-shadow:0 8px 24px var(--accent-glow);">I</div>
        <h2 style="font-size:22px; font-weight:700; margin-bottom:8px;">Authorization Successful</h2>
        <p style="font-size:14px; color:var(--text-muted); max-width:400px; margin-bottom:24px; line-height:1.5;">
          Your Extrovert account has been authorized. You can return to the Introvert application.
        </p>
        <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:16px 20px; max-width:420px; width:100%; display:flex; flex-direction:column; gap:12px; box-shadow:var(--shadow-md);">
          <span style="font-size:12px; color:var(--text-faint); text-transform:uppercase; font-weight:600;">Authorization Code</span>
          <div style="font-family:var(--font-mono); font-size:13px; word-break:break-all; background:var(--bg-canvas); border:1px solid var(--border-subtle); padding:10px 12px; border-radius:var(--radius-sm); user-select:all;">${escapeHtml(oauthCode)}</div>
          <button class="btn-pill primary" id="copy-oauth-code-btn" style="height:38px; justify-content:center; font-weight:600;">
            Copy Authorization Code
          </button>
        </div>
      </div>
    `;

      document.getElementById('copy-oauth-code-btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(oauthCode);
        const btn = document.getElementById('copy-oauth-code-btn');
        if (btn) btn.textContent = 'Copied to Clipboard!';
      });
      return;
    }
  }

  app.innerHTML = '<div style="display:flex; height:100vh; width:100vw; align-items:center; justify-content:center; color:var(--text-faint);">Loading Introvert...</div>';

  await initAppStores();

  let activeTab = 'chats'; // 'chats' | 'rooms' | 'contacts' | 'call'
  let authModalInstance = null;

  const appContainer = document.createElement('div');
  appContainer.className = 'app-container';

  // Instantiate Views
  const chatView = createChatView({
    onBack: () => {
      chatStore.set({ activeConversation: null });
    },
    onOpenProfile: (user) => {
      createProfileModal({
        user,
        onStartChat: (username) => {
          chatStore.set({ activeConversation: username });
          chatView.loadConversation(username);
        },
      });
    },
    onOpenSafetyModal: (username) => {
      createSafetyModal({ username });
    },
  });

  const roomView = createRoomView({
    onBack: () => {
      roomStore.set({ activeRoom: null, activeChannel: null });
    },
    onOpenProfile: (user) => {
      createProfileModal({
        user,
        onStartChat: (username) => {
          activeTab = 'chats';
          updateLayout();
          chatStore.set({ activeConversation: username });
          chatView.loadConversation(username);
        },
      });
    },
    onCreateChannel: (roomId) => {
      createCreateChannelModal({
        roomId,
        onCreated: () => {
          roomView.loadRoom(roomId);
        },
      });
    },
  });

  const chatList = createChatList({
    onSelectConversation: (username) => {
      chatStore.set({ activeConversation: username });
      chatView.loadConversation(username);
    },
    onStartNewDm: () => {
      createNewChatModal({
        onSelectUser: (username) => {
          chatStore.set({ activeConversation: username });
          chatView.loadConversation(username);
        },
      });
    },
  });

  const roomList = createRoomList({
    onSelectRoom: (roomId) => {
      roomStore.set({ activeRoom: { id: roomId } });
      roomView.loadRoom(roomId);
    },
    onCreateRoom: () => {
      createCreateRoomModal({
        onCreated: () => {},
      });
    },
  });

  const contactsList = createContactsList({
    onStartChat: (username) => {
      activeTab = 'chats';
      updateLayout();
      chatStore.set({ activeConversation: username });
      chatView.loadConversation(username);
    },
    onOpenProfile: (user) => {
      createProfileModal({
        user,
        onStartChat: (username) => {
          activeTab = 'chats';
          updateLayout();
          chatStore.set({ activeConversation: username });
          chatView.loadConversation(username);
        },
      });
    },
  });

  const performLogout = async () => {
    try {
      signaling.disconnect();
    } catch (e) {}
    await config.logout();
    authStore.set({ isAuthenticated: false, user: null, isE2eeReady: false });
    chatStore.set({ activeConversation: null, messages: {}, conversations: [] });
    roomStore.set({ activeRoom: null, activeChannel: null, rooms: [] });
    callStore.set({ callState: 'idle' });
    showToast('info', 'Logged out successfully');

    if (authModalInstance) {
      authModalInstance.destroy();
    }
    authModalInstance = createAuthModal({
      onSuccess: () => {
        window.location.reload();
      },
    });
  };

  const nav = createNavigation({
    onTabChange: (tab) => {
      activeTab = tab;
      updateLayout();
    },
    onOpenProfile: (user) => {
      if (!user) return;
      createProfileModal({ user, onLogout: performLogout });
    },
    onOpenSettings: () => {
      createSettingsModal({
        onAddAccount: () => {
          createAuthModal({
            onSuccess: () => {
              window.location.reload();
            },
          });
        },
        onLogout: performLogout,
      });
    },
    onLogout: performLogout,
  });

  const callOverlay = createCallOverlay();

  // Middle Sidebar wrapper
  const sidebarWrapper = document.createElement('div');
  sidebarWrapper.style.display = 'contents';

  // Main Stage wrapper
  const stageWrapper = document.createElement('div');
  stageWrapper.style.display = 'contents';

  const updateLayout = () => {
    sidebarWrapper.innerHTML = '';
    stageWrapper.innerHTML = '';

    if (activeTab === 'chats') {
      sidebarWrapper.appendChild(chatList);
      stageWrapper.appendChild(chatView.element);
    } else if (activeTab === 'rooms') {
      sidebarWrapper.appendChild(roomList);
      stageWrapper.appendChild(roomView.element);
    } else if (activeTab === 'contacts') {
      sidebarWrapper.appendChild(contactsList);
      stageWrapper.appendChild(chatView.element);
    } else if (activeTab === 'call') {
      sidebarWrapper.appendChild(chatList);
      stageWrapper.appendChild(chatView.element);
    }
  };

  app.innerHTML = '';
  appContainer.appendChild(nav);
  appContainer.appendChild(sidebarWrapper);
  appContainer.appendChild(stageWrapper);
  appContainer.appendChild(callOverlay);
  app.appendChild(appContainer);

  updateLayout();

  // Toast listener
  notificationStore.subscribe((state) => {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) return;
    toastContainer.innerHTML = state.toasts
      .map(
        (t) => `
      <div class="toast" style="border-left: 3px solid ${t.type === 'danger' ? 'var(--rose)' : t.type === 'success' ? 'var(--emerald)' : 'var(--accent)'}">
        <div>
          <div style="font-weight:600; font-size:12.5px;">${escapeHtml(t.title)}</div>
          ${t.message ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">${escapeHtml(t.message)}</div>` : ''}
        </div>
      </div>
    `
      )
      .join('');
  });

  // Auth gate check
  authStore.subscribe((state) => {
    if (!state.isAuthenticated && !state.isLoading) {
      if (!authModalInstance) {
        authModalInstance = createAuthModal({
          onSuccess: () => {
            authModalInstance = null;
          },
        });
      }
    }
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      createNewChatModal({
        onSelectUser: (username) => {
          chatStore.set({ activeConversation: username });
          chatView.loadConversation(username);
        },
      });
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      createNewChatModal({
        onSelectUser: (username) => {
          chatStore.set({ activeConversation: username });
          chatView.loadConversation(username);
        },
      });
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
