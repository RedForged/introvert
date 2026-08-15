// Introvert Reactive State Management Stores

import { config } from './config.js';
import { api } from './api.js';
import { cryptoEngine } from './crypto.js';
import { loadCacheMap, resolveCachedPlaintext } from './messageCache.js';
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
  try {
    if (window.AndroidBridge?.updateTheme) {
      window.AndroidBridge.updateTheme(config.theme === 'light');
    }
  } catch (e) {}

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
    try {
      await cryptoEngine.ensureReady();
      const currentUserId = String(config.currentUser?.id || '');
      const currentUsername = config.currentUser?.username || '';
      const fromUser = dmEvent.from_username || '';
      const msgFromId = String(dmEvent.message?.from_id || dmEvent.message?.sender_id || '');
      const isOwn = msgFromId === currentUserId || (fromUser && fromUser.toLowerCase() === currentUsername.toLowerCase());

      let targetUser = fromUser;
      if (isOwn) {
        if (dmEvent.to_username) {
          targetUser = dmEvent.to_username;
        } else {
          const toIdStr = String(dmEvent.message?.to_id || '');
          const matchingConv = (chatStore.get().conversations || []).find((c) => String(c.id) === toIdStr);
          if (matchingConv && matchingConv.username) {
            targetUser = matchingConv.username;
          } else if (chatStore.get().activeConversation) {
            targetUser = chatStore.get().activeConversation;
          }
        }
      }

      // Canonicalize targetUser against active conversation or conversation list
      const activeConv = chatStore.get().activeConversation;
      if (activeConv && activeConv.toLowerCase() === targetUser.toLowerCase()) {
        targetUser = activeConv;
      } else {
        const matchingConv = (chatStore.get().conversations || []).find((c) => c.username && c.username.toLowerCase() === targetUser.toLowerCase());
        if (matchingConv && matchingConv.username) {
          targetUser = matchingConv.username;
        }
      }

      const otherIdStr = isOwn
        ? String(dmEvent.message?.to_id || msgFromId)
        : msgFromId;

      const plain = await cryptoEngine.decryptDm(
        dmEvent.message,
        isOwn,
        otherIdStr,
        dmEvent.sender_curve
      );

      const newMsg = {
        id: dmEvent.message.id,
        user_id: msgFromId,
        from_id: msgFromId,
        body: plain,
        created_at: dmEvent.message.created_at || Date.now(),
        is_own: isOwn,
        proto: 'olm',
        decrypted: typeof plain === 'string' && !plain.startsWith('[Unable to decrypt'),
      };

      // Cache the plaintext so reopening the chat never re-runs crypto on an
      // already-consumed message key. Store the UNWRAPPED envelope so the
      // cache matches the history-fetch shape regardless of WS wrapping.
      if (typeof plain === 'string' && !plain.startsWith('[Unable to decrypt')) {
        const liveRecord = {
          id: dmEvent.message.id,
          from_id: msgFromId,
          created_at: dmEvent.message.created_at || Date.now(),
          edited_at: null,
          proto: 'olm',
          plaintext: plain,
          cipher: cryptoEngine.unwrapEnvelope(dmEvent.message.body),
          own: isOwn,
        };
        if (otherIdStr) cryptoEngine.securePersistMessage(otherIdStr, liveRecord).catch(() => {});
        if (targetUser && targetUser !== otherIdStr) cryptoEngine.securePersistMessage(targetUser, liveRecord).catch(() => {});
      }

      const msgs = chatStore.get().messages[targetUser] || [];
      if (msgs.some((x) => String(x.id) === String(newMsg.id))) {
        refreshConversationsList();
        return;
      }
      chatStore.set({
        messages: {
          ...chatStore.get().messages,
          [targetUser]: [...msgs, newMsg],
        },
      });

      // Update conversations list preview
      refreshConversationsList();

      // Show toast if not on active thread and not own message
      if (!isOwn && (!activeConv || activeConv.toLowerCase() !== fromUser.toLowerCase())) {
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

    // Also remove the message from the local secure cache. chatStore.activePeer
    // is never populated, so derive the peer from the conversation list and
    // delete under BOTH namespaces.
    const conv = (chatStore.get().conversations || []).find(
      (c) => c.username && c.username.toLowerCase() === String(fromUser || '').toLowerCase()
    );
    if (conv) {
      if (conv.id) cryptoEngine.secureDeleteMessage(String(conv.id), mid).catch(() => {});
      if (conv.username) cryptoEngine.secureDeleteMessage(conv.username, mid).catch(() => {});
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

    startLivePolling();
  } catch (err) {
    console.error('Bootstrap data error', err);
  }
}

let livePollTimer = null;
let isSyncingActiveConv = false;

export function startLivePolling() {
  if (livePollTimer) return;
  livePollTimer = setInterval(async () => {
    if (!config.token) return;
    refreshConversationsList().catch(() => {});
    refreshRoomsList().catch(() => {});
    const activeConv = chatStore.get().activeConversation;
    if (activeConv) {
      syncActiveConversation(activeConv).catch(() => {});
    }
  }, 15000);
}

export function stopLivePolling() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

export async function syncActiveConversation(username) {
  if (!username || isSyncingActiveConv) return;
  isSyncingActiveConv = true;
  try {
    const history = await api.getConversationHistory(username);
    const rawMessages = history.messages || [];
    const currentUserId = String(config.currentUser?.id || '');

    const currentMap = chatStore.get().messages;
    const existing = currentMap[username] || [];
    const existingIds = new Set(existing.map((m) => String(m.id)));

    const newRaw = rawMessages.filter((m) => !existingIds.has(String(m.id)));
    if (!newRaw.length) return;

    const ordered = [...newRaw].sort(
      (a, b) => (a.created_at - b.created_at) || (Number(a.id) - Number(b.id))
    );

    const activePeer = (chatStore.get().conversations || []).find(
      (c) => c.username && c.username.toLowerCase() === username.toLowerCase()
    ) || { username };

    const peerId = String(activePeer.id || (ordered[0] && (String(ordered[0].from_id) === currentUserId ? ordered[0].to_id : ordered[0].from_id)) || '');
    const cache = await loadCacheMap(cryptoEngine, [peerId, username]);

    const decrypted = [];
    for (const m of ordered) {
      const senderId = String(m.from_id || m.user_id || m.sender_id || '');
      const isOwn = senderId === currentUserId || m.is_own === true;
      const otherIdStr = peerId || String(isOwn ? m.to_id : m.from_id);
      const curveKey = activePeer.curve25519_key || activePeer.sender_curve || m.sender_curve;

      let isOlm = m.proto === 'olm';
      if (!isOlm && typeof m.body === 'string') {
        const t = m.body.trim();
        if (t.startsWith('{') && (t.includes('"t":') || t.includes('"b":'))) {
          isOlm = true;
        }
      }

      if (isOlm) {
        const cipherNorm = cryptoEngine.unwrapEnvelope(m.body);
        const cachedPlain = resolveCachedPlaintext(cache, m.id, cipherNorm, (cipher) => cryptoEngine.unwrapEnvelope(cipher));
        if (cachedPlain !== null) {
          decrypted.push({ ...m, body: cachedPlain, is_own: isOwn, decrypted: true });
          continue;
        }
        try {
          const plain = await cryptoEngine.decryptDm(m, isOwn, otherIdStr, curveKey);
          const failed = typeof plain === 'string' && plain.startsWith('[Unable to decrypt');
          if (!failed) {
            const cipherNorm = cryptoEngine.unwrapEnvelope(m.body);
            const record = {
              id: m.id,
              from_id: isOwn ? currentUserId : senderId,
              created_at: m.created_at,
              edited_at: m.edited_at || null,
              proto: 'olm',
              plaintext: plain,
              cipher: cipherNorm,
              own: isOwn,
            };
            if (otherIdStr) cryptoEngine.securePersistMessage(otherIdStr, record).catch(() => {});
            if (username && username !== otherIdStr) cryptoEngine.securePersistMessage(username, record).catch(() => {});
          }
          decrypted.push({ ...m, body: plain, is_own: isOwn, decrypted: !failed });
        } catch (err) {
          decrypted.push({ ...m, body: '[Unable to decrypt — encrypted for previous session]', is_own: isOwn, decrypted: false });
        }
      } else {
        decrypted.push({ ...m, is_own: isOwn, decrypted: true });
      }
    }

    if (decrypted.length) {
      const updatedMessages = [...(chatStore.get().messages[username] || []), ...decrypted];
      const seen = new Set();
      const deduped = [];
      for (const msg of updatedMessages) {
        if (!seen.has(String(msg.id))) {
          seen.add(String(msg.id));
          deduped.push(msg);
        }
      }
      chatStore.set({
        messages: {
          ...chatStore.get().messages,
          [username]: deduped,
        },
      });
    }
  } catch (err) {
    // Non-fatal background sync error
  } finally {
    isSyncingActiveConv = false;
  }
}

export async function refreshConversationsList() {
  try {
    const list = await api.getConversations();

    const convs = await Promise.all(
      (Array.isArray(list) ? list : []).map(async (c) => {
        const peerId = String(c.id || (c.account && c.account.id) || '');
        const username = c.username || (c.account && c.account.username) || '';
        const displayName = c.display_name || (c.account && c.account.display_name) || username;
        const avatar = c.avatar || (c.account && c.account.avatar);

        let preview = '';
        if (c.last_message) {
          const isProtoOlm = c.last_proto === 'olm' || (c.last_message && typeof c.last_message === 'object' && c.last_message.proto === 'olm');
          if (isProtoOlm) {
            try {
              const msgObj = typeof c.last_message === 'object' ? c.last_message : {
                id: c.last_id,
                body: c.last_message,
                sender_ciphertext: c.last_sender_ciphertext,
                from_id: c.last_from,
              };
              // Preview must NEVER run Olm: decrypting here consumes one-time
              // keys and advances the double ratchet out of order (latest-first)
              // while ChatView decrypts oldest-first. Read the plaintext cache
              // only, across both namespaces, and fall back to a placeholder
              // when nothing has been decrypted yet.
              const cache = await loadCacheMap(cryptoEngine, [peerId, username]);
              const rawNorm = cryptoEngine.unwrapEnvelope(msgObj.body);
              const cachedPlain = resolveCachedPlaintext(
                cache,
                msgObj.id,
                rawNorm,
                (cipher) => cryptoEngine.unwrapEnvelope(cipher)
              );
              preview = cachedPlain !== null ? cachedPlain : '🔒 [Encrypted Message]';
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
