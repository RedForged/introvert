import { chatStore, authStore, presenceStore, showToast, refreshConversationsList } from '../../core/state.js';
import { config } from '../../core/config.js';
import { api } from '../../core/api.js';
import { cryptoEngine } from '../../core/crypto.js';
import { webrtc } from '../../core/webrtc.js';
import { createRestoreBackupModal } from './RestoreBackupModal.js';

export function createChatView({ onBack, onOpenProfile, onOpenSafetyModal }) {
  const container = document.createElement('div');
  container.className = 'main-stage';

  let currentUsername = null;
  let activePeer = null;
  let messages = [];
  let isSending = false;
  let isSecureMode = false;

  const loadConversation = async (username) => {
    if (!username) return;
    currentUsername = username;
    container.classList.add('mobile-active');

    // 1. Fetch peer account details
    activePeer = { username, display_name: username };
    const conv = (chatStore.get().conversations || []).find(
      (c) => c.username && c.username.toLowerCase() === username.toLowerCase()
    );
    if (conv) {
      activePeer = { ...conv };
    }

    try {
      const searchRes = await api.searchAccounts(username);
      const exact = searchRes.find(
        (a) => a.username && a.username.toLowerCase() === username.toLowerCase()
      );
      if (exact) {
        activePeer = { ...activePeer, ...exact };
      }
    } catch (e) {}

    render();

    // 2. Fetch history
    try {
      const history = await api.getConversationHistory(username);
      const rawMessages = history.messages || [];
      const currentUserId = String(config.currentUser?.id || '');

      // Infer peer ID if not yet known
      if (!activePeer.id && rawMessages.length > 0) {
        for (const m of rawMessages) {
          const sId = String(m.from_id || m.user_id || '');
          if (sId && sId !== currentUserId) {
            activePeer.id = sId;
            break;
          } else if (m.to_id && String(m.to_id) !== currentUserId) {
            activePeer.id = String(m.to_id);
            break;
          }
        }
      }

      // Sort chronological FIRST, then decrypt strictly in order: Olm's double
      // ratchet is stateful, so messages must be decrypted oldest → newest one
      // at a time (the crypto engine also serializes per peer).
      const ordered = [...rawMessages].sort(
        (a, b) => (a.created_at - b.created_at) || (Number(a.id) - Number(b.id))
      );

      // Plaintext cache: once a message has been decrypted its message key is
      // consumed — re-decrypting it after the session ratcheted past it fails.
      // Persist every decrypted plaintext locally (like Extrovert does) so
      // re-opening a chat never has to re-run crypto for old messages. The
      // cached record keeps the original ciphertext so an EDITED message
      // (same id, new body) is re-decrypted instead of showing stale text.
      const cacheKey = String(activePeer.id || username);
      const cachedMap = new Map();
      try {
        const cachedRecs = await cryptoEngine.secureLoadMessages(cacheKey);
        for (const r of cachedRecs || []) {
          if (r && r.id !== undefined && r.plaintext !== undefined) {
            cachedMap.set(String(r.id), r);
          }
        }
      } catch (e) {}

      const decrypted = [];
      for (const m of ordered) {
        const senderId = String(m.from_id || m.user_id || m.sender_id || '');
        const isOwn = senderId === currentUserId || m.is_own === true;
        const otherIdStr = String(activePeer.id || (isOwn ? m.to_id : m.from_id) || username);
        const curveKey = activePeer.curve25519_key || activePeer.sender_curve || m.sender_curve;

        let isOlm = m.proto === 'olm';
        if (!isOlm && typeof m.body === 'string') {
          const t = m.body.trim();
          if (t.startsWith('{') && (t.includes('"t":') || t.includes('"b":'))) {
            isOlm = true;
          }
        }

        if (isOlm) {
          const cached = cachedMap.get(String(m.id));
          if (cached && (cached.cipher === undefined || cryptoEngine.unwrapEnvelope(cached.cipher) === cryptoEngine.unwrapEnvelope(m.body))) {
            decrypted.push({ ...m, body: cached.plaintext, is_own: isOwn, decrypted: true });
            continue;
          }
          try {
            const plain = await cryptoEngine.decryptDm(m, isOwn, otherIdStr, curveKey);
            const failed = typeof plain === 'string' && plain.startsWith('[Unable to decrypt');
            if (!failed) {
              const cipherNorm = cryptoEngine.unwrapEnvelope(m.body);
              cachedMap.set(String(m.id), { plaintext: plain, cipher: cipherNorm });
              cryptoEngine.securePersistMessage(otherIdStr, {
                id: m.id,
                from_id: isOwn ? currentUserId : senderId,
                created_at: m.created_at,
                edited_at: m.edited_at || null,
                proto: 'olm',
                plaintext: plain,
                cipher: cipherNorm,
                own: isOwn,
              }).catch(() => {});
            }
            decrypted.push({ ...m, body: plain, is_own: isOwn, decrypted: !failed });
          } catch (err) {
            decrypted.push({ ...m, body: '[Unable to decrypt — encrypted for previous session]', is_own: isOwn, decrypted: false });
          }
        } else {
          decrypted.push({ ...m, is_own: isOwn, decrypted: true });
        }
      }

      // Clean up cached messages that were deleted on the server (non-secure mode)
      const serverMsgIds = new Set(ordered.map((m) => String(m.id)));
      for (const [id] of cachedMap.entries()) {
        if (!serverMsgIds.has(id)) {
          cryptoEngine.secureDeleteMessage(cacheKey, id).catch(() => {});
        }
      }

      // Merge in any live messages that arrived while history was loading so
      // this overwrite doesn't drop them.
      const liveMsgs = chatStore.get().messages[username] || [];
      for (const lm of liveMsgs) {
        if (!decrypted.some((d) => String(d.id) === String(lm.id))) {
          decrypted.push(lm);
        }
      }
      decrypted.sort((a, b) => (a.created_at - b.created_at) || (Number(a.id) - Number(b.id)));
      messages = decrypted;

      // Update store
      chatStore.set({
        messages: {
          ...chatStore.get().messages,
          [username]: messages,
        },
      });

      render();
      scrollToBottom();

      // Check Additional Security
      if (activePeer.secure || activePeer.security_active) {
        isSecureMode = true;
        // Acknowledge received messages
        const unackedIds = messages.filter((m) => !m.is_own).map((m) => m.id);
        if (unackedIds.length > 0) {
          api.ackReceivedMessages(username, unackedIds);
        }
      }
    } catch (err) {
      console.warn('Failed to load conversation history', err);
    }
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      const stream = container.querySelector('#message-stream');
      if (stream) stream.scrollTop = stream.scrollHeight;
    }, 50);
  };

  const handleSend = async () => {
    const input = container.querySelector('#composer-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || isSending || !currentUsername) return;

    isSending = true;
    input.value = '';
    renderComposer();

    try {
      const otherIdStr = String(activePeer.id || currentUsername);
      const encryptedPayload = await cryptoEngine.encryptDm(otherIdStr, currentUsername, text);

      const res = await api.sendDirectMessage(currentUsername, encryptedPayload);

      const newMsg = {
        id: res.id || Date.now(),
        user_id: config.currentUser.id,
        from_id: config.currentUser.id,
        body: text,
        created_at: Date.now(),
        is_own: true,
        proto: 'olm',
        decrypted: true,
      };

      messages = [...messages, newMsg];
      chatStore.set({
        messages: {
          ...chatStore.get().messages,
          [currentUsername]: messages,
        },
      });

      cryptoEngine.securePersistMessage(otherIdStr, {
        id: newMsg.id,
        from_id: String(config.currentUser?.id || ''),
        created_at: newMsg.created_at,
        edited_at: null,
        proto: 'olm',
        plaintext: text,
        cipher: typeof encryptedPayload === 'object' ? JSON.stringify(encryptedPayload) : String(encryptedPayload),
        own: true,
      }).catch(() => {});

      render();
      scrollToBottom();
      refreshConversationsList();
    } catch (err) {
      console.error('Send message failed', err);
      showToast('danger', 'Failed to send message', err.message);
    } finally {
      isSending = false;
      renderComposer();
      const inputAfter = container.querySelector('#composer-input');
      if (inputAfter) inputAfter.focus();
    }
  };

  let renderedUsername = null;

  const renderMessagesOnly = () => {
    const stream = container.querySelector('#message-stream');
    if (!stream) return;

    const initial = (activePeer?.display_name || activePeer?.username || '?')[0].toUpperCase();
    const avatarUrl = config.getAvatarUrl(activePeer?.avatar);

    stream.innerHTML = messages.length === 0
      ? `<div style="margin:auto; text-align:center; color:var(--text-faint);">
          <p style="font-size:14px; margin-bottom:4px;">🔒 End-to-End Encrypted</p>
          <p style="font-size:12px;">Messages in this direct conversation are encrypted with Signal-style Double Ratchet Olm keys.</p>
        </div>`
      : messages
          .map((m) => {
            const senderId = String(m.from_id || m.user_id || m.sender_id || '');
            const currentUserId = String(config.currentUser?.id || '');
            const isOwn = m.is_own !== undefined ? m.is_own : (senderId === currentUserId);
            const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const senderAvatar = isOwn
              ? config.getAvatarUrl(config.currentUser?.avatar)
              : avatarUrl;
            const senderInitial = isOwn
              ? (config.currentUser?.display_name || config.currentUser?.username || 'Y')[0].toUpperCase()
              : initial;

            const isSticker = m.body && m.body.startsWith('/uploads/stickers/');
            const isMedia = m.media_path;
            const isDecryptFailed = m.body && typeof m.body === 'string' && m.body.startsWith('[Unable to decrypt');

            return `
              <div class="message-bubble-group ${isOwn ? 'own' : ''}">
                <div class="message-avatar">
                  ${
                    senderAvatar
                      ? `<img src="${senderAvatar}" alt="Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                         <div class="avatar-fallback" style="display:none;">${senderInitial}</div>`
                      : `<div class="avatar-fallback">${senderInitial}</div>`
                  }
                </div>
                <div class="message-content-wrap">
                  <div class="message-author">
                    <span>${isOwn ? 'You' : activePeer.display_name || activePeer.username}</span>
                    <span class="message-time">${time}</span>
                  </div>
                  <div class="message-bubble ${isDecryptFailed ? 'decrypt-failed-bubble' : ''}">
                    ${
                      isSticker
                        ? `<img src="${config.getApiUrl(m.body)}" class="message-sticker" alt="Sticker" />`
                        : isMedia
                        ? `<img src="${config.getApiUrl(m.media_path)}" class="message-media" alt="Media" />
                           ${m.body ? `<p style="margin-top:4px;">${escapeHtml(m.body)}</p>` : ''}`
                        : isDecryptFailed
                        ? `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:12.5px; color:var(--text-faint);">
                            <span>🔒 Encrypted for previous session</span>
                            <button class="btn-pill restore-trigger-btn" style="height:22px; padding:0 8px; font-size:11px; background:var(--bg-glass); border:1px solid var(--border); cursor:pointer;">Restore Backup</button>
                           </div>`
                        : `<p>${escapeHtml(m.body)}</p>`
                    }
                  </div>
                </div>
              </div>
            `;
          })
          .join('');

    stream.querySelectorAll('.restore-trigger-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        createRestoreBackupModal({
          onSuccess: () => {
            if (currentUsername) loadConversation(currentUsername);
          },
        });
      });
    });
  };

  const render = () => {
    if (!currentUsername || !activePeer) {
      renderedUsername = null;
      container.innerHTML = `
        <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--text-faint); gap:12px;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <p style="font-size:14px;">Select a conversation or start a new chat</p>
        </div>
      `;
      return;
    }

    const { onlineUsers, inCallUsers } = presenceStore.get();
    const isOnline = onlineUsers.has(currentUsername) || activePeer.online;
    const inCall = inCallUsers.has(currentUsername) || activePeer.in_call;
    const avatarUrl = config.getAvatarUrl(activePeer.avatar);
    const initial = (activePeer.display_name || activePeer.username || '?')[0].toUpperCase();

    // If already rendered this user's conversation, just update stream and status
    if (renderedUsername === currentUsername && container.querySelector('#message-stream')) {
      const statusEl = container.querySelector('.stage-header-status');
      if (statusEl) {
        statusEl.textContent = `${inCall ? 'In another call' : isOnline ? 'Online' : 'Offline'} • E2EE Olm`;
      }
      const dot = container.querySelector('.stage-header-info .presence-dot');
      if (dot) {
        dot.className = `presence-dot ${inCall ? 'in-call' : isOnline ? 'online' : ''}`;
      }
      renderMessagesOnly();
      return;
    }

    renderedUsername = currentUsername;

    container.innerHTML = `
      <div class="stage-header">
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="icon-btn mobile-back-btn" id="chat-back-btn" title="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"></path>
            </svg>
          </button>
          <div class="stage-header-info" id="chat-peer-profile-btn">
            <div class="item-avatar" style="width:34px; height:34px;">
              ${
                avatarUrl
                  ? `<img src="${avatarUrl}" alt="Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                     <div class="avatar-fallback" style="display:none; font-size:12px;">${initial}</div>`
                  : `<div class="avatar-fallback" style="font-size:12px;">${initial}</div>`
              }
              <span class="presence-dot ${inCall ? 'in-call' : isOnline ? 'online' : ''}" style="width:8px; height:8px;"></span>
            </div>
            <div>
              <div class="stage-header-title">
                ${activePeer.display_name || activePeer.username}
                ${isSecureMode ? '<span title="Additional Security Enabled" style="font-size:12px;">🔒</span>' : ''}
              </div>
              <div class="stage-header-status">
                ${inCall ? 'In another call' : isOnline ? 'Online' : 'Offline'} • E2EE Olm
              </div>
            </div>
          </div>
        </div>

        <div class="stage-header-actions">
          <button class="btn-pill" id="rekey-btn" title="Reset and re-establish fresh encryption keys with this peer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
            </svg>
            <span>Re-Key</span>
          </button>

          <button class="btn-pill" id="safety-keys-btn" title="Verify Safety Numbers">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span>Safety</span>
          </button>

          <button class="btn-pill primary" id="voice-call-btn" title="Voice Call">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
            </svg>
            <span>Call</span>
          </button>

          <button class="btn-pill" id="video-call-btn" title="Video Call">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
            <span>Video</span>
          </button>
        </div>
      </div>

      <div class="message-stream" id="message-stream"></div>

      <div class="composer-container">
        <div class="composer-box">
          <button class="icon-btn" id="attach-file-btn" title="Send Attachment">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
            </svg>
          </button>
          <input type="file" id="file-input" style="display:none;" accept="image/*,video/*,audio/*" />

          <textarea class="composer-input" id="composer-input" placeholder="Message @${activePeer.username} (E2EE)..." rows="1"></textarea>

          <div class="composer-actions">
            <button class="composer-send-btn" id="composer-send-btn" ${isSending ? 'disabled' : ''} title="Send Message">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    renderMessagesOnly();
  };

  const renderComposer = () => {
    const btn = container.querySelector('#composer-send-btn');
    if (btn) btn.disabled = isSending;
  };

  // Persistent Event Delegation on Container
  container.addEventListener('click', async (e) => {
    const backBtn = e.target.closest('#chat-back-btn');
    if (backBtn) {
      container.classList.remove('mobile-active');
      if (onBack) onBack();
      return;
    }

    const peerProfileBtn = e.target.closest('#chat-peer-profile-btn');
    if (peerProfileBtn) {
      if (onOpenProfile && activePeer) onOpenProfile(activePeer);
      return;
    }

    const rekeyBtn = e.target.closest('#rekey-btn');
    if (rekeyBtn) {
      const otherIdStr = String(activePeer?.id || '');
      showToast('info', 'Re-initializing encryption sessions...');
      await cryptoEngine.repairSessions(otherIdStr);
      showToast('success', 'Encryption keys reset. Next message will establish a fresh PreKey session.');
      if (currentUsername) loadConversation(currentUsername);
      return;
    }

    const safetyBtn = e.target.closest('#safety-keys-btn');
    if (safetyBtn) {
      if (onOpenSafetyModal && currentUsername) onOpenSafetyModal(currentUsername);
      return;
    }

    const voiceCallBtn = e.target.closest('#voice-call-btn');
    if (voiceCallBtn) {
      if (currentUsername) webrtc.startCall(currentUsername, false);
      return;
    }

    const videoCallBtn = e.target.closest('#video-call-btn');
    if (videoCallBtn) {
      if (currentUsername) webrtc.startCall(currentUsername, true);
      return;
    }

    const sendBtn = e.target.closest('#composer-send-btn');
    if (sendBtn) {
      handleSend();
      return;
    }

    const attachBtn = e.target.closest('#attach-file-btn');
    if (attachBtn) {
      const fileInput = container.querySelector('#file-input');
      if (fileInput) fileInput.click();
      return;
    }

    const restoreBtn = e.target.closest('.restore-trigger-btn');
    if (restoreBtn) {
      createRestoreBackupModal({
        onSuccess: () => {
          if (currentUsername) loadConversation(currentUsername);
        },
      });
      return;
    }
  });

  container.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'composer-input') {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }
  });

  container.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'composer-input') {
      e.target.style.height = 'auto';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
    }
  });

  container.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'file-input') {
      const file = e.target.files?.[0];
      if (!file || !currentUsername) return;
      try {
        showToast('info', 'Uploading attachment...');
        const media = await api.uploadMedia(file);
        if (media && media.url) {
          const otherIdStr = String(activePeer?.id || '');
          const encryptedPayload = await cryptoEngine.encryptDm(otherIdStr, currentUsername, `[Attachment: ${media.url}]`);
          encryptedPayload.media_path = media.url;
          await api.sendDirectMessage(currentUsername, encryptedPayload);
          loadConversation(currentUsername);
        }
      } catch (err) {
        showToast('danger', 'Media upload failed', err.message);
      }
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Subscribe to reactive store
  chatStore.subscribe((state) => {
    if (state.activeConversation && state.activeConversation.toLowerCase() !== (currentUsername || '').toLowerCase()) {
      loadConversation(state.activeConversation);
    } else if (currentUsername) {
      const convKey = Object.keys(state.messages).find((k) => k.toLowerCase() === currentUsername.toLowerCase()) || currentUsername;
      const newMsgs = state.messages[convKey];
      if (newMsgs && newMsgs !== messages) {
        messages = newMsgs;
        renderMessagesOnly();
        scrollToBottom();
      }
    }
  });

  presenceStore.subscribe(() => {
    if (currentUsername && renderedUsername === currentUsername) {
      const { onlineUsers, inCallUsers } = presenceStore.get();
      const isOnline = onlineUsers.has(currentUsername) || activePeer?.online;
      const inCall = inCallUsers.has(currentUsername) || activePeer?.in_call;
      const statusEl = container.querySelector('.stage-header-status');
      if (statusEl) {
        statusEl.textContent = `${inCall ? 'In another call' : isOnline ? 'Online' : 'Offline'} • E2EE Olm`;
      }
      const dot = container.querySelector('.stage-header-info .presence-dot');
      if (dot) {
        dot.className = `presence-dot ${inCall ? 'in-call' : isOnline ? 'online' : ''}`;
      }
    }
  });

  render();
  return {
    element: container,
    loadConversation,
  };
}
