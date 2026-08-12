// Introvert REST API Client for Extrovert

import { config } from './config.js';

class ApiClient {
  async request(path, options = {}) {
    const url = config.getApiUrl(path);
    const headers = options.headers || {};

    if (config.token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${config.token}`;
    }

    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchOptions = {
      method: options.method || 'GET',
      headers,
      body: options.body,
      credentials: 'omit',
    };

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (networkError) {
      throw new Error(`Network error connecting to ${url}: ${networkError.message}`);
    }

    // Handle 401 Token Expiration (attempt refresh once)
    if (response.status === 401 && config.refreshToken && !options._isRetry) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        options._isRetry = true;
        return this.request(path, options);
      }
    }

    let data;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch (e) {
        data = null;
      }
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      const errorMessage =
        (data && (data.detail || data.error_description || data.error || data.title)) ||
        response.statusText ||
        `HTTP ${response.status}`;
      const err = new Error(errorMessage);
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  // --- Authentication ---

  async registerApp(name = 'Introvert Native', redirectUris = ['http://localhost:1420/oauth/callback']) {
    return this.request('/api/v1/oauth/apps', {
      method: 'POST',
      body: JSON.stringify({
        name,
        redirect_uris: redirectUris,
        scopes: 'openid profile read write follow media.write notifications read:direct write:direct',
      }),
    });
  }

  async getCaptchaSvg() {
    const url = config.getApiUrl('/register/captcha');
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load captcha challenge');
    return res.text();
  }

  async register({ username, password, displayName, ref, captcha }) {
    // Extrovert registration endpoint
    const res = await fetch(config.getApiUrl('/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username,
        password,
        displayName: displayName || username,
        ref: ref || '',
        captcha: captcha || '',
      }),
      redirect: 'manual',
    });

    // If redirected or status 200/302, try logging in to obtain tokens
    if (res.status === 302 || res.status === 200 || res.ok) {
      return this.login(username, password);
    }
    const text = await res.text();
    // Check if there's an error message in HTML
    const match = text.match(/class="error"[^>]*>([^<]+)<\/div>/i) || text.match(/error:\s*([^<\n]+)/i);
    const errorMsg = match ? match[1].trim() : 'Registration failed. Please check your details.';
    throw new Error(errorMsg);
  }

  async login(username, password) {
    // We register an OAuth client or use direct token exchange if client exists
    // Extrovert supports OAuth 2.0 PKCE / client token endpoints
    // To provide the smoothest native login experience:
    try {
      // Direct session login + OAuth app registration or credentials verification
      const loginRes = await fetch(config.getApiUrl('/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }),
        redirect: 'manual',
      });

      // Extract connect.sid cookie if present or check redirected session
      const setCookie = loginRes.headers.get('set-cookie');
      let sid = null;
      if (setCookie) {
        const m = setCookie.match(/connect\.sid=([^;]+)/);
        if (m) sid = decodeURIComponent(m[1]);
      }

      // Now create or obtain OAuth app token for native client
      // Let's create an app and authorize
      const appsRes = await fetch(config.getApiUrl('/api/v1/oauth/apps'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sid ? { Cookie: `connect.sid=${encodeURIComponent(sid)}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          name: 'Introvert Client',
          redirect_uris: ['http://localhost:1420/oauth/callback'],
          scopes: 'openid profile read write follow media.write notifications read:direct write:direct',
        }),
      });

      let clientId, clientSecret;
      if (appsRes.ok) {
        const appData = await appsRes.json();
        clientId = appData.data.client_id;
        clientSecret = appData.data.client_secret;
      }

      // Generate code_verifier and code_challenge for PKCE
      const verifier = this.generateRandomString(64);
      const challenge = await this.sha256Base64Url(verifier);

      // Submit authorization request
      const authRes = await fetch(config.getApiUrl('/api/v1/oauth/authorize'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(sid ? { Cookie: `connect.sid=${encodeURIComponent(sid)}` } : {}),
        },
        credentials: 'include',
        body: new URLSearchParams({
          client_id: clientId || 'introvert_client',
          redirect_uri: 'http://localhost:1420/oauth/callback',
          response_type: 'code',
          scope: 'openid profile read write follow media.write notifications read:direct write:direct',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          approve: 'yes',
        }),
        redirect: 'manual',
      });

      let code = null;
      const location = authRes.headers.get('location') || '';
      if (location) {
        const urlObj = new URL(location, 'http://localhost:1420');
        code = urlObj.searchParams.get('code');
      }

      if (code && clientId) {
        // Exchange code for token
        const tokenRes = await fetch(config.getApiUrl('/api/v1/oauth/token'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code,
            code_verifier: verifier,
            redirect_uri: 'http://localhost:1420/oauth/callback',
          }),
        });

        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          const accessToken = tokenData.access_token;
          const refreshToken = tokenData.refresh_token;

          // Fetch user credentials
          const meRes = await fetch(config.getApiUrl('/api/v1/accounts/verify_credentials'), {
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          if (meRes.ok) {
            const meData = await meRes.json();
            const user = meData.data;
            await config.setAuth(accessToken, refreshToken, user);
            return { user, accessToken, refreshToken };
          }
        }
      }

      // Fallback: If OAuth exchange had an issue, verify credentials with session or fallback token
      const meDirect = await this.verifyCredentials();
      return { user: meDirect, accessToken: config.token };
    } catch (err) {
      console.error('Login process error', err);
      throw new Error(`Login failed: ${err.message}`);
    }
  }

  async refreshAccessToken() {
    if (!config.refreshToken) return false;
    try {
      const res = await fetch(config.getApiUrl('/api/v1/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: config.refreshToken,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        await config.setAuth(data.access_token, data.refresh_token || config.refreshToken, config.currentUser);
        return true;
      }
    } catch (e) {
      console.warn('Token refresh failed', e);
    }
    return false;
  }

  async revokeToken(token) {
    try {
      await this.request('/api/v1/oauth/revoke', {
        method: 'POST',
        body: JSON.stringify({ token: token || config.token }),
      });
    } catch (e) {}
  }

  // --- Accounts & Minimal Profiles ---

  async verifyCredentials() {
    const res = await this.request('/api/v1/accounts/verify_credentials');
    const user = res.data;
    if (user && config.currentUser && config.currentUser.id === user.id) {
      await config.setAuth(config.token, config.refreshToken, user);
    }
    return user;
  }

  async getAccount(id) {
    const res = await this.request(`/api/v1/accounts/${encodeURIComponent(id)}`);
    return res.data;
  }

  async updateCredentials({ display_name, bio, theme }) {
    const body = {};
    if (display_name !== undefined) body.display_name = display_name;
    if (bio !== undefined) body.bio = bio;
    if (theme !== undefined) body.theme = theme;

    const res = await this.request('/api/v1/accounts/update_credentials', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const updated = res.data;
    await config.setAuth(config.token, config.refreshToken, updated);
    return updated;
  }

  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await this.request('/api/v1/accounts/avatar', {
      method: 'POST',
      body: formData,
    });
    return res.data;
  }

  async getRelationships(ids) {
    if (!ids || ids.length === 0) return [];
    const idParam = Array.isArray(ids) ? ids.join(',') : ids;
    const res = await this.request(`/api/v1/accounts/relationships?id=${encodeURIComponent(idParam)}`);
    return res.data || [];
  }

  async follow(id) {
    const res = await this.request(`/api/v1/accounts/${encodeURIComponent(id)}/follow`, {
      method: 'POST',
    });
    return res.data;
  }

  async unfollow(id) {
    const res = await this.request(`/api/v1/accounts/${encodeURIComponent(id)}/unfollow`, {
      method: 'POST',
    });
    return res.data;
  }

  async searchAccounts(query) {
    if (!query || !query.trim()) return [];
    const res = await this.request(`/api/v1/search?q=${encodeURIComponent(query.trim())}&type=accounts&limit=20`);
    return res.data ? res.data.accounts || [] : [];
  }

  // --- Direct Messages (E2EE) ---

  async getConversations() {
    const res = await this.request('/api/v1/conversations');
    return res.data || [];
  }

  async getConversationHistory(username, cursor = null, limit = 50) {
    let path = `/api/v1/conversations/${encodeURIComponent(username)}?limit=${limit}`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    const res = await this.request(path);
    return {
      messages: res.data || [],
      pagination: res.pagination || null,
    };
  }

  async sendDirectMessage(username, payload) {
    const res = await this.request(`/api/v1/conversations/${encodeURIComponent(username)}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.data;
  }

  async getPeerBundle(username) {
    const res = await this.request(`/api/v1/conversations/${encodeURIComponent(username)}/bundle`);
    return res.data;
  }

  async getSafetyKeys(username) {
    const res = await this.request(`/api/v1/conversations/${encodeURIComponent(username)}/safety`);
    return res.data;
  }

  async publishPrekeys(bundle) {
    const res = await this.request('/api/v1/conversations/prekeys', {
      method: 'POST',
      body: JSON.stringify(bundle),
    });
    return res.data;
  }

  async getPrekeysCount() {
    const res = await this.request('/api/v1/conversations/prekeys/count');
    return res.data;
  }

  async getPrekeysBackup() {
    const res = await this.request('/api/v1/conversations/prekeys/backup');
    return res.data;
  }

  async toggleAdditionalSecurity(username, enabled) {
    const res = await this.request(`/api/v1/conversations/${encodeURIComponent(username)}/security`, {
      method: 'POST',
      body: JSON.stringify({ enabled: !!enabled }),
    });
    return res.data;
  }

  async ackReceivedMessages(username, messageIds) {
    if (!messageIds || messageIds.length === 0) return;
    try {
      await this.request(`/api/v1/conversations/${encodeURIComponent(username)}/received`, {
        method: 'POST',
        body: JSON.stringify({ message_ids: messageIds }),
      });
    } catch (e) {
      console.warn('Ack received messages failed', e);
    }
  }

  async editMessage(id, body) {
    const res = await this.request(`/api/v1/messages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    return res.data;
  }

  async deleteMessage(id) {
    const res = await this.request(`/api/v1/messages/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.data;
  }

  // --- Rooms & Channels ---

  async getRooms() {
    const res = await this.request('/api/v1/rooms');
    return res.data || [];
  }

  async getRoomDetails(id) {
    const res = await this.request(`/api/v1/rooms/${encodeURIComponent(id)}`);
    return res.data;
  }

  async createRoom({ name, description = '', is_public = true }) {
    // Uses form route /rooms/create or API
    const res = await fetch(config.getApiUrl('/rooms/create'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: new URLSearchParams({
        name,
        description,
        is_public: is_public ? '1' : '0',
      }),
      redirect: 'manual',
    });
    return res.ok || res.status === 302;
  }

  async joinRoom(roomId) {
    const res = await fetch(config.getApiUrl(`/rooms/${roomId}/join`), {
      method: 'POST',
      headers: {
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    });
    return res.ok;
  }

  async leaveRoom(roomId) {
    const res = await fetch(config.getApiUrl(`/rooms/${roomId}/leave`), {
      method: 'POST',
      headers: {
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    });
    return res.ok;
  }

  async createChannel(roomId, { name, type = 'text', view_role_ids = null, write_role_ids = null }) {
    const res = await fetch(config.getApiUrl(`/rooms/${roomId}/channels/create`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: new URLSearchParams({
        name,
        type,
        ...(view_role_ids ? { view_role_ids: JSON.stringify(view_role_ids) } : {}),
        ...(write_role_ids ? { write_role_ids: JSON.stringify(write_role_ids) } : {}),
      }),
    });
    return res.ok;
  }

  async deleteChannel(roomId, channelId) {
    const res = await fetch(config.getApiUrl(`/rooms/${roomId}/channels/${channelId}/delete`), {
      method: 'POST',
      headers: {
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    });
    return res.ok;
  }

  async getChannelMessages(roomId, channelId, cursor = null) {
    let path = `/api/v1/rooms/${roomId}/channels/${channelId}/messages`;
    if (cursor) path += `?cursor=${encodeURIComponent(cursor)}`;
    const res = await this.request(path);
    return res.data || [];
  }

  async sendChannelMessage(roomId, channelId, { body, proto = 'megolm', group_session_id }) {
    const res = await this.request(`/api/v1/rooms/${roomId}/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        proto,
        group_session_id,
      }),
    });
    return res.data;
  }

  async publishRoomSession(roomId, { keys, member_ids, rotate = false }) {
    const res = await this.request(`/api/v1/rooms/${roomId}/session`, {
      method: 'POST',
      body: JSON.stringify({
        keys,
        member_ids,
        rotate: !!rotate,
      }),
    });
    return res.data;
  }

  async getPendingRoomKeys(roomId) {
    const res = await this.request(`/api/v1/rooms/${roomId}/session/keys`);
    return res.data ? res.data.keys || [] : [];
  }

  async ackDeliveredRoomKeys(roomId, keyIds) {
    if (!keyIds || keyIds.length === 0) return;
    try {
      await this.request(`/api/v1/rooms/${roomId}/session/keys/delivered`, {
        method: 'POST',
        body: JSON.stringify({ key_ids: keyIds }),
      });
    } catch (e) {}
  }

  async getRoomSessionStatus(roomId) {
    const res = await this.request(`/api/v1/rooms/${roomId}/session/status`);
    return res.data;
  }

  async getRoomMemberBundle(roomId, username) {
    const res = await this.request(`/api/v1/rooms/${roomId}/bundle/${encodeURIComponent(username)}`);
    return res.data;
  }

  // --- Media Uploads ---

  async uploadMedia(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await this.request('/api/v1/media', {
      method: 'POST',
      body: formData,
    });
    return res.data;
  }

  // --- Presence & Calls ---

  async getPresence() {
    const res = await this.request('/api/v1/calls/presence');
    return res.data || [];
  }

  async getUserPresence(username) {
    const res = await this.request(`/api/v1/calls/presence/${encodeURIComponent(username)}`);
    return res.data;
  }

  // --- Notifications ---

  async getUnreadCount() {
    const res = await this.request('/api/v1/notifications/unread_count');
    return res.data ? res.data.count : 0;
  }

  async getNotifications(limit = 30, cursor = null) {
    let path = `/api/v1/notifications?limit=${limit}`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    const res = await this.request(path);
    return {
      notifications: res.data || [],
      pagination: res.pagination || null,
    };
  }

  async clearNotifications() {
    const res = await this.request('/api/v1/notifications/clear', { method: 'POST' });
    return res.data;
  }

  // --- Utility Functions ---

  generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
      result += chars[randomValues[i] % chars.length];
    }
    return result;
  }

  async sha256Base64Url(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hash));
    const base64 = btoa(String.fromCharCode.apply(null, hashArray));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}

export const api = new ApiClient();
