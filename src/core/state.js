// Introvert Reactive State Management Stores

import { config } from './config.js';
import { api } from './api.js';
import { cryptoEngine } from './crypto.js';
import { signaling } from './signaling.js';
import { webrtc } from './webrtc.js';

class Store {
  constructor(initialState = {}) {
    this.state = initialState;
    this.listeners = new Set();
  }

  get() {
    return this.state;
  }

  set(partial) {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try { listener(this.state); } catch (e) { console.error('Store listener error', e); }
    }
  }
}

// 1. Auth & Session Store
export const authStore = new Store({
  user: null,
  isAuthenticated: false,
  isE2eeReady: false,
  serverUrl: config.serverUrl,
  accounts: [],
  theme: config.theme,
  isLoading: true,
});

// 2. Direct Messaging Store
export const chatStore = new Store({
  conversations: [], // [{ id, username, display_name, avatar, online, in_call, last_message, unread_count, secure }]
  activeConversation: null, // username
  activePeer: null, // account object
  messages: {}, // username -> [messages]
  isLoadingMessages: false,
  isSending: false,
  activeSecurityMode: false, // Additional Security state
  peerSecurityMode: false,
});

// 3. Rooms & Group Spaces Store
export const roomStore = new Store({
  rooms: [], // [{ id, name, description, is_public, member_count }]
  availableRooms: [],
  activeRoom: null, // full room object with channels & members
  activeChannel: null, // channel object
  channelMessages: {}, // channelId -> [messages]
  isLoadingRoom: false,
  isLoadingMessages: false,
  voiceMembers: {}, // channelId -> [members]
});

// 4. Presence & Contacts Store
export const presenceStore = new Store({
  onlineUsers: new Set(), // Set<username>
  inCallUsers: new Set(), // Set<username>
  contacts: [], // mutual followers
  isLoadingContacts: false,
});

// 5. Call & WebRTC Store
export const callStore = new Store({
  callState: 'idle', // 'idle' | 'calling' | 'ringing' | 'connected'
  callType: 'audio', // 'audio' | 'video'
  peerUsername: null,
  peerDisplayName: null,
  channelId: null,
  channelMembers: [],
  isMuted: false,
  isDeafened: false,
  isCameraOn: false,
  isScreenSharing: false,
  callDuration: '00:00',
  localSpeaking: false,
  activeSpeaker: null,
});

// 6. Notifications & Toasts Store
export const notificationStore = new Store({
  unreadCount: 0,
  notifications: [],
  toasts: [], // [{ id, type, title, message, timeout }]
});

// --- State Bridge & Auto-Synchronizers ---

export async function initAppStores() {
  await config.init();

  authStore.set({
    user: config.currentUser,
    isAuthenticated: !!(config.token && config.currentUser),
    serverUrl: config.serverUrl,
    accounts: config.accounts,
    theme: config.theme,
    isLoading: false,
  });

  // Apply theme class to document
  document.documentElement.setAttribute('data-theme', config.theme);

  // Hook up WebRTC state changes to CallStore
  webrtc.on('state_change', (state) => {
    callStore.set(state);
  });

  webrtc.on('duration_tick', (duration) => {
    callStore.set({ callDuration: duration });
  });

  webrtc.on('local_speaking', ({ isSpeaking }) => {
    callStore.set({ localSpeaking: isSpeaking });
  });

  webrtc.on('peer_speaking', ({ username, isSpeaking }) => {
    if (isSpeaking) {
      callStore.set({ activeSpeaker: username });
    }
  });

  // Hook up Signaling Presence & Live DM events
  signaling.on('presence', ({ username, online }) => {
    const current = presenceStore.get();
    const onlineSet = new Set(current.onlineUsers);
    if (online) onlineSet.add(username);
    else onlineSet.delete(username);
    presenceStore.set({ onlineUsers: onlineSet });

    // Update conversation online state
    const convs = chatStore.get().conversations.map((c) => {
      if (c.username === username) {
        return { ...c, online };
      }
      return c;
    });
    chatStore.set({ conversations: convs });
  });

  signaling.on('new_dm', async (dmEvent) => {
    const fromUser = dmEvent.from_username;
    // Decrypt live DM. The websocket payload carries `from_id` (not
    // `sender_id`) — keying sessions by the sender's real id is what makes
    // live decrypts hit the same session the history path uses.
    try {
      await cryptoEngine.ensureReady();
      const otherIdStr = String(dmEvent.message.from_id || dmEvent.message.sender_id || '');
      const plain = await cryptoEngine.decryptDm(
        dmEvent.message,
        false,
        otherIdStr,
        dmEvent.sender_curve
      );

      const newMsg = {
        id: dmEvent.message.id,
        user_id: otherIdStr,
        body: plain,
        created_at: dmEvent.message.created_at || Date.now(),
        is_own: false,
        proto: 'olm',
      };

      // Cache the plaintext so reopening the chat never re-runs crypto on an
      // already-consumed message key. Store the UNWRAPPED envelope so the
      // cache matches the history-fetch shape regardless of WS wrapping.
      if (typeof plain === 'string' && !plain.startsWith('[Unable to decrypt')) {
        cryptoEngine.securePersistMessage(otherIdStr, {
          id: dmEvent.message.id,
          from_id: otherIdStr,
          created_at: dmEvent.message.created_at || Date.now(),
          edited_at: null,
          proto: 'olm',
          plaintext: plain,
          cipher: cryptoEngine.unwrapEnvelope(dmEvent.message.body),
          own: false,
        }).catch(() => {});
      }

      const msgs = chatStore.get().messages[fromUser] || [];
      if (msgs.some((x) => String(x.id) === String(newMsg.id))) return;
      chatStore.set({
        messages: {
          ...chatStore.get().messages,
          [fromUser]: [...msgs, newMsg],
        },
      });

      // Update conversations list preview
      refreshConversationsList();

      // Show toast if not on active thread
      if (chatStore.get().activeConversation !== fromUser) {
        showToast('message', `New message from ${dmEvent.from_display || fromUser}`, plain.slice(0, 80));
      }
    } catch (err) {
      console.warn('Live DM decryption failed', err);
    }
  });

  signaling.on('delete_dm', (data) => {
    const mid = String(data.message_id);
    const fromUser = data.from_username;
    const current = chatStore.get().messages;
    const updated = {};
    for (const u of Object.keys(current)) {
      updated[u] = (current[u] || []).filter((m) => String(m.id) !== mid);
    }
    chatStore.set({ messages: updated });
    const activePeer = chatStore.get().activePeer;
    if (activePeer && activePeer.id) {
      cryptoEngine.secureDeleteMessage(String(activePeer.id), mid).catch(() => {});
    }
    refreshConversationsList();
  });

  if (config.token) {
    signaling.connect();
    bootstrapAuthenticatedData();
  }
}

export async function bootstrapAuthenticatedData() {
  try {
    const user = await api.verifyCredentials();
    authStore.set({ user, isAuthenticated: true });

    // Initialize E2EE
    const e2eeReady = await cryptoEngine.ensureReady();
    authStore.set({ isE2eeReady: e2eeReady });

    // Load initial lists
    await Promise.all([
      refreshConversationsList(),
      refreshRoomsList(),
      refreshContactsList(),
      refreshUnreadCount(),
    ]);
  } catch (err) {
    console.error('Bootstrap data error', err);
  }
}

export async function refreshConversationsList() {
  try {
    const list = await api.getConversations();
    const currentUserId = String(config.currentUser?.id || '');

    const convs = await Promise.all(
      (Array.isArray(list) ? list : []).map(async (c) => {
        const peerId = String(c.id || (c.account && c.account.id) || '');
        const username = c.username || (c.account && c.account.username) || '';
        const displayName = c.display_name || (c.account && c.account.display_name) || username;
        const avatar = c.avatar || (c.account && c.account.avatar);
        const curveKey = c.sender_curve || c.curve25519_key || (c.account && c.account.curve25519_key);

        let preview = '';
        if (c.last_message) {
          const isProtoOlm = c.last_proto === 'olm' || (c.last_message && typeof c.last_message === 'object' && c.last_message.proto === 'olm');
          if (isProtoOlm) {
            try {
              const msgObj = typeof c.last_message === 'object' ? c.last_message : {
                body: c.last_message,
                sender_ciphertext: c.last_sender_ciphertext,
                from_id: c.last_from,
              };
              const isOwn = String(c.last_from || msgObj.from_id || msgObj.user_id) === currentUserId;
              preview = await cryptoEngine.decryptDm(msgObj, isOwn, peerId, curveKey);
            } catch (e) {
              preview = '🔒 [Encrypted Message]';
            }
          } else {
            preview = typeof c.last_message === 'string' ? c.last_message : (c.last_message.body || '');
          }
        }

        return {
          id: peerId,
          username,
          display_name: displayName,
          avatar,
          online: c.is_online || (c.account && c.account.is_online) || false,
          in_call: c.in_call || (c.account && c.account.in_call) || false,
          last_message: preview,
          last_message_ts: c.last_at || (c.last_message && c.last_message.created_at) || null,
          unread_count: c.unread || c.unread_count || 0,
          secure: c.security_active || c.secure || false,
        };
      })
    );

    const validConvs = convs.filter((c) => c.username);
    chatStore.set({ conversations: validConvs });
  } catch (e) {
    console.warn('Refresh conversations failed', e);
  }
}

export async function refreshRoomsList() {
  try {
    const rooms = await api.getRooms();
    roomStore.set({ rooms });
  } catch (e) {
    console.warn('Refresh rooms failed', e);
  }
}

export async function refreshContactsList() {
  try {
    // Get relationships & search
    presenceStore.set({ isLoadingContacts: true });
    const presenceList = await api.getPresence();
    const onlineSet = new Set();
    const inCallSet = new Set();

    presenceList.forEach((p) => {
      if (p.online) onlineSet.add(p.username);
      if (p.in_call) inCallSet.add(p.username);
    });

    presenceStore.set({
      onlineUsers: onlineSet,
      inCallUsers: inCallSet,
      contacts: presenceList,
      isLoadingContacts: false,
    });
  } catch (e) {
    presenceStore.set({ isLoadingContacts: false });
  }
}

export async function refreshUnreadCount() {
  try {
    const count = await api.getUnreadCount();
    notificationStore.set({ unreadCount: count });
  } catch (e) {}
}

export function showToast(type, title, message = '', duration = 4000) {
  const id = Date.now() + Math.random().toString(36).slice(2, 7);
  const current = notificationStore.get().toasts;
  notificationStore.set({
    toasts: [...current, { id, type, title, message, duration }],
  });

  setTimeout(() => {
    const updated = notificationStore.get().toasts.filter((t) => t.id !== id);
    notificationStore.set({ toasts: updated });
  }, duration);
}
