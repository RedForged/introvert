import { authStore, showToast } from '../../core/state.js';
import { config } from '../../core/config.js';
import { cryptoEngine } from '../../core/crypto.js';
import { signaling } from '../../core/signaling.js';
import { createRestoreBackupModal } from './RestoreBackupModal.js';

export function createSettingsModal({ onClose, onAddAccount, onLogout }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'settings-modal-root';

  let currentTab = 'account'; // 'account' | 'voice' | 'crypto' | 'appearance' | 'connection'

  let appVersion = '…';
  let devId = '…';
  let resetArmed = false;

  (async () => {
    try {
      if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
        const { invoke } = await import('@tauri-apps/api/core');
        const info = await invoke('get_platform_info');
        if (info && info.version) appVersion = info.version;
      }
    } catch (e) {}
    try {
      devId = await cryptoEngine.getOrCreateDeviceId();
    } catch (e) {}
    render();
  })();

  let audioInputs = [];
  let audioOutputs = [];
  let videoInputs = [];
  let testStream = null;
  let testAudioContext = null;
  let testAnalyser = null;
  let testAnimFrame = null;

  const enumerateDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputs = devices.filter((d) => d.kind === 'audioinput');
      audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
      videoInputs = devices.filter((d) => d.kind === 'videoinput');
      render();
    } catch (e) {
      console.warn('Enumerate devices failed', e);
    }
  };

  const startMicTest = async () => {
    try {
      stopMicTest();
      testStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: config.audioInputId !== 'default' ? { exact: config.audioInputId } : undefined },
        video: false,
      });
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        testAudioContext = new AudioCtx();
        const source = testAudioContext.createMediaStreamSource(testStream);
        testAnalyser = testAudioContext.createAnalyser();
        testAnalyser.fftSize = 256;
        source.connect(testAnalyser);

        const meter = overlay.querySelector('#mic-meter-fill');
        const dataArray = new Uint8Array(128);

        const update = () => {
          if (!testAnalyser || !meter) return;
          testAnalyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          const pct = Math.min(100, Math.round((avg / 60) * 100));
          meter.style.width = `${pct}%`;
          testAnimFrame = requestAnimationFrame(update);
        };
        update();
      }
    } catch (e) {
      console.warn('Mic test error', e);
    }
  };

  const stopMicTest = () => {
    if (testAnimFrame) {
      cancelAnimationFrame(testAnimFrame);
      testAnimFrame = null;
    }
    if (testStream) {
      testStream.getTracks().forEach((t) => t.stop());
      testStream = null;
    }
    if (testAudioContext) {
      testAudioContext.close();
      testAudioContext = null;
    }
  };

  const render = () => {
    const auth = authStore.get();
    const user = auth.user;
    const accounts = config.accounts || [];

    const myIdKeys = cryptoEngine.myIdKeys || { curve25519: 'Generating...', ed25519: 'Generating...' };

    overlay.innerHTML = `
      <div class="modal-card" style="max-width:540px; height:80vh;">
        <div class="modal-header">
          <span class="modal-title">Settings</span>
          <button class="icon-btn" id="close-settings-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div style="display:flex; flex:1; overflow:hidden;">
          <!-- Settings Navigation Sidebar -->
          <div style="width:160px; background:var(--bg-canvas); border-right:1px solid var(--border-subtle); padding:12px 6px; display:flex; flex-direction:column; gap:4px;">
            <button class="channel-item ${currentTab === 'account' ? 'active' : ''}" data-settings-tab="account">Account</button>
            <button class="channel-item ${currentTab === 'voice' ? 'active' : ''}" data-settings-tab="voice">Voice & Video</button>
            <button class="channel-item ${currentTab === 'crypto' ? 'active' : ''}" data-settings-tab="crypto">E2EE Keys</button>
            <button class="channel-item ${currentTab === 'appearance' ? 'active' : ''}" data-settings-tab="appearance">Appearance</button>
            <button class="channel-item ${currentTab === 'connection' ? 'active' : ''}" data-settings-tab="connection">Connection</button>
          </div>

          <!-- Settings Tab Body -->
          <div class="modal-body" style="flex:1; padding:20px;">
            ${
              currentTab === 'account'
                ? `
              <h3 style="font-size:15px; font-weight:600; margin-bottom:12px;">Active Account</h3>
              <div style="display:flex; align-items:center; gap:12px; padding:12px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-md); margin-bottom:16px;">
                <div class="item-avatar">
                  ${
                    user?.avatar
                      ? `<img src="${config.getAvatarUrl(user.avatar)}" alt="Avatar" />`
                      : `<div class="avatar-fallback">${(user?.display_name || user?.username || '?')[0].toUpperCase()}</div>`
                  }
                </div>
                <div>
                  <div style="font-size:14px; font-weight:600;">${escapeHtml(user?.display_name || user?.username)}</div>
                  <div style="font-size:12px; color:var(--text-muted);">@${escapeHtml(user?.username)} • ${config.serverUrl}</div>
                </div>
              </div>

              <h4 style="font-size:13px; font-weight:600; color:var(--text-faint); margin-bottom:8px; text-transform:uppercase;">Configured Accounts</h4>
              <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:16px;">
                ${accounts
                  .map(
                    (a) => `
                  <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                    <span style="font-size:13px;">@${escapeHtml(a.username)} (${escapeHtml(a.serverUrl)})</span>
                    ${
                      String(a.id) === String(user?.id)
                        ? '<span style="font-size:11px; color:var(--emerald);">Active</span>'
                        : `<button class="btn-pill switch-acc-btn" data-user-id="${a.id}" style="height:26px; padding:0 8px; font-size:11px;">Switch</button>`
                    }
                  </div>
                `
                  )
                  .join('')}
              </div>

              <div style="display:flex; gap:10px;">
                <button class="btn-pill" id="add-another-acc-btn">Add Another Account</button>
                <button class="btn-pill danger" id="logout-btn">Log Out</button>
              </div>
            `
                : currentTab === 'voice'
                ? `
              <h3 style="font-size:15px; font-weight:600; margin-bottom:12px;">Voice & Video Hardware</h3>

              <div class="form-group">
                <label class="form-label">Input Device (Microphone)</label>
                <select class="form-input" id="audio-input-select">
                  <option value="default">Default Microphone</option>
                  ${audioInputs.map((d) => `<option value="${d.deviceId}" ${config.audioInputId === d.deviceId ? 'selected' : ''}>${d.label || `Microphone (${d.deviceId.slice(0, 5)})`}</option>`).join('')}
                </select>
              </div>

              <div class="form-group" style="margin-top:6px;">
                <label class="form-label">Microphone Test</label>
                <div style="width:100%; height:12px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-full); overflow:hidden;">
                  <div id="mic-meter-fill" style="width:0%; height:100%; background:var(--emerald); transition:width 0.08s ease;"></div>
                </div>
              </div>

              <div class="form-group" style="margin-top:10px;">
                <label class="form-label">Output Device (Speakers / Headphones)</label>
                <select class="form-input" id="audio-output-select">
                  <option value="default">Default Speakers</option>
                  ${audioOutputs.map((d) => `<option value="${d.deviceId}" ${config.audioOutputId === d.deviceId ? 'selected' : ''}>${d.label || `Speaker (${d.deviceId.slice(0, 5)})`}</option>`).join('')}
                </select>
              </div>

              <div class="form-group" style="margin-top:10px;">
                <label class="form-label">Camera Device</label>
                <select class="form-input" id="video-input-select">
                  <option value="default">Default Camera</option>
                  ${videoInputs.map((d) => `<option value="${d.deviceId}" ${config.videoInputId === d.deviceId ? 'selected' : ''}>${d.label || `Camera (${d.deviceId.slice(0, 5)})`}</option>`).join('')}
                </select>
              </div>
            `
                : currentTab === 'crypto'
                ? `
              <h3 style="font-size:15px; font-weight:600; margin-bottom:12px;">End-to-End Encryption Keys</h3>

              <div class="form-group">
                <label class="form-label">App &amp; Device</label>
                <input type="text" class="form-input" value="Introvert ${appVersion} · ${devId}" readonly style="font-family:var(--font-mono); font-size:11px;" />
              </div>

              <div class="form-group" style="margin-top:10px;">
                <label class="form-label">Curve25519 Identity Key (Double-Ratchet)</label>
                <input type="text" class="form-input" value="${myIdKeys.curve25519}" readonly style="font-family:var(--font-mono); font-size:11px;" />
              </div>

              <div class="form-group" style="margin-top:10px;">
                <label class="form-label">Ed25519 Fingerprint Key (Safety Verification)</label>
                <input type="text" class="form-input" value="${myIdKeys.ed25519}" readonly style="font-family:var(--font-mono); font-size:11px;" />
              </div>

              <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn-pill primary" id="replenish-prekeys-btn">Replenish Prekeys</button>
                <button class="btn-pill" id="settings-restore-backup-btn">Restore Backup with Password</button>
              </div>

              <div style="margin-top:14px; padding:12px; background:var(--bg-glass); border:1px solid var(--border); border-radius:var(--radius-sm);">
                <span style="font-size:12px; font-weight:600; color:var(--text-main); display:block; margin-bottom:4px;">Repair Encryption</span>
                <p style="font-size:11.5px; color:var(--text-muted); line-height:1.4; margin:0 0 10px;">
                  If messages from this device can't be decrypted anywhere, reset its keys: the app re-registers this device with fresh keys and every other client re-keys to it automatically.
                </p>
                <button class="btn-pill" id="reset-e2ee-btn" style="border-color:var(--rose); color:var(--rose);">Reset &amp; Re-register Keys</button>
              </div>
            `
                : currentTab === 'appearance'
                ? `
              <h3 style="font-size:15px; font-weight:600; margin-bottom:12px;">Theme & Appearance</h3>
              <div style="display:flex; flex-direction:column; gap:8px;">
                <button class="btn-pill ${config.theme === 'obsidian' ? 'primary' : ''} theme-btn" data-theme-val="obsidian" style="justify-content:space-between; height:40px;">
                  <span>Obsidian (Dark Modern)</span>
                  ${config.theme === 'obsidian' ? '✓' : ''}
                </button>
                <button class="btn-pill ${config.theme === 'emerald' ? 'primary' : ''} theme-btn" data-theme-val="emerald" style="justify-content:space-between; height:40px;">
                  <span>Cyber Emerald</span>
                  ${config.theme === 'emerald' ? '✓' : ''}
                </button>
                <button class="btn-pill ${config.theme === 'indigo' ? 'primary' : ''} theme-btn" data-theme-val="indigo" style="justify-content:space-between; height:40px;">
                  <span>Electric Indigo</span>
                  ${config.theme === 'indigo' ? '✓' : ''}
                </button>
                <button class="btn-pill ${config.theme === 'oled' ? 'primary' : ''} theme-btn" data-theme-val="oled" style="justify-content:space-between; height:40px;">
                  <span>OLED Pitch Black</span>
                  ${config.theme === 'oled' ? '✓' : ''}
                </button>
                <button class="btn-pill ${config.theme === 'light' ? 'primary' : ''} theme-btn" data-theme-val="light" style="justify-content:space-between; height:40px;">
                  <span>Clean Light</span>
                  ${config.theme === 'light' ? '✓' : ''}
                </button>
              </div>
            `
                : `
              <h3 style="font-size:15px; font-weight:600; margin-bottom:12px;">Server Connection</h3>
              <div class="form-group">
                <label class="form-label">Instance Base URL</label>
                <input type="text" class="form-input" value="${config.serverUrl}" readonly />
              </div>
              <div class="form-group" style="margin-top:10px;">
                <label class="form-label">WebSocket Status</label>
                <div style="font-size:13px; color:${signaling.isConnected ? 'var(--emerald)' : 'var(--rose)'};">
                  ${signaling.isConnected ? '🟢 Connected to /ws signaling channel' : '🔴 Disconnected'}
                </div>
              </div>
            `
            }
          </div>
        </div>
      </div>
    `;

    attachHandlers();
  };

  const attachHandlers = () => {
    overlay.querySelector('#close-settings-btn')?.addEventListener('click', () => {
      stopMicTest();
      overlay.remove();
      if (onClose) onClose();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        stopMicTest();
        overlay.remove();
        if (onClose) onClose();
      }
    });

    overlay.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentTab = btn.getAttribute('data-settings-tab');
        stopMicTest();
        render();
        if (currentTab === 'voice') {
          enumerateDevices();
          startMicTest();
        }
      });
    });

    // Account tab actions
    overlay.querySelectorAll('.switch-acc-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = Number(btn.getAttribute('data-user-id'));
        await config.switchAccount(uid);
        window.location.reload();
      });
    });

    overlay.querySelector('#add-another-acc-btn')?.addEventListener('click', () => {
      overlay.remove();
      if (onAddAccount) onAddAccount();
    });

    overlay.querySelector('#logout-btn')?.addEventListener('click', async () => {
      await config.logout();
      overlay.remove();
      if (onLogout) onLogout();
      window.location.reload();
    });

    // Voice tab device selection
    overlay.querySelector('#audio-input-select')?.addEventListener('change', async (e) => {
      await config.setMediaDevices({ audioInput: e.target.value });
      startMicTest();
    });

    overlay.querySelector('#audio-output-select')?.addEventListener('change', async (e) => {
      await config.setMediaDevices({ audioOutput: e.target.value });
    });

    overlay.querySelector('#video-input-select')?.addEventListener('change', async (e) => {
      await config.setMediaDevices({ videoInput: e.target.value });
    });

    // E2EE Prekeys replenish
    overlay.querySelector('#replenish-prekeys-btn')?.addEventListener('click', async () => {
      try {
        await cryptoEngine.publishPrekeys();
        showToast('success', 'Published 5 new one-time prekeys!');
      } catch (err) {
        showToast('danger', 'Replenish failed', err.message);
      }
    });

    // E2EE Restore backup
    overlay.querySelector('#settings-restore-backup-btn')?.addEventListener('click', () => {
      createRestoreBackupModal({
        onSuccess: () => {
          render();
        },
      });
    });

    // E2EE Reset & re-register (two-click confirm — no native dialogs in webviews)
    overlay.querySelector('#reset-e2ee-btn')?.addEventListener('click', async () => {
      const btn = overlay.querySelector('#reset-e2ee-btn');
      if (!resetArmed) {
        resetArmed = true;
        if (btn) btn.textContent = 'Click again to confirm reset';
        setTimeout(() => {
          resetArmed = false;
          if (btn) btn.textContent = 'Reset & Re-register Keys';
        }, 4000);
        return;
      }
      resetArmed = false;
      try {
        await cryptoEngine.resetCryptoState();
        await cryptoEngine.ensureReady();
        showToast('success', 'Keys reset — device re-registered with fresh keys.');
        window.location.reload();
      } catch (err) {
        showToast('danger', 'Reset failed', err.message);
      }
    });

    // Appearance Theme switcher
    overlay.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const themeVal = btn.getAttribute('data-theme-val');
        await config.setTheme(themeVal);
        render();
      });
    });
  };

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  render();
  document.body.appendChild(overlay);
  return overlay;
}
