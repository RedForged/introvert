// Introvert Client Configuration & Storage Bridge

let isTauri = false;
let tauriInvoke = null;

try {
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
    // Dynamic import will work in browser/vite
    import('@tauri-apps/api/core').then((module) => {
      tauriInvoke = module.invoke;
      isTauri = true;
    }).catch(() => {});
  }
} catch (e) {}

export const storage = {
  async get(key) {
    if (isTauri && tauriInvoke) {
      try {
        const val = await tauriInvoke('storage_get', { key });
        if (val !== null && val !== undefined) return val;
      } catch (err) {
        console.warn('Tauri storage_get failed, falling back to localStorage', err);
      }
    }
    return localStorage.getItem(`introvert_${key}`);
  },

  async set(key, value) {
    if (isTauri && tauriInvoke) {
      try {
        await tauriInvoke('storage_set', { key, value: String(value) });
      } catch (err) {
        console.warn('Tauri storage_set failed', err);
      }
    }
    localStorage.setItem(`introvert_${key}`, String(value));
  },

  async delete(key) {
    if (isTauri && tauriInvoke) {
      try {
        await tauriInvoke('storage_delete', { key });
      } catch (err) {}
    }
    localStorage.removeItem(`introvert_${key}`);
  }
};

export const OFFICIAL_SERVER_URL = 'https://extrovert.redforged.eu';
export const OFFICIAL_CLIENT_ID = '3c0e179a6f941af86522d944d45ae190ee17aa618041b051';
const DEFAULT_SERVER_URL = OFFICIAL_SERVER_URL;

class ConfigManager {
  constructor() {
    this.serverUrl = DEFAULT_SERVER_URL;
    this.token = null;
    this.refreshToken = null;
    this.currentUser = null;
    this.accounts = [];
    this.theme = 'obsidian';
    this.audioInputId = 'default';
    this.audioOutputId = 'default';
    this.videoInputId = 'default';
    this.listeners = new Set();
  }

  async init() {
    const savedServer = await storage.get('server_url');
    if (savedServer) this.serverUrl = savedServer.replace(/\/+$/, '');

    const savedToken = await storage.get('access_token');
    if (savedToken) this.token = savedToken;

    const savedRefresh = await storage.get('refresh_token');
    if (savedRefresh) this.refreshToken = savedRefresh;

    const savedUser = await storage.get('current_user');
    if (savedUser) {
      try {
        this.currentUser = JSON.parse(savedUser);
      } catch (e) {}
    }

    const savedAccounts = await storage.get('accounts');
    if (savedAccounts) {
      try {
        this.accounts = JSON.parse(savedAccounts);
      } catch (e) {}
    }

    const savedTheme = await storage.get('theme');
    if (savedTheme) this.theme = savedTheme;

    const savedAudioIn = await storage.get('audio_input');
    if (savedAudioIn) this.audioInputId = savedAudioIn;

    const savedAudioOut = await storage.get('audio_output');
    if (savedAudioOut) this.audioOutputId = savedAudioOut;

    const savedVideoIn = await storage.get('video_input');
    if (savedVideoIn) this.videoInputId = savedVideoIn;

    this.notify();
    return this;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try { listener(this); } catch (e) { console.error('Config listener error', e); }
    }
  }

  async setServerUrl(url) {
    this.serverUrl = (url || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
    await storage.set('server_url', this.serverUrl);
    this.notify();
  }

  async setAuth(token, refreshToken, user) {
    this.token = token;
    this.refreshToken = refreshToken || null;
    this.currentUser = user;

    if (token) await storage.set('access_token', token);
    else await storage.delete('access_token');

    if (refreshToken) await storage.set('refresh_token', refreshToken);
    else await storage.delete('refresh_token');

    if (user) {
      await storage.set('current_user', JSON.stringify(user));
      // Update accounts list
      const idx = this.accounts.findIndex(a => a.id === user.id);
      const accRecord = {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar: user.avatar,
        serverUrl: this.serverUrl,
        token: token,
        refreshToken: refreshToken
      };
      if (idx >= 0) this.accounts[idx] = accRecord;
      else this.accounts.push(accRecord);
      await storage.set('accounts', JSON.stringify(this.accounts));
    } else {
      await storage.delete('current_user');
    }
    this.notify();
  }

  async switchAccount(userId) {
    const acc = this.accounts.find(a => a.id === userId);
    if (!acc) return false;
    await this.setServerUrl(acc.serverUrl);
    await this.setAuth(acc.token, acc.refreshToken, {
      id: acc.id,
      username: acc.username,
      display_name: acc.display_name,
      avatar: acc.avatar
    });
    return true;
  }

  async logout() {
    if (this.currentUser) {
      this.accounts = this.accounts.filter(a => a.id !== this.currentUser.id);
      await storage.set('accounts', JSON.stringify(this.accounts));
    }
    await this.setAuth(null, null, null);
  }

  async setTheme(theme) {
    this.theme = theme;
    await storage.set('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    try {
      if (window.AndroidBridge?.updateTheme) {
        window.AndroidBridge.updateTheme(theme === 'light');
      }
    } catch (e) {}
    this.notify();
  }

  async setMediaDevices({ audioInput, audioOutput, videoInput }) {
    if (audioInput !== undefined) {
      this.audioInputId = audioInput;
      await storage.set('audio_input', audioInput);
    }
    if (audioOutput !== undefined) {
      this.audioOutputId = audioOutput;
      await storage.set('audio_output', audioOutput);
    }
    if (videoInput !== undefined) {
      this.videoInputId = videoInput;
      await storage.set('video_input', videoInput);
    }
    this.notify();
  }

  getWsUrl() {
    let base = this.serverUrl;
    let wsProto = base.startsWith('https:') ? 'wss:' : 'ws:';
    let host = base.replace(/^https?:\/\//, '');
    let url = `${wsProto}//${host}/ws`;
    if (this.token) {
      url += `?token=${encodeURIComponent(this.token)}`;
    }
    return url;
  }

  getApiUrl(path) {
    return `${this.serverUrl}${path.startsWith('/') ? path : '/' + path}`;
  }

  getAvatarUrl(avatarPath) {
    if (!avatarPath) return null;
    if (avatarPath.startsWith('http://') || avatarPath.startsWith('https://')) return avatarPath;
    const cleanPath = avatarPath.startsWith('/') ? avatarPath : `/${avatarPath}`;
    return `${this.serverUrl}${cleanPath}`;
  }
}

export const config = new ConfigManager();
