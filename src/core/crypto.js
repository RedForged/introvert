// Introvert Matrix Olm & Megolm Cryptographic Engine
// Compatible with Extrovert Double-Ratchet DMs, Megolm Rooms & Additional Security

import { api } from './api.js';
import { storage } from './config.js';

const DB_NAME = 'introvert-e2ee';
const STORE_CRYPTO = 'cryptokeys';
const STORE_OLM = 'olm';
const STORE_SECURE = 'securemsgs';
const KEY_DEVICE = 'deviceKey';
const PICKLE_KEY = 'extrovert-olm-pickle-v1';
const PREKEY_THRESHOLD = 3;

class CryptoEngine {
  constructor() {
    this.olmInitPromise = null;
    this.deviceKey = null;
    this.account = null;
    this.myIdKeys = null; // { curve25519, ed25519 }
    this.sessions = {}; // otherUserIdStr -> Olm.Session
    this.sessionBaselines = {}; // otherUserIdStr -> Olm.Session
    this.selfOutbound = null;
    this.selfInbound = null;
    this.selfInboundBaseline = null;
    this.kek = null; // transient key from password
    this.legacyPrivateKey = null;

    // Megolm Room Sessions
    this.groupOutbound = {}; // roomId -> Olm.OutboundGroupSession
    this.groupOutIds = {}; // roomId -> sessionId
    this.groupInbound = {}; // roomId:senderId:sessionId -> Olm.InboundGroupSession

    this.secureWriteQueues = {};
  }

  // --- IndexedDB & File Store Helpers ---

  async openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CRYPTO)) db.createObjectStore(STORE_CRYPTO);
        if (!db.objectStoreNames.contains(STORE_OLM)) db.createObjectStore(STORE_OLM);
        if (!db.objectStoreNames.contains(STORE_SECURE)) db.createObjectStore(STORE_SECURE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async idbGet(storeName, key) {
    // Try fast native storage first
    const fileVal = await storage.get(`${storeName}:${key}`);
    if (fileVal !== null && fileVal !== undefined) return fileVal;

    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  }

  async idbSet(storeName, key, value) {
    await storage.set(`${storeName}:${key}`, value);
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {}
  }

  // --- Base64 & Text Utilities ---

  b64ToUint8(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  uint8ToB64(arr) {
    let s = '';
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }

  enc(str) {
    return new TextEncoder().encode(str);
  }

  dec(buf) {
    return new TextDecoder().decode(buf);
  }

  // --- Key Encryption (Device Key Kd & Password KEK) ---

  async deriveKek(password, username) {
    const e = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      e.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: e.encode((username || '').toLowerCase()),
        iterations: 600000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']
    );
  }

  async getOrCreateDeviceKey() {
    if (this.deviceKey) return this.deviceKey;
    const existing = await this.idbGet(STORE_CRYPTO, KEY_DEVICE);
    if (existing) {
      if (typeof existing === 'string') {
        const k = await crypto.subtle.importKey(
          'raw',
          this.b64ToUint8(existing),
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        this.deviceKey = k;
        return k;
      }
      this.deviceKey = existing;
      return existing;
    }

    const newKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    this.deviceKey = newKey;
    const raw = await crypto.subtle.exportKey('raw', newKey);
    await this.idbSet(STORE_CRYPTO, KEY_DEVICE, this.uint8ToB64(new Uint8Array(raw)));
    return newKey;
  }

  async encryptWithKd(plaintext) {
    const key = await this.getOrCreateDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, this.enc(plaintext));
    const c = new Uint8Array(iv.length + ct.byteLength);
    c.set(iv);
    c.set(new Uint8Array(ct), iv.length);
    return this.uint8ToB64(c);
  }

  async decryptWithKd(b64) {
    const key = await this.getOrCreateDeviceKey();
    const c = this.b64ToUint8(b64);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: c.slice(0, 12) },
      key,
      c.slice(12)
    );
    return this.dec(decrypted);
  }

  async encryptWithKek(plaintext, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, this.enc(plaintext));
    const c = new Uint8Array(iv.length + ct.byteLength);
    c.set(iv);
    c.set(new Uint8Array(ct), iv.length);
    return this.uint8ToB64(c);
  }

  async decryptWithKek(b64, key) {
    const c = this.b64ToUint8(b64);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: c.slice(0, 12) },
      key,
      c.slice(12)
    );
    return this.dec(decrypted);
  }

  // --- Matrix Olm Initialization ---

  async initOlm() {
    if (this.olmInitPromise) return this.olmInitPromise;
    this.olmInitPromise = (async () => {
      if (typeof window.Olm !== 'undefined' && window.Olm.init) {
        await window.Olm.init({
          locateFile: () => '/lib/olm.wasm',
        });
        return window.Olm;
      }
      // Load script if not already in window
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/lib/olm.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Olm script'));
        document.head.appendChild(script);
      });
      await window.Olm.init({
        locateFile: () => '/lib/olm.wasm',
      });
      return window.Olm;
    })();
    return this.olmInitPromise;
  }

  // --- Account Storage & Initialization ---

  async loadAccountFromStorage() {
    const enc = await this.idbGet(STORE_OLM, 'account');
    if (!enc) return null;
    try {
      const pickle = await this.decryptWithKd(enc);
      this.account = new window.Olm.Account();
      this.account.unpickle(PICKLE_KEY, pickle);
      const k = JSON.parse(this.account.identity_keys());
      this.myIdKeys = { curve25519: k.curve25519, ed25519: k.ed25519 };
      return this.account;
    } catch (e) {
      console.warn('Failed to unpickle Olm account from storage', e);
      return null;
    }
  }

  async saveAccount() {
    if (!this.account) return;
    const enc = await this.encryptWithKd(this.account.pickle(PICKLE_KEY));
    await this.idbSet(STORE_OLM, 'account', enc);
  }

  createOlmAccount() {
    this.account = new window.Olm.Account();
    this.account.create();
    const k = JSON.parse(this.account.identity_keys());
    this.myIdKeys = { curve25519: k.curve25519, ed25519: k.ed25519 };
  }

  async publishPrekeys() {
    const keys = JSON.parse(this.account.one_time_keys());
    const otks = Object.keys(keys.curve25519).map((id) => ({
      id,
      public_key: keys.curve25519[id],
    }));
    const fallback = JSON.parse(this.account.fallback_key());
    const fb = fallback.curve25519[Object.keys(fallback.curve25519)[0]];

    await api.publishPrekeys({
      identity_key: this.myIdKeys.curve25519,
      ed25519_key: this.myIdKeys.ed25519,
      fallback_key: fb,
      one_time_keys: otks,
    });

    this.account.mark_keys_as_published();
    await this.saveAccount();
  }

  async createAndPublishAccount() {
    this.createOlmAccount();
    this.account.generate_fallback_key();
    this.account.generate_one_time_keys(5);
    await this.publishPrekeys();
  }

  async maybeReplenishPrekeys() {
    try {
      const data = await api.getPrekeysCount();
      if (!data || data.available < PREKEY_THRESHOLD) {
        if (!this.account) return;
        this.account.generate_one_time_keys(5);
        await this.publishPrekeys();
      }
    } catch (e) {}
  }

  async ensureReady({ onNeedsPassword } = {}) {
    await this.initOlm();
    await this.getOrCreateDeviceKey();
    const acct = await this.loadAccountFromStorage();
    if (acct) {
      await this.loadSelfSessions();
      this.maybeReplenishPrekeys();
      return true;
    }
    if (onNeedsPassword) {
      onNeedsPassword();
    }
    return false;
  }

  async unlockWithPassword(password, username) {
    const pass = String(password || '').trim();
    if (!pass) throw new Error('Password required');
    await this.initOlm();
    const k = await this.deriveKek(pass, username);
    this.kek = k;
    await this.getOrCreateDeviceKey();
    const acct = await this.loadAccountFromStorage();
    if (acct) {
      await this.loadSelfSessions();
      return true;
    }

    try {
      const data = await api.getPrekeysBackup();
      if (data && data.backup) {
        const pickle = await this.decryptWithKek(data.backup, this.kek);
        this.account = new window.Olm.Account();
        this.account.unpickle(PICKLE_KEY, pickle);
        const keys = JSON.parse(this.account.identity_keys());
        this.myIdKeys = { curve25519: keys.curve25519, ed25519: keys.ed25519 };
      } else {
        await this.createAndPublishAccount();
        const encBackup = await this.encryptWithKek(this.account.pickle(PICKLE_KEY), this.kek);
        await api.publishPrekeys({ backup: encBackup });
      }
    } catch (err) {
      // If fetching backup fails or no backup, create fresh account
      await this.createAndPublishAccount();
      const encBackup = await this.encryptWithKek(this.account.pickle(PICKLE_KEY), this.kek);
      await api.publishPrekeys({ backup: encBackup });
    }

    await this.maybeReplenishPrekeys();
    await this.saveAccount();
    await this.loadSelfSessions();
    return true;
  }

  // --- 1:1 Sessions (Double-Ratchet) ---

  async loadSession(otherIdStr) {
    if (this.sessions[otherIdStr]) return this.sessions[otherIdStr];
    const enc = await this.idbGet(STORE_OLM, `session:${otherIdStr}`);
    if (!enc) return null;
    try {
      const pickle = await this.decryptWithKd(enc);
      const s = new window.Olm.Session();
      s.unpickle(PICKLE_KEY, pickle);
      this.sessions[otherIdStr] = s;
      return s;
    } catch (e) {
      return null;
    }
  }

  async saveSession(otherIdStr, session) {
    this.sessions[otherIdStr] = session;
    const enc = await this.encryptWithKd(session.pickle(PICKLE_KEY));
    await this.idbSet(STORE_OLM, `session:${otherIdStr}`, enc);
  }

  async saveSessionBaseline(otherIdStr, session) {
    this.sessionBaselines[otherIdStr] = session;
    const enc = await this.encryptWithKd(session.pickle(PICKLE_KEY));
    await this.idbSet(STORE_OLM, `sessionBase:${otherIdStr}`, enc);
  }

  async loadSessionBaseline(otherIdStr) {
    if (this.sessionBaselines[otherIdStr]) return this.sessionBaselines[otherIdStr];
    const enc = await this.idbGet(STORE_OLM, `sessionBase:${otherIdStr}`);
    if (!enc) return null;
    try {
      const pickle = await this.decryptWithKd(enc);
      const s = new window.Olm.Session();
      s.unpickle(PICKLE_KEY, pickle);
      this.sessionBaselines[otherIdStr] = s;
      return s;
    } catch (e) {
      return null;
    }
  }

  async loadSelfSessions() {
    const loadOne = async (key) => {
      const enc = await this.idbGet(STORE_OLM, key);
      if (!enc) return null;
      try {
        const pickle = await this.decryptWithKd(enc);
        const s = new window.Olm.Session();
        s.unpickle(PICKLE_KEY, pickle);
        return s;
      } catch (e) {
        return null;
      }
    };

    if (!this.selfOutbound) this.selfOutbound = await loadOne('selfOutbound');
    if (!this.selfInbound) {
      this.selfInbound = await loadOne('selfInbound');
      if (this.selfInbound) this.selfInboundBaseline = this.selfInbound.pickle(PICKLE_KEY);
    }
  }

  async saveSelfSessions() {
    if (this.selfOutbound) {
      const encOut = await this.encryptWithKd(this.selfOutbound.pickle(PICKLE_KEY));
      await this.idbSet(STORE_OLM, 'selfOutbound', encOut);
    }
    const inboundPickle = this.selfInboundBaseline || (this.selfInbound ? this.selfInbound.pickle(PICKLE_KEY) : null);
    if (inboundPickle) {
      const encIn = await this.encryptWithKd(inboundPickle);
      await this.idbSet(STORE_OLM, 'selfInbound', encIn);
    }
  }

  async ensureSelfSessions() {
    if (this.selfOutbound && this.selfInbound) return;
    await this.loadSelfSessions();
    if (this.selfOutbound && this.selfInbound) return;

    if (!this.account) throw new Error('Olm account not ready');
    this.account.generate_one_time_keys(1);
    const otks = JSON.parse(this.account.one_time_keys());
    const myOtkId = Object.keys(otks.curve25519)[0];
    const myOtk = otks.curve25519[myOtkId];

    this.selfOutbound = new window.Olm.Session();
    this.selfOutbound.create_outbound(this.account, this.myIdKeys.curve25519, myOtk);

    const initMsg = this.selfOutbound.encrypt('self-init');
    this.selfInbound = new window.Olm.Session();
    this.selfInbound.create_inbound(this.account, initMsg.body);
    this.account.remove_one_time_keys(this.selfInbound);
    this.selfInboundBaseline = this.selfInbound.pickle(PICKLE_KEY);

    await this.saveSelfSessions();
    await this.saveAccount();
  }

  async getOrCreateOutboundSession(otherIdStr, otherUsername) {
    const existing = await this.loadSession(otherIdStr);
    if (existing) {
      const storedIdent = await this.idbGet(STORE_OLM, `sessionIdent:${otherIdStr}`);
      if (!storedIdent) return existing;
      try {
        const safety = await api.getSafetyKeys(otherUsername);
        if (safety && safety.their_curve25519 && safety.their_curve25519 === storedIdent) {
          return existing;
        }
      } catch (e) {
        return existing;
      }
    }

    // Build new outbound session
    const bundle = await api.getPeerBundle(otherUsername);
    if (!bundle || !bundle.identity_key) {
      throw new Error(`User @${otherUsername} has not published encryption keys yet.`);
    }
    const otk = bundle.one_time_key ? bundle.one_time_key.public_key : bundle.fallback_key;
    const session = new window.Olm.Session();
    session.create_outbound(this.account, bundle.identity_key, otk);

    await this.saveSessionBaseline(otherIdStr, session);
    await this.saveSession(otherIdStr, session);
    await this.idbSet(STORE_OLM, `sessionIdent:${otherIdStr}`, bundle.identity_key);
    return session;
  }

  // --- 1:1 Direct Message Encryption & Decryption ---

  async encryptDm(otherIdStr, otherUsername, plaintext) {
    await this.ensureSelfSessions();
    const session = await this.getOrCreateOutboundSession(otherIdStr, otherUsername);
    const recipientEncrypted = session.encrypt(plaintext);
    const selfEncrypted = this.selfOutbound.encrypt(plaintext);

    await this.saveSession(otherIdStr, session);
    await this.saveSelfSessions();

    return {
      body: JSON.stringify({ t: recipientEncrypted.type, b: recipientEncrypted.body }),
      proto: 'olm',
      sender_ciphertext: JSON.stringify({ t: selfEncrypted.type, b: selfEncrypted.body }),
    };
  }

  async decryptDm(msg, isOwn, otherIdStr, peerCurveKey) {
    if (msg.body && msg.body.startsWith('/uploads/stickers/')) {
      return msg.body;
    }

    if (isOwn) {
      await this.ensureSelfSessions();
      if (!msg.sender_ciphertext) throw new Error('Missing sender ciphertext');
      const env = JSON.parse(msg.sender_ciphertext);
      const replay = new window.Olm.Session();
      replay.unpickle(PICKLE_KEY, this.selfInboundBaseline);
      return replay.decrypt(env.t, env.b);
    }

    // Incoming message from peer
    const env = JSON.parse(msg.body);
    let session = await this.loadSession(otherIdStr);

    if (env.t === 0) {
      // PreKey message: instantiate inbound session
      const newSession = new window.Olm.Session();
      if (peerCurveKey) {
        newSession.create_inbound_from(this.account, peerCurveKey, env.b);
      } else {
        newSession.create_inbound(this.account, env.b);
      }
      this.account.remove_one_time_keys(newSession);
      await this.saveSessionBaseline(otherIdStr, newSession);
      await this.saveSession(otherIdStr, newSession);
      await this.saveAccount();
      return newSession.decrypt(env.t, env.b);
    }

    if (session) {
      try {
        const plain = session.decrypt(env.t, env.b);
        await this.saveSession(otherIdStr, session);
        return plain;
      } catch (e) {}
    }

    // Fallback: try baseline replay
    const base = await this.loadSessionBaseline(otherIdStr);
    if (base) {
      const replay = new window.Olm.Session();
      replay.unpickle(PICKLE_KEY, base.pickle(PICKLE_KEY));
      return replay.decrypt(env.t, env.b);
    }

    throw new Error('Unable to decrypt message (session ratchet state mismatch)');
  }

  // --- Additional Security Mode: Local Storage & Receipt Acks ---

  async securePersistMessage(otherIdStr, record) {
    const prev = this.secureWriteQueues[otherIdStr] || Promise.resolve();
    const next = prev.then(async () => {
      const msgs = await this.secureLoadMessages(otherIdStr);
      const idx = msgs.findIndex((m) => String(m.id) === String(record.id));
      if (idx === -1) msgs.push(record);
      else msgs[idx] = record;
      msgs.sort((a, b) => a.created_at - b.created_at || Number(a.id) - Number(b.id));
      const enc = await this.encryptWithKd(JSON.stringify(msgs));
      await this.idbSet(STORE_SECURE, `conv:${otherIdStr}`, enc);
    });
    this.secureWriteQueues[otherIdStr] = next.catch(() => {});
    return next;
  }

  async secureLoadMessages(otherIdStr) {
    const enc = await this.idbGet(STORE_SECURE, `conv:${otherIdStr}`);
    if (!enc) return [];
    try {
      const json = await this.decryptWithKd(enc);
      const msgs = JSON.parse(json);
      return Array.isArray(msgs) ? msgs : [];
    } catch (e) {
      return [];
    }
  }

  // --- Megolm Group Sessions (Rooms) ---

  async loadGroupOutbound(roomId) {
    if (this.groupOutbound[roomId]) return this.groupOutbound[roomId];
    const enc = await this.idbGet(STORE_OLM, `grpOut:${roomId}`);
    if (!enc) return null;
    try {
      const json = await this.decryptWithKd(enc);
      const data = JSON.parse(json);
      const og = new window.Olm.OutboundGroupSession();
      og.unpickle(PICKLE_KEY, data.pickle);
      this.groupOutbound[roomId] = og;
      this.groupOutIds[roomId] = data.id;
      return og;
    } catch (e) {
      return null;
    }
  }

  async saveGroupOutbound(roomId, session, sessionId) {
    this.groupOutbound[roomId] = session;
    this.groupOutIds[roomId] = sessionId;
    const payload = JSON.stringify({ id: sessionId, pickle: session.pickle(PICKLE_KEY) });
    const enc = await this.encryptWithKd(payload);
    await this.idbSet(STORE_OLM, `grpOut:${roomId}`, enc);
  }

  async loadGroupInbound(roomId, senderId, sessionId) {
    const key = `${roomId}:${senderId}:${sessionId}`;
    if (this.groupInbound[key]) return this.groupInbound[key];
    const enc = await this.idbGet(STORE_OLM, `grpIn:${key}`);
    if (!enc) return null;
    try {
      const pickle = await this.decryptWithKd(enc);
      const ig = new window.Olm.InboundGroupSession();
      ig.unpickle(PICKLE_KEY, pickle);
      this.groupInbound[key] = ig;
      return ig;
    } catch (e) {
      return null;
    }
  }

  async saveGroupInbound(roomId, senderId, sessionId, session) {
    const key = `${roomId}:${senderId}:${sessionId}`;
    this.groupInbound[key] = session;
    const enc = await this.encryptWithKd(session.pickle(PICKLE_KEY));
    await this.idbSet(STORE_OLM, `grpIn:${key}`, enc);
  }

  async roomSessionKeyEnvelope(roomId, session, recipientId, recipientUsername) {
    const sessKey = session.session_key();
    const session1to1 = await this.getOrCreateOutboundSession(String(recipientId), recipientUsername);
    const enc = session1to1.encrypt(sessKey);
    await this.saveSession(String(recipientId), session1to1);
    return JSON.stringify({ t: enc.type, b: enc.body });
  }

  async syncRoomSessions(roomId, myId, members) {
    const others = members.filter((m) => Number(m.id) !== Number(myId));
    const allIds = members.map((m) => Number(m.id));

    // 1. Fetch & import pending Megolm keys for this room
    const pending = await api.getPendingRoomKeys(roomId);
    const deliveredIds = [];

    for (const k of pending) {
      if (String(k.room_id) === String(roomId) && String(k.sender_id) !== String(myId)) {
        try {
          const env = JSON.parse(k.encrypted_key);
          let sess = await this.loadSession(String(k.sender_id));
          let sessionKey;

          if (env.t === 0) {
            const ns = new window.Olm.Session();
            ns.create_inbound(this.account, env.b);
            this.account.remove_one_time_keys(ns);
            await this.saveSessionBaseline(String(k.sender_id), ns);
            await this.saveSession(String(k.sender_id), ns);
            await this.saveAccount();
            sessionKey = ns.decrypt(env.t, env.b);
          } else if (sess) {
            sessionKey = sess.decrypt(env.t, env.b);
            await this.saveSession(String(k.sender_id), sess);
          }

          if (sessionKey) {
            const ig = new window.Olm.InboundGroupSession();
            ig.create(sessionKey);
            await this.saveGroupInbound(k.room_id, k.sender_id, k.session_id, ig);
            deliveredIds.push(k.key_id);
          }
        } catch (err) {
          console.warn('Room key import failed for sender', k.sender_id, err);
        }
      }
    }

    if (deliveredIds.length > 0) {
      await api.ackDeliveredRoomKeys(roomId, deliveredIds);
    }

    // 2. Ensure outbound Megolm session
    let out = await this.loadGroupOutbound(roomId);
    let status;
    try {
      status = await api.getRoomSessionStatus(roomId);
    } catch (e) {
      status = null;
    }

    const currentValid = out && this.groupOutIds[roomId] && status && String(this.groupOutIds[roomId]) === String(status.session_id);

    if (currentValid) {
      const have = (status.recipients || []).map(Number);
      const empty = (status.empty_keys_for || []).map(Number);
      const joined = others.filter((m) => have.indexOf(Number(m.id)) === -1);

      if (joined.length > 0) {
        // Rotate session so newly joined members cannot decrypt historical messages
        const fresh = new window.Olm.OutboundGroupSession();
        fresh.create();
        await this.shareRoomSession(roomId, fresh, others, allIds, true);
        return;
      }

      const needKey = others.filter((m) => empty.indexOf(Number(m.id)) !== -1);
      if (needKey.length > 0) {
        await this.shareRoomSession(roomId, out, needKey, allIds, false);
      }
      return;
    }

    // Create and share fresh Megolm session
    const fresh = new window.Olm.OutboundGroupSession();
    fresh.create();
    await this.shareRoomSession(roomId, fresh, others, allIds, true);
  }

  async shareRoomSession(roomId, session, members, allMemberIds, rotate = false) {
    const keys = [];
    for (const m of members) {
      try {
        const env = await this.roomSessionKeyEnvelope(roomId, session, m.id, m.username);
        keys.push({ recipient_id: m.id, encrypted_key: env });
      } catch (err) {
        console.warn('Skipping key share to room member', m.id, err.message);
      }
    }

    const res = await api.publishRoomSession(roomId, {
      keys,
      member_ids: allMemberIds,
      rotate,
    });

    const sessionId = (res && res.session_id) || session.session_id();
    await this.saveGroupOutbound(roomId, session, sessionId);

    // Also import outbound key into our own inbound store to decrypt our own messages
    const ig = new window.Olm.InboundGroupSession();
    ig.create(session.session_key());
    const myId = api.currentUserId ? api.currentUserId() : (config.currentUser ? config.currentUser.id : 0);
    await this.saveGroupInbound(roomId, myId, sessionId, ig);
    return sessionId;
  }

  async encryptRoomMessage(roomId, plaintext) {
    let out = await this.loadGroupOutbound(roomId);
    if (!out) {
      throw new Error('Room encryption session not initialized. Please sync room.');
    }
    const ct = out.encrypt(plaintext);
    const sid = this.groupOutIds[roomId];
    await this.saveGroupOutbound(roomId, out, sid);
    return {
      ciphertext: ct,
      group_session_id: String(sid),
    };
  }

  async decryptRoomMessage(roomId, senderId, ciphertext, groupSessionId) {
    const ig = await this.loadGroupInbound(roomId, senderId, groupSessionId);
    if (!ig) {
      throw new Error('Missing inbound group session for sender');
    }
    const res = ig.decrypt(ciphertext);
    await this.saveGroupInbound(roomId, senderId, groupSessionId, ig);
    return res.plaintext;
  }
}

export const cryptoEngine = new CryptoEngine();
