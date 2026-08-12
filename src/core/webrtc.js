// Introvert High-Performance WebRTC Audio/Video & Voice Channel Call Engine

import { signaling } from './signaling.js';
import { config } from './config.js';

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

class WebRtcEngine {
  constructor() {
    this.callState = 'idle'; // 'idle' | 'calling' | 'ringing' | 'connected'
    this.callType = 'audio'; // 'audio' | 'video'
    this.peerUsername = null;
    this.peerDisplayName = null;
    this.channelId = null;
    this.channelMembers = new Map(); // username -> { displayName, isSpeaking }

    this.localStream = null;
    this.localScreenStream = null;
    this.peerConnections = new Map(); // username -> RTCPeerConnection
    this.remoteStreams = new Map(); // username -> MediaStream

    this.isMuted = false;
    this.isDeafened = false;
    this.isCameraOn = false;
    this.isScreenSharing = false;

    this.callStartTime = null;
    this.durationTimer = null;
    this.callDuration = 0;

    this.audioContext = null;
    this.analysers = new Map(); // 'local' or username -> AnalyserNode
    this.vadInterval = null;

    this.listeners = new Map();
    this.initSignalingListeners();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event).delete(handler);
  }

  emit(event, ...args) {
    if (this.listeners.has(event)) {
      for (const handler of this.listeners.get(event)) {
        try { handler(...args); } catch (e) { console.error(`WebRTC event [${event}] error`, e); }
      }
    }
  }

  initSignalingListeners() {
    signaling.on('incoming_call', async ({ from, from_display, sdp, channel_id }) => {
      if (this.callState !== 'idle' && this.callState !== 'calling') {
        signaling.declineCall(from, channel_id);
        return;
      }
      this.callState = 'ringing';
      this.peerUsername = from;
      this.peerDisplayName = from_display || from;
      this.channelId = channel_id || null;
      this.pendingIncomingSdp = sdp;
      this.playRingtone();
      this.emit('incoming_call', {
        from: this.peerUsername,
        from_display: this.peerDisplayName,
        channel_id: this.channelId,
      });
      this.emit('state_change', this.getState());
    });

    signaling.on('callee_available', async ({ to }) => {
      if (this.callState === 'calling' && this.peerUsername === to) {
        await this.produceOfferAndSend(to);
      }
    });

    signaling.on('calling_offline', ({ to, expires_at }) => {
      if (this.callState === 'calling' && this.peerUsername === to) {
        this.emit('calling_offline', { to, expires_at });
      }
    });

    signaling.on('callee_ringing', ({ to }) => {
      if (this.callState === 'calling' && this.peerUsername === to) {
        this.emit('callee_ringing', { to });
      }
    });

    signaling.on('call_answered', async ({ from, from_display, sdp, channel_id }) => {
      this.stopTones();
      const pc = this.peerConnections.get(from);
      if (pc && sdp) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
          this.callState = 'connected';
          this.peerDisplayName = from_display || from;
          this.startDurationTimer();
          this.playChime();
          this.emit('call_connected', { from, from_display });
          this.emit('state_change', this.getState());
        } catch (err) {
          console.error('Failed to set remote answer', err);
        }
      }
    });

    signaling.on('ice_candidate', async ({ from, candidate }) => {
      const pc = this.peerConnections.get(from);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Add ICE candidate failed', e);
        }
      }
    });

    signaling.on('call_ended', ({ from }) => {
      this.handlePeerLeft(from);
      if (this.channelId === null && this.peerUsername === from) {
        this.endCall(false);
      }
    });

    signaling.on('call_declined', ({ from }) => {
      if (this.peerUsername === from) {
        this.stopTones();
        this.playHangupSound();
        this.endCall(false);
        this.emit('call_declined', { from });
      }
    });

    signaling.on('call_unanswered', ({ from, to }) => {
      this.stopTones();
      this.endCall(false);
      this.emit('call_unanswered', { from, to });
    });

    signaling.on('channel_joined', async ({ channel_id, self, members }) => {
      this.channelId = channel_id;
      this.callState = 'connected';
      this.startDurationTimer();
      this.playChime();

      // Initiate peer connections to all existing room voice members
      for (const m of members) {
        if (m.username !== self.username) {
          this.channelMembers.set(m.username, { displayName: m.display_name || m.username, isSpeaking: false });
          await this.produceOfferAndSend(m.username, channel_id);
        }
      }
      this.emit('channel_joined', { channel_id, members });
      this.emit('state_change', this.getState());
    });

    signaling.on('user_joined_channel', async ({ channel_id, username, display_name }) => {
      if (this.channelId === channel_id) {
        this.channelMembers.set(username, { displayName: display_name || username, isSpeaking: false });
        this.playBlip(true);
        this.emit('user_joined_channel', { username, display_name });
        this.emit('state_change', this.getState());
      }
    });

    signaling.on('user_left_channel', ({ channel_id, username }) => {
      if (this.channelId === channel_id) {
        this.handlePeerLeft(username);
        this.playBlip(false);
        this.emit('user_left_channel', { username });
        this.emit('state_change', this.getState());
      }
    });
  }

  // --- Call Lifecycle ---

  async startCall(targetUsername, withVideo = false) {
    if (this.callState !== 'idle') return;
    this.callState = 'calling';
    this.callType = withVideo ? 'video' : 'audio';
    this.peerUsername = targetUsername;
    this.channelId = null;
    this.isCameraOn = withVideo;

    this.playRingback();
    this.emit('state_change', this.getState());

    await this.ensureLocalMedia(withVideo);
    signaling.requestCall(targetUsername);
  }

  async answerCall(withVideo = false) {
    if (this.callState !== 'ringing') return;
    this.stopTones();
    this.callType = withVideo ? 'video' : 'audio';
    this.isCameraOn = withVideo;
    await this.ensureLocalMedia(withVideo);

    const from = this.peerUsername;
    const pc = this.createPeerConnection(from);

    if (this.pendingIncomingSdp) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: this.pendingIncomingSdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.sendCallAnswer(from, answer.sdp, this.channelId);

        this.callState = 'connected';
        this.startDurationTimer();
        this.playChime();
        this.emit('call_connected', { from, from_display: this.peerDisplayName });
        this.emit('state_change', this.getState());
      } catch (err) {
        console.error('Failed to answer call', err);
        this.endCall();
      }
    }
  }

  declineCall() {
    this.stopTones();
    if (this.peerUsername) {
      signaling.declineCall(this.peerUsername, this.channelId);
    }
    this.endCall(false);
  }

  async joinVoiceChannel(channelId, withVideo = false) {
    if (this.callState !== 'idle') {
      this.leaveVoiceChannel();
    }
    this.callState = 'calling';
    this.channelId = channelId;
    this.callType = withVideo ? 'video' : 'audio';
    this.isCameraOn = withVideo;
    this.emit('state_change', this.getState());

    await this.ensureLocalMedia(withVideo);
    signaling.joinVoiceChannel(channelId);
  }

  leaveVoiceChannel() {
    if (this.channelId) {
      signaling.leaveVoiceChannel(this.channelId);
    }
    this.endCall(true);
  }

  endCall(notifyPeer = true) {
    this.stopTones();
    this.stopDurationTimer();
    this.stopVad();

    if (notifyPeer && this.peerUsername) {
      signaling.endCall(this.peerUsername, this.channelId);
    }

    this.cleanupMedia();
    this.callState = 'idle';
    this.peerUsername = null;
    this.peerDisplayName = null;
    this.channelId = null;
    this.channelMembers.clear();
    this.callDuration = 0;

    this.playHangupSound();
    this.emit('call_ended');
    this.emit('state_change', this.getState());
  }

  handlePeerLeft(username) {
    const pc = this.peerConnections.get(username);
    if (pc) {
      pc.close();
      this.peerConnections.delete(username);
    }
    this.remoteStreams.delete(username);
    this.channelMembers.delete(username);
    this.analysers.delete(username);
    this.emit('peer_stream_removed', { username });
  }

  // --- Peer Connection & SDP Flow ---

  createPeerConnection(targetUsername) {
    if (this.peerConnections.has(targetUsername)) {
      return this.peerConnections.get(targetUsername);
    }

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    this.peerConnections.set(targetUsername, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        signaling.sendIceCandidate(targetUsername, event.candidate, this.channelId);
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.remoteStreams.set(targetUsername, stream);
      this.attachRemoteAnalyser(targetUsername, stream);
      this.emit('peer_stream_added', { username: targetUsername, stream });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.handlePeerLeft(targetUsername);
      }
    };

    return pc;
  }

  async produceOfferAndSend(targetUsername, channelId = null) {
    const pc = this.createPeerConnection(targetUsername);
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(offer);
      signaling.sendCallOffer(targetUsername, offer.sdp, channelId);
    } catch (err) {
      console.error('Failed to create offer', err);
    }
  }

  // --- Media & Stream Management ---

  async ensureLocalMedia(withVideo = false) {
    if (this.localStream) {
      if (withVideo && this.localStream.getVideoTracks().length === 0) {
        await this.addVideoTrack();
      }
      return this.localStream;
    }

    const constraints = {
      audio: {
        deviceId: config.audioInputId !== 'default' ? { exact: config.audioInputId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: withVideo
        ? {
            deviceId: config.videoInputId !== 'default' ? { exact: config.videoInputId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : false,
    };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.attachLocalAnalyser(this.localStream);
      this.startVad();
      this.emit('local_stream_ready', this.localStream);
      return this.localStream;
    } catch (err) {
      console.warn('Microphone/Camera access failed, trying audio only', err);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.attachLocalAnalyser(this.localStream);
        this.startVad();
        this.emit('local_stream_ready', this.localStream);
        return this.localStream;
      } catch (e) {
        console.error('Total media acquisition failure', e);
        throw e;
      }
    }
  }

  async addVideoTrack() {
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: config.videoInputId !== 'default' ? { exact: config.videoInputId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      const videoTrack = videoStream.getVideoTracks()[0];
      if (videoTrack && this.localStream) {
        this.localStream.addTrack(videoTrack);
        for (const pc of this.peerConnections.values()) {
          pc.addTrack(videoTrack, this.localStream);
        }
        this.isCameraOn = true;
        this.emit('local_stream_ready', this.localStream);
        this.emit('state_change', this.getState());
      }
    } catch (err) {
      console.error('Failed to enable camera', err);
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((t) => {
        t.enabled = !this.isMuted;
      });
    }
    this.emit('state_change', this.getState());
    return this.isMuted;
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    if (this.isDeafened) {
      this.isMuted = true;
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
      }
    }
    for (const stream of this.remoteStreams.values()) {
      stream.getAudioTracks().forEach((t) => (t.enabled = !this.isDeafened));
    }
    this.emit('state_change', this.getState());
    return this.isDeafened;
  }

  async toggleCamera() {
    if (this.isCameraOn) {
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach((t) => {
          t.stop();
          this.localStream.removeTrack(t);
        });
      }
      this.isCameraOn = false;
    } else {
      await this.addVideoTrack();
    }
    this.emit('state_change', this.getState());
    return this.isCameraOn;
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      if (this.localScreenStream) {
        this.localScreenStream.getTracks().forEach((t) => t.stop());
        this.localScreenStream = null;
      }
      this.isScreenSharing = false;
      this.emit('screenshare_stopped');
    } else {
      try {
        this.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        const screenTrack = this.localScreenStream.getVideoTracks()[0];
        screenTrack.onended = () => {
          this.isScreenSharing = false;
          this.emit('screenshare_stopped');
          this.emit('state_change', this.getState());
        };

        for (const pc of this.peerConnections.values()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(screenTrack);
          } else {
            pc.addTrack(screenTrack, this.localScreenStream);
          }
        }
        this.isScreenSharing = true;
        this.emit('screenshare_started', this.localScreenStream);
      } catch (err) {
        console.error('Screen sharing denied or failed', err);
        this.isScreenSharing = false;
      }
    }
    this.emit('state_change', this.getState());
    return this.isScreenSharing;
  }

  cleanupMedia() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach((t) => t.stop());
      this.localScreenStream = null;
    }
    for (const pc of this.peerConnections.values()) {
      pc.close();
    }
    this.peerConnections.clear();
    this.remoteStreams.clear();
    this.analysers.clear();
    this.isCameraOn = false;
    this.isScreenSharing = false;
    this.isMuted = false;
    this.isDeafened = false;
  }

  // --- Voice Activity Detection (VAD) & Audio Meters ---

  ensureAudioContext() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioContext = new AudioCtx();
      }
    }
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    return this.audioContext;
  }

  attachLocalAnalyser(stream) {
    try {
      const ctx = this.ensureAudioContext();
      if (!ctx) return;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.analysers.set('local', analyser);
    } catch (e) {}
  }

  attachRemoteAnalyser(username, stream) {
    try {
      const ctx = this.ensureAudioContext();
      if (!ctx) return;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      // Connect to audio destination so we hear the remote audio
      analyser.connect(ctx.destination);
      this.analysers.set(username, analyser);
    } catch (e) {}
  }

  startVad() {
    this.stopVad();
    const dataArray = new Uint8Array(128);
    this.vadInterval = setInterval(() => {
      // Local speaking detection
      const localAnalyser = this.analysers.get('local');
      if (localAnalyser && !this.isMuted) {
        localAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const isSpeaking = avg > 15;
        this.emit('local_speaking', { isSpeaking, level: avg });
      }

      // Remote speaking detection
      for (const [username, analyser] of this.analysers.entries()) {
        if (username === 'local') continue;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const isSpeaking = avg > 15;
        const member = this.channelMembers.get(username);
        if (member && member.isSpeaking !== isSpeaking) {
          member.isSpeaking = isSpeaking;
          this.emit('peer_speaking', { username, isSpeaking, level: avg });
        }
      }
    }, 100);
  }

  stopVad() {
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
  }

  // --- Sound Effects & Synthesizer ---

  playRingback() {
    this.stopTones();
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    this.toneInterval = setInterval(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 1.5);
    }, 3000);
  }

  playRingtone() {
    this.stopTones();
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const playNote = (freq, time, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, time);
      gain.gain.setValueAtTime(0.12, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(time);
      osc.stop(time + dur);
    };

    this.toneInterval = setInterval(() => {
      const t = ctx.currentTime;
      playNote(523.25, t, 0.2); // C5
      playNote(659.25, t + 0.25, 0.2); // E5
      playNote(783.99, t + 0.5, 0.35); // G5
    }, 2500);
  }

  playChime() {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, t); // D5
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.3); // A5
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  playHangupSound() {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.25);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  playBlip(join = true) {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(join ? 440 : 660, t);
    osc.frequency.exponentialRampToValueAtTime(join ? 660 : 440, t + 0.15);
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  stopTones() {
    if (this.toneInterval) {
      clearInterval(this.toneInterval);
      this.toneInterval = null;
    }
  }

  // --- Duration Counter ---

  startDurationTimer() {
    this.stopDurationTimer();
    this.callStartTime = Date.now();
    this.callDuration = 0;
    this.durationTimer = setInterval(() => {
      this.callDuration = Math.floor((Date.now() - this.callStartTime) / 1000);
      this.emit('duration_tick', this.formatDuration(this.callDuration));
    }, 1000);
  }

  stopDurationTimer() {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  getState() {
    return {
      callState: this.callState,
      callType: this.callType,
      peerUsername: this.peerUsername,
      peerDisplayName: this.peerDisplayName,
      channelId: this.channelId,
      channelMembers: Array.from(this.channelMembers.entries()).map(([u, d]) => ({
        username: u,
        displayName: d.displayName,
        isSpeaking: d.isSpeaking,
      })),
      isMuted: this.isMuted,
      isDeafened: this.isDeafened,
      isCameraOn: this.isCameraOn,
      isScreenSharing: this.isScreenSharing,
      callDuration: this.formatDuration(this.callDuration),
    };
  }
}

export const webrtc = new WebRtcEngine();
