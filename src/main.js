// Introvert Application Main Entry Point

import { initAppStores, authStore, chatStore, roomStore, callStore, notificationStore } from './core/state.js';
import { config } from './core/config.js';
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

  const nav = createNavigation({
    onTabChange: (tab) => {
      activeTab = tab;
      updateLayout();
    },
    onOpenProfile: (user) => {
      if (!user) return;
      createProfileModal({ user });
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
        onLogout: () => {},
      });
    },
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
    } else if (state.isAuthenticated && !state.isE2eeReady) {
      // E2EE master key unlock prompt
      if (!authModalInstance) {
        authModalInstance = createAuthModal({
          onSuccess: () => {
            authModalInstance = null;
          },
        });
        authModalInstance.setMode('unlock');
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
