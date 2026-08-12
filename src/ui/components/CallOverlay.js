// Introvert Call Overlay & Voice/Video Grid Component

import { callStore } from '../../core/state.js';
import { webrtc } from '../../core/webrtc.js';
import { config } from '../../core/config.js';

export function createCallOverlay() {
  const container = document.createElement('div');
  container.id = 'call-overlay-root';

  let isMinimized = false;

  const render = () => {
    const state = callStore.get();
    if (state.callState === 'idle') {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';

    // Incoming Call Modal
    if (state.callState === 'ringing') {
      container.innerHTML = `
        <div class="incoming-call-modal">
          <div class="call-big-avatar" style="width:52px; height:52px;">
            <div class="avatar-fallback" style="font-size:20px;">
              ${(state.peerDisplayName || state.peerUsername || '?')[0].toUpperCase()}
            </div>
            <span class="presence-dot in-call"></span>
          </div>
          <div>
            <div style="font-size:15px; font-weight:600; color:var(--text-main);">
              ${state.peerDisplayName || state.peerUsername}
            </div>
            <div style="font-size:12px; color:var(--text-muted);">
              Incoming ${state.callType === 'video' ? 'Video' : 'Voice'} Call...
            </div>
          </div>
          <div style="display:flex; gap:8px; margin-left:8px;">
            <button class="call-control-btn danger" id="decline-call-btn" title="Decline">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path>
                <line x1="23" y1="1" x2="1" y2="23"></line>
              </svg>
            </button>
            <button class="call-control-btn" id="answer-voice-btn" style="background:var(--emerald); color:#fff;" title="Answer Voice">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
              </svg>
            </button>
            <button class="call-control-btn" id="answer-video-btn" style="background:var(--accent); color:#fff;" title="Answer with Video">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="23 7 16 12 23 17 23 7"></polygon>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
              </svg>
            </button>
          </div>
        </div>
      `;

      attachIncomingHandlers();
      return;
    }

    // Minimized Floating Widget
    if (isMinimized) {
      container.innerHTML = `
        <div style="position:fixed; bottom:20px; right:20px; background:var(--bg-elevated); border:1px solid var(--border-strong); border-radius:var(--radius-lg); padding:12px 18px; display:flex; align-items:center; gap:12px; box-shadow:var(--shadow-lg); z-index:150;">
          <div style="display:flex; align-items:center; gap:8px; cursor:pointer;" id="maximize-call-btn">
            <span class="presence-dot in-call" style="position:static; width:8px; height:8px;"></span>
            <span style="font-size:13px; font-weight:600; color:var(--text-main);">
              ${state.peerDisplayName || state.peerUsername || 'Voice Channel'}
            </span>
            <span style="font-size:12px; color:var(--emerald); font-family:var(--font-mono);">
              ${state.callDuration}
            </span>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="icon-btn ${state.isMuted ? 'active' : ''}" id="mini-mute-btn" title="Toggle Mute">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                ${state.isMuted
                  ? `<line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>`
                  : `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>`
                }
              </svg>
            </button>
            <button class="icon-btn" id="mini-hangup-btn" style="color:var(--rose);" title="Hang Up">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path>
                <line x1="23" y1="1" x2="1" y2="23"></line>
              </svg>
            </button>
          </div>
        </div>
      `;

      container.querySelector('#maximize-call-btn')?.addEventListener('click', () => {
        isMinimized = false;
        render();
      });
      container.querySelector('#mini-mute-btn')?.addEventListener('click', () => {
        webrtc.toggleMute();
      });
      container.querySelector('#mini-hangup-btn')?.addEventListener('click', () => {
        webrtc.endCall();
      });
      return;
    }

    // Full Call Overlay Stage
    const isGroup = !!state.channelId;
    const participants = isGroup
      ? state.channelMembers
      : state.peerUsername
      ? [{ username: state.peerUsername, displayName: state.peerDisplayName }]
      : [];

    container.innerHTML = `
      <div class="call-overlay">
        <div class="call-header">
          <div class="call-header-info">
            <div class="call-header-name">
              ${state.peerDisplayName || state.peerUsername || 'Room Voice Lounge'}
            </div>
            <div class="call-header-timer">
              ${state.callState === 'calling' ? 'Calling...' : state.callDuration}
            </div>
          </div>
          <button class="icon-btn" id="minimize-call-btn" title="Minimize Call Overlay">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 14h6m0 0v6m0-6L3 21m17-7h-6m0 0v6m0-6l7 7M4 10h6m0 0V4m0 6L3 3m17 7h-6m0 0V4m0 6l7-7"></path>
            </svg>
          </button>
        </div>

        <div class="call-grid">
          ${
            participants.length === 0 && state.callState === 'calling'
              ? `
              <div class="call-tile">
                <div class="call-avatar-stage">
                  <div class="call-big-avatar speaking">
                    <div class="avatar-fallback">${(state.peerUsername || '?')[0].toUpperCase()}</div>
                  </div>
                  <div style="font-size:15px; font-weight:500;">Calling @${state.peerUsername}...</div>
                </div>
              </div>
            `
              : participants
                  .map((p) => {
                    const isSpeaking = p.isSpeaking || state.activeSpeaker === p.username;
                    return `
                      <div class="call-tile" id="tile-${p.username}">
                        <div class="call-avatar-stage">
                          <div class="call-big-avatar ${isSpeaking ? 'speaking' : ''}">
                            <div class="avatar-fallback">${(p.displayName || p.username || '?')[0].toUpperCase()}</div>
                          </div>
                          <div style="font-size:15px; font-weight:500;">${p.displayName || p.username}</div>
                        </div>
                        <div class="call-tile-tag">
                          <span>${p.displayName || p.username}</span>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
          }

          <!-- Local Self Preview Tile -->
          <div class="call-tile" id="tile-local">
            <div class="call-avatar-stage">
              <div class="call-big-avatar ${state.localSpeaking ? 'speaking' : ''}">
                <div class="avatar-fallback">${(config.currentUser?.display_name || 'Y')[0].toUpperCase()}</div>
              </div>
              <div style="font-size:14px; color:var(--text-muted);">You ${state.isMuted ? '(Muted)' : ''}</div>
            </div>
            <div class="call-tile-tag">
              <span>You</span>
            </div>
          </div>
        </div>

        <!-- Call Media Controls -->
        <div class="call-controls">
          <button class="call-control-btn ${state.isMuted ? 'active' : ''}" id="ctrl-mute-btn" title="${state.isMuted ? 'Unmute' : 'Mute'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${state.isMuted
                ? `<line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>`
                : `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>`
              }
            </svg>
          </button>

          <button class="call-control-btn ${state.isDeafened ? 'active' : ''}" id="ctrl-deafen-btn" title="${state.isDeafened ? 'Undeafen' : 'Deafen'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
            </svg>
          </button>

          <button class="call-control-btn ${state.isCameraOn ? 'active' : ''}" id="ctrl-camera-btn" title="Toggle Camera">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="23 7 16 12 23 17 23 7"></polygon>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
            </svg>
          </button>

          <button class="call-control-btn ${state.isScreenSharing ? 'active' : ''}" id="ctrl-screen-btn" title="Share Screen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </button>

          <button class="call-control-btn danger" id="ctrl-end-btn" title="End Call">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path>
              <line x1="23" y1="1" x2="1" y2="23"></line>
            </svg>
          </button>
        </div>
      </div>
    `;

    attachActiveHandlers();
    attachVideoTracks();
  };

  const attachIncomingHandlers = () => {
    container.querySelector('#decline-call-btn')?.addEventListener('click', () => {
      webrtc.declineCall();
    });
    container.querySelector('#answer-voice-btn')?.addEventListener('click', () => {
      webrtc.answerCall(false);
    });
    container.querySelector('#answer-video-btn')?.addEventListener('click', () => {
      webrtc.answerCall(true);
    });
  };

  const attachActiveHandlers = () => {
    container.querySelector('#minimize-call-btn')?.addEventListener('click', () => {
      isMinimized = true;
      render();
    });
    container.querySelector('#ctrl-mute-btn')?.addEventListener('click', () => {
      webrtc.toggleMute();
    });
    container.querySelector('#ctrl-deafen-btn')?.addEventListener('click', () => {
      webrtc.toggleDeafen();
    });
    container.querySelector('#ctrl-camera-btn')?.addEventListener('click', () => {
      webrtc.toggleCamera();
    });
    container.querySelector('#ctrl-screen-btn')?.addEventListener('click', () => {
      webrtc.toggleScreenShare();
    });
    container.querySelector('#ctrl-end-btn')?.addEventListener('click', () => {
      webrtc.endCall();
    });
  };

  const attachVideoTracks = () => {
    // Local video track
    if (webrtc.localStream && webrtc.isCameraOn) {
      const localTile = container.querySelector('#tile-local');
      if (localTile && !localTile.querySelector('video')) {
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = webrtc.localStream;
        localTile.innerHTML = '';
        localTile.appendChild(video);
      }
    }

    // Remote video tracks
    for (const [username, stream] of webrtc.remoteStreams.entries()) {
      if (stream.getVideoTracks().length > 0) {
        const tile = container.querySelector(`#tile-${username}`);
        if (tile && !tile.querySelector('video')) {
          const video = document.createElement('video');
          video.autoplay = true;
          video.playsInline = true;
          video.srcObject = stream;
          tile.innerHTML = '';
          tile.appendChild(video);
        }
      }
    }
  };

  callStore.subscribe(render);
  render();
  return container;
}
