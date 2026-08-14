// Introvert Realtime WebSocket Signaling Client for Extrovert (/ws)

import { config } from './config.js';

class SignalingClient {
  constructor() {
    this.ws = null;
    this.reconnectTimeout = null;
    this.reconnectAttempts = 0;
    this.pingInterval = null;
    this.isConnected = false;
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(handler);
    }
  }

  emit(event, ...args) {
    if (this.listeners.has(event)) {
      for (const handler of this.listeners.get(event)) {
        try {
          handler(...args);
        } catch (err) {
          console.error(`Signaling event listener error [${event}]`, err);
        }
      }
    }
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = config.getWsUrl();
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.warn('Signaling WebSocket instantiation failed', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.send({ type: 'ping' });
      this.send({ type: 'register_dm' });
      this.emit('connected');
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      this.handleMessage(msg);
    };

    this.ws.onclose = (event) => {
      this.isConnected = false;
      this.stopHeartbeat();
      this.emit('disconnected', event.code, event.reason);
      if (event.code !== 4001) {
        // If not explicit auth failure, reconnect
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      this.emit('error', err);
    };
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 15000);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.isConnected) {
        this.send({ type: 'ping' });
      }
    }, 25000);
  }

  stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
        return true;
      } catch (err) {
        console.warn('Signaling send failed', err);
      }
    }
    return false;
  }

  handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'pong':
        this.emit('pong');
        break;

      case 'user_online':
        this.emit('presence', { username: msg.username, display_name: msg.display_name, online: true });
        break;

      case 'user_offline':
        this.emit('presence', { username: msg.username, display_name: msg.display_name, online: false });
        break;

      case 'new_dm':
        this.emit('new_dm', {
          message: msg.message,
          sender_curve: msg.sender_curve,
          from_username: msg.from_username,
          from_display: msg.from_display,
          to_username: msg.to_username,
        });
        break;

      case 'delete_dm':
        this.emit('delete_dm', {
          message_id: msg.message_id,
          from_username: msg.from_username,
        });
        break;

      case 'incoming_call':
        this.emit('incoming_call', {
          from: msg.from,
          from_display: msg.from_display || msg.from,
          sdp: msg.sdp,
          channel_id: msg.channel_id || null,
        });
        break;

      case 'callee_available':
        this.emit('callee_available', { to: msg.to });
        break;

      case 'user_busy':
        this.emit('user_busy', { from: msg.from, to: msg.to });
        break;

      case 'calling_offline':
        this.emit('calling_offline', { to: msg.to, expires_at: msg.expires_at });
        break;

      case 'user_offline':
        this.emit('user_offline', { from: msg.from, to: msg.to });
        break;

      case 'callee_ringing':
        this.emit('callee_ringing', { to: msg.to });
        break;

      case 'call_answered':
        this.emit('call_answered', {
          from: msg.from,
          from_display: msg.from_display,
          sdp: msg.sdp,
          channel_id: msg.channel_id || null,
        });
        break;

      case 'ice_candidate':
        this.emit('ice_candidate', {
          from: msg.from,
          candidate: msg.candidate,
          channel_id: msg.channel_id || null,
        });
        break;

      case 'call_ended':
        this.emit('call_ended', { from: msg.from, channel_id: msg.channel_id || null });
        break;

      case 'call_declined':
        this.emit('call_declined', { from: msg.from, channel_id: msg.channel_id || null });
        break;

      case 'call_unanswered':
        this.emit('call_unanswered', { from: msg.from, to: msg.to });
        break;

      case 'channel_joined':
        this.emit('channel_joined', {
          channel_id: msg.channel_id,
          self: msg.self,
          members: msg.members || [],
        });
        break;

      case 'user_joined_channel':
        this.emit('user_joined_channel', {
          channel_id: msg.channel_id,
          username: msg.username,
          display_name: msg.display_name,
        });
        break;

      case 'user_left_channel':
        this.emit('user_left_channel', {
          channel_id: msg.channel_id,
          username: msg.username,
        });
        break;

      default:
        this.emit('raw_message', msg);
        break;
    }
  }

  // --- Calling API ---

  requestCall(toUsername) {
    return this.send({ type: 'call_request', to: toUsername });
  }

  sendCallOffer(to, sdp, channelId = null) {
    const payload = { type: 'call_offer', to, sdp };
    if (channelId) payload.channel_id = channelId;
    return this.send(payload);
  }

  sendCallAnswer(to, sdp, channelId = null) {
    const payload = { type: 'call_answer', to, sdp };
    if (channelId) payload.channel_id = channelId;
    return this.send(payload);
  }

  sendIceCandidate(to, candidate, channelId = null) {
    const payload = { type: 'ice_candidate', to, candidate };
    if (channelId) payload.channel_id = channelId;
    return this.send(payload);
  }

  endCall(to, channelId = null) {
    const payload = { type: 'call_end' };
    if (to) payload.to = to;
    if (channelId) payload.channel_id = channelId;
    return this.send(payload);
  }

  declineCall(to, channelId = null) {
    const payload = { type: 'call_decline' };
    if (to) payload.to = to;
    if (channelId) payload.channel_id = channelId;
    return this.send(payload);
  }

  cancelCall(to) {
    return this.send({ type: 'call_cancel', to });
  }

  joinVoiceChannel(channelId) {
    return this.send({ type: 'join_channel', channel_id: Number(channelId) });
  }

  leaveVoiceChannel(channelId) {
    return this.send({ type: 'leave_channel', channel_id: Number(channelId) });
  }
}

export const signaling = new SignalingClient();
