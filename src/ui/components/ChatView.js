// Introvert Direct Chat View Component

import { chatStore, authStore, presenceStore, showToast, refreshConversationsList } from '../../core/state.js';
import { config } from '../../core/config.js';
import { api } from '../../core/api.js';
import { cryptoEngine } from '../../core/crypto.js';
import { webrtc } from '../../core/webrtc.js';

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
    try {
      const accounts = await api.searchAccounts(username);
      activePeer = accounts.find((a) => a.username === username) || { username, display_name: username };
    } catch (e) {
      activePeer = { username, display_name: username };
    }

    render();

    // 2. Fetch history
    try {
      const history = await api.getConversationHistory(username);
      const rawMessages = history.messages || [];

      // Decrypt messages
      const decrypted = await Promise.all(
        rawMessages.map(async (m) => {
          if (m.proto === 'olm') {
            try {
              const isOwn = m.user_id === config.currentUser?.id;
              const plain = await cryptoEngine.decryptDm(
                m,
                isOwn,
                String(activePeer.id || m.user_id),
                activePeer.curve25519_key
              );
              return { ...m, body: plain, decrypted: true };
            } catch (err) {
              return { ...m, body: '🔒 [Decryption failed or message expired]', decrypted: false };
            }
          }
          return { ...m, decrypted: true };
        })
      );

      // Sort chronological
      decrypted.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
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
      if (activePeer.secure) {
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
      const otherIdStr = String(activePeer.id || '');
      const encryptedPayload = await cryptoEngine.encryptDm(otherIdStr, currentUsername, text);

      const res = await api.sendDirectMessage(currentUsername, encryptedPayload);

      const newMsg = {
        id: res.id || Date.now(),
        user_id: config.currentUser.id,
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

  const render = () => {
    if (!currentUsername || !activePeer) {
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

      <div class="message-stream" id="message-stream">
        ${
          messages.length === 0
            ? `<div style="margin:auto; text-align:center; color:var(--text-faint);">
                <p style="font-size:14px; margin-bottom:4px;">🔒 End-to-End Encrypted</p>
                <p style="font-size:12px;">Messages in this direct conversation are encrypted with Signal-style Double Ratchet Olm keys.</p>
              </div>`
            : messages
                .map((m) => {
                  const isOwn = m.user_id === config.currentUser?.id;
                  const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  const senderAvatar = isOwn
                    ? config.getAvatarUrl(config.currentUser?.avatar)
                    : avatarUrl;
                  const senderInitial = isOwn
                    ? (config.currentUser?.display_name || config.currentUser?.username || 'Y')[0].toUpperCase()
                    : initial;

                  const isSticker = m.body && m.body.startsWith('/uploads/stickers/');
                  const isMedia = m.media_path;

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
                        <div class="message-bubble">
                          ${
                            isSticker
                              ? `<img src="${config.getApiUrl(m.body)}" class="message-sticker" alt="Sticker" />`
                              : isMedia
                              ? `<img src="${config.getApiUrl(m.media_path)}" class="message-media" alt="Media" />
                                 ${m.body ? `<p style="margin-top:4px;">${escapeHtml(m.body)}</p>` : ''}`
                              : `<p>${escapeHtml(m.body)}</p>`
                          }
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join('')
        }
      </div>

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

    // Attach Handlers
    attachEventHandlers();
  };

  const renderComposer = () => {
    const btn = container.querySelector('#composer-send-btn');
    if (btn) btn.disabled = isSending;
  };

  const attachEventHandlers = () => {
    const backBtn = container.querySelector('#chat-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        container.classList.remove('mobile-active');
        if (onBack) onBack();
      });
    }

    const peerProfileBtn = container.querySelector('#chat-peer-profile-btn');
    if (peerProfileBtn) {
      peerProfileBtn.addEventListener('click', () => {
        if (onOpenProfile) onOpenProfile(activePeer);
      });
    }

    const safetyBtn = container.querySelector('#safety-keys-btn');
    if (safetyBtn) {
      safetyBtn.addEventListener('click', () => {
        if (onOpenSafetyModal) onOpenSafetyModal(currentUsername);
      });
    }

    const voiceCallBtn = container.querySelector('#voice-call-btn');
    if (voiceCallBtn) {
      voiceCallBtn.addEventListener('click', () => {
        webrtc.startCall(currentUsername, false);
      });
    }

    const videoCallBtn = container.querySelector('#video-call-btn');
    if (videoCallBtn) {
      videoCallBtn.addEventListener('click', () => {
        webrtc.startCall(currentUsername, true);
      });
    }

    const sendBtn = container.querySelector('#composer-send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', handleSend);
    }

    const input = container.querySelector('#composer-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
      // Auto resize
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
      });
    }

    const attachBtn = container.querySelector('#attach-file-btn');
    const fileInput = container.querySelector('#file-input');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          showToast('info', 'Uploading attachment...');
          const media = await api.uploadMedia(file);
          if (media && media.url) {
            // Send media message
            const otherIdStr = String(activePeer.id || '');
            const encryptedPayload = await cryptoEngine.encryptDm(otherIdStr, currentUsername, `[Attachment: ${media.url}]`);
            encryptedPayload.media_path = media.url;
            await api.sendDirectMessage(currentUsername, encryptedPayload);
            loadConversation(currentUsername);
          }
        } catch (err) {
          showToast('danger', 'Media upload failed', err.message);
        }
      });
    }
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Subscribe to reactive store
  chatStore.subscribe((state) => {
    if (state.activeConversation && state.activeConversation !== currentUsername) {
      loadConversation(state.activeConversation);
    } else if (state.activeConversation && state.messages[state.activeConversation]) {
      messages = state.messages[state.activeConversation];
      render();
      scrollToBottom();
    }
  });

  render();
  return {
    element: container,
    loadConversation,
  };
}
