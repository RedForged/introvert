// Introvert Room Group Space & Channels View Component

import { roomStore, authStore, showToast } from '../../core/state.js';
import { config } from '../../core/config.js';
import { api } from '../../core/api.js';
import { cryptoEngine } from '../../core/crypto.js';
import { webrtc } from '../../core/webrtc.js';

export function createRoomView({ onBack, onOpenProfile, onCreateChannel }) {
  const container = document.createElement('div');
  container.className = 'main-stage';

  let currentRoomId = null;
  let activeRoom = null;
  let activeChannel = null;
  let messages = [];
  let isSending = false;
  let showMembersDrawer = false;

  const loadRoom = async (roomId) => {
    if (!roomId) return;
    currentRoomId = roomId;
    container.classList.add('mobile-active');

    try {
      const room = await api.getRoomDetails(roomId);
      activeRoom = room;

      // Select first channel by default
      const channels = room.channels || [];
      activeChannel = channels[0] || null;

      roomStore.set({ activeRoom, activeChannel });
      render();

      // Sync Megolm group session with room members
      if (config.currentUser && room.members) {
        cryptoEngine.syncRoomSessions(roomId, config.currentUser.id, room.members).catch((err) => {
          console.warn('Megolm room sync error', err);
        });
      }

      if (activeChannel && activeChannel.type === 'text') {
        loadChannelMessages(activeChannel.id);
      }
    } catch (err) {
      console.error('Failed to load room', err);
      showToast('danger', 'Failed to load room details');
    }
  };

  const loadChannelMessages = async (channelId) => {
    if (!currentRoomId || !channelId) return;
    try {
      const raw = await api.getChannelMessages(currentRoomId, channelId);
      // Decrypt Megolm messages
      const decrypted = await Promise.all(
        raw.map(async (m) => {
          if (m.proto === 'megolm') {
            try {
              const plain = await cryptoEngine.decryptRoomMessage(
                currentRoomId,
                m.user_id,
                m.ciphertext || m.body,
                m.group_session_id
              );
              return { ...m, body: plain, decrypted: true };
            } catch (err) {
              return { ...m, body: '🔒 [Megolm Decryption Pending]', decrypted: false };
            }
          }
          return { ...m, decrypted: true };
        })
      );

      decrypted.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
      messages = decrypted;
      render();
      scrollToBottom();
    } catch (err) {
      console.warn('Failed to load channel messages', err);
    }
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      const stream = container.querySelector('#room-message-stream');
      if (stream) stream.scrollTop = stream.scrollHeight;
    }, 50);
  };

  const handleSend = async () => {
    const input = container.querySelector('#room-composer-input');
    if (!input || !activeChannel || activeChannel.type !== 'text') return;
    const text = input.value.trim();
    if (!text || isSending || !currentRoomId) return;

    isSending = true;
    input.value = '';

    try {
      const { ciphertext, group_session_id } = await cryptoEngine.encryptRoomMessage(currentRoomId, text);

      const res = await api.sendChannelMessage(currentRoomId, activeChannel.id, {
        body: ciphertext,
        proto: 'megolm',
        group_session_id,
      });

      const newMsg = {
        id: res.id || Date.now(),
        user_id: config.currentUser.id,
        username: config.currentUser.username,
        display_name: config.currentUser.display_name,
        avatar: config.currentUser.avatar,
        body: text,
        created_at: Date.now(),
        is_own: true,
        proto: 'megolm',
        decrypted: true,
      };

      messages = [...messages, newMsg];
      render();
      scrollToBottom();
    } catch (err) {
      console.error('Send room message failed', err);
      showToast('danger', 'Failed to send room message', err.message);
    } finally {
      isSending = false;
      const inputAfter = container.querySelector('#room-composer-input');
      if (inputAfter) inputAfter.focus();
    }
  };

  const render = () => {
    if (!activeRoom) {
      container.innerHTML = `
        <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--text-faint); gap:12px;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
          <p style="font-size:14px;">Select a room to open channels</p>
        </div>
      `;
      return;
    }

    const channels = activeRoom.channels || [];
    const textChannels = channels.filter((c) => c.type === 'text' || !c.type);
    const voiceChannels = channels.filter((c) => c.type === 'voice');
    const isVoice = activeChannel && activeChannel.type === 'voice';

    const isInThisVoiceChannel = webrtc.callState === 'connected' && webrtc.channelId === activeChannel?.id;

    container.innerHTML = `
      <div style="display:flex; width:100%; height:100%;">
        <!-- Channel Sub-Sidebar -->
        <div style="width:220px; height:100%; background:var(--bg-surface); border-right:1px solid var(--border-subtle); display:flex; flex-direction:column;">
          <div style="padding:16px 14px; border-bottom:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:space-between;">
            <span style="font-size:14px; font-weight:600; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${escapeHtml(activeRoom.name)}
            </span>
            <button class="icon-btn" id="add-channel-btn" title="Create Channel" style="width:26px; height:26px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
            </button>
          </div>

          <div style="flex:1; overflow-y:auto; padding:8px 6px;">
            ${
              textChannels.length > 0
                ? `<div class="channel-category">Text Channels</div>
                   ${textChannels
                     .map(
                       (ch) => `
                        <div class="channel-item ${activeChannel?.id === ch.id ? 'active' : ''}" data-channel-id="${ch.id}">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="4" y1="9" x2="20" y2="9"></line>
                            <line x1="4" y1="15" x2="20" y2="15"></line>
                            <line x1="10" y1="3" x2="8" y2="21"></line>
                            <line x1="16" y1="3" x2="14" y2="21"></line>
                          </svg>
                          <span>${escapeHtml(ch.name)}</span>
                        </div>
                      `
                     )
                     .join('')}`
                : ''
            }

            ${
              voiceChannels.length > 0
                ? `<div class="channel-category" style="margin-top:10px;">Voice Channels</div>
                   ${voiceChannels
                     .map(
                       (ch) => `
                        <div class="channel-item ${activeChannel?.id === ch.id ? 'active' : ''}" data-channel-id="${ch.id}">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                          </svg>
                          <span>${escapeHtml(ch.name)}</span>
                        </div>
                      `
                     )
                     .join('')}`
                : ''
            }
          </div>
        </div>

        <!-- Channel Main Stage -->
        <div style="flex:1; height:100%; display:flex; flex-direction:column; background:var(--bg-canvas);">
          <div class="stage-header">
            <div style="display:flex; align-items:center; gap:8px;">
              <button class="icon-btn mobile-back-btn" id="room-back-btn" title="Back">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7"></path>
                </svg>
              </button>
              <div>
                <div class="stage-header-title">
                  ${isVoice ? '🔊' : '#'} ${activeChannel ? escapeHtml(activeChannel.name) : 'general'}
                </div>
                <div class="stage-header-status">
                  ${escapeHtml(activeRoom.description) || 'Megolm E2EE Group Space'}
                </div>
              </div>
            </div>

            <div class="stage-header-actions">
              <button class="btn-pill" id="toggle-members-drawer-btn" title="Room Members">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                </svg>
                <span>${(activeRoom.members || []).length} Members</span>
              </button>
            </div>
          </div>

          ${
            isVoice
              ? `
              <!-- Voice Channel Stage -->
              <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px; gap:24px;">
                <div style="text-align:center;">
                  <div style="width:72px; height:72px; border-radius:var(--radius-full); background:linear-gradient(135deg, var(--accent), #4338ca); display:flex; align-items:center; justify-content:center; margin:0 auto 16px; box-shadow:0 8px 24px var(--accent-glow);">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </svg>
                  </div>
                  <h3 style="font-size:18px; font-weight:600; margin-bottom:4px;">${escapeHtml(activeChannel.name)}</h3>
                  <p style="font-size:13px; color:var(--text-muted);">WebRTC Peer-to-Peer Spatial Voice Channel</p>
                </div>

                <div>
                  ${
                    isInThisVoiceChannel
                      ? `<button class="btn-pill danger" id="leave-voice-btn" style="height:44px; padding:0 24px; font-size:14px;">
                          Disconnect Voice
                        </button>`
                      : `<button class="btn-pill success" id="join-voice-btn" style="height:44px; padding:0 24px; font-size:14px;">
                          Join Voice Channel
                        </button>`
                  }
                </div>
              </div>
            `
              : `
              <!-- Text Channel Messages -->
              <div class="message-stream" id="room-message-stream">
                ${
                  messages.length === 0
                    ? `<div style="margin:auto; text-align:center; color:var(--text-faint);">
                        <p style="font-size:14px; margin-bottom:4px;">🔒 Megolm Group Encryption Active</p>
                        <p style="font-size:12px;">Messages in this room are end-to-end encrypted with Megolm group ratchets.</p>
                      </div>`
                    : messages
                        .map((m) => {
                          const isOwn = m.user_id === config.currentUser?.id;
                          const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                          const avatarUrl = config.getAvatarUrl(m.avatar);
                          const initial = (m.display_name || m.username || '?')[0].toUpperCase();

                          return `
                            <div class="message-bubble-group ${isOwn ? 'own' : ''}">
                              <div class="message-avatar">
                                ${
                                  avatarUrl
                                    ? `<img src="${avatarUrl}" alt="Avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                                       <div class="avatar-fallback" style="display:none;">${initial}</div>`
                                    : `<div class="avatar-fallback">${initial}</div>`
                                }
                              </div>
                              <div class="message-content-wrap">
                                <div class="message-author">
                                  <span>${escapeHtml(m.display_name || m.username || 'User')}</span>
                                  <span class="message-time">${time}</span>
                                </div>
                                <div class="message-bubble">
                                  <p>${escapeHtml(m.body)}</p>
                                </div>
                              </div>
                            </div>
                          `;
                        })
                        .join('')
                }
              </div>

              <!-- Text Channel Composer -->
              <div class="composer-container">
                <div class="composer-box">
                  <textarea class="composer-input" id="room-composer-input" placeholder="Message #${activeChannel ? escapeHtml(activeChannel.name) : 'general'} (Megolm E2EE)..." rows="1"></textarea>
                  <div class="composer-actions">
                    <button class="composer-send-btn" id="room-send-btn" ${isSending ? 'disabled' : ''} title="Send Message">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            `
          }
        </div>

        <!-- Members Drawer -->
        ${
          showMembersDrawer
            ? `
          <div style="width:240px; height:100%; background:var(--bg-surface); border-left:1px solid var(--border-subtle); padding:16px; overflow-y:auto;">
            <div style="font-size:13px; font-weight:600; color:var(--text-faint); margin-bottom:12px; text-transform:uppercase;">
              Room Members (${(activeRoom.members || []).length})
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
              ${(activeRoom.members || [])
                .map((m) => {
                  const avatarUrl = config.getAvatarUrl(m.avatar);
                  const initial = (m.display_name || m.username || '?')[0].toUpperCase();
                  return `
                    <div class="list-item room-member-item" data-username="${m.username}" style="padding:6px 8px;">
                      <div class="item-avatar" style="width:30px; height:30px;">
                        ${
                          avatarUrl
                            ? `<img src="${avatarUrl}" alt="Avatar" />`
                            : `<div class="avatar-fallback" style="font-size:11px;">${initial}</div>`
                        }
                      </div>
                      <div class="item-info">
                        <div class="item-name" style="font-size:12.5px;">${escapeHtml(m.display_name || m.username)}</div>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `
            : ''
        }
      </div>
    `;

    attachEventHandlers();
  };

  const attachEventHandlers = () => {
    const backBtn = container.querySelector('#room-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        container.classList.remove('mobile-active');
        if (onBack) onBack();
      });
    }

    const addChannelBtn = container.querySelector('#add-channel-btn');
    if (addChannelBtn) {
      addChannelBtn.addEventListener('click', () => {
        if (onCreateChannel) onCreateChannel(currentRoomId);
      });
    }

    const toggleMembersBtn = container.querySelector('#toggle-members-drawer-btn');
    if (toggleMembersBtn) {
      toggleMembersBtn.addEventListener('click', () => {
        showMembersDrawer = !showMembersDrawer;
        render();
      });
    }

    // Channel item clicks
    container.querySelectorAll('.channel-item').forEach((item) => {
      item.addEventListener('click', () => {
        const channelId = Number(item.getAttribute('data-channel-id'));
        const found = (activeRoom.channels || []).find((c) => c.id === channelId);
        if (found) {
          activeChannel = found;
          roomStore.set({ activeChannel });
          render();
          if (activeChannel.type === 'text' || !activeChannel.type) {
            loadChannelMessages(activeChannel.id);
          }
        }
      });
    });

    // Voice connect / disconnect
    const joinVoiceBtn = container.querySelector('#join-voice-btn');
    if (joinVoiceBtn) {
      joinVoiceBtn.addEventListener('click', () => {
        if (activeChannel) {
          webrtc.joinVoiceChannel(activeChannel.id);
          render();
        }
      });
    }

    const leaveVoiceBtn = container.querySelector('#leave-voice-btn');
    if (leaveVoiceBtn) {
      leaveVoiceBtn.addEventListener('click', () => {
        webrtc.leaveVoiceChannel();
        render();
      });
    }

    // Member profile clicks
    container.querySelectorAll('.room-member-item').forEach((item) => {
      item.addEventListener('click', () => {
        const username = item.getAttribute('data-username');
        const member = (activeRoom.members || []).find((m) => m.username === username);
        if (member && onOpenProfile) onOpenProfile(member);
      });
    });

    // Text Send
    const sendBtn = container.querySelector('#room-send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', handleSend);
    }

    const input = container.querySelector('#room-composer-input');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
      });
    }
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  render();
  return {
    element: container,
    loadRoom,
  };
}
