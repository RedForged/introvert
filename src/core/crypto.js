// Introvert Matrix Olm & Megolm Cryptographic Engine
// Compatible with Extrovert Double-Ratchet DMs, Megolm Rooms & Additional Security

import { api } from './api.js';
import { config, storage } from './config.js';

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
    this.sessionBaselines = {}; // otherUserIdStr -> creation-state pickle string
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

    // Serialization queues: Olm sessions are stateful, so everything that
    // reads, ratchets or persists a given session must run strictly
    // one-at-a-time. Concurrent decrypts otherwise advance the ratchet out
    // of order and let stale pickles overwrite newer ones.
    this.ensureReadyPromise = null;
    this.sessionLocks = {}; // lockKey -> tail Promise
    this.accountSaveQueue = Promise.resolve();
    this.replenishQueue = Promise.resolve();
    this.lastReplenishCheck = 0;
    this.deviceId = null;
    this.historySyncTimer = null;
  }

  async getOrCreateDeviceId() {
    if (this.deviceId) return this.deviceId;
    const existing = await this.idbGet(STORE_CRYPTO, 'deviceId');
    if (existing) {
      this.deviceId = String(existing);
      return this.deviceId;
    }
    const arr = new Uint8Array(12);
    crypto.getRandomValues(arr);
    let hex = '';
    for (let i = 0; i < arr.length; i++) {
      const h = arr[i].toString(16);
      hex += (h.length === 1 ? '0' : '') + h;
    }
    const id = 'dev_' + hex;
    this.deviceId = id;
    await this.idbSet(STORE_CRYPTO, 'deviceId', id);
    return id;
  }

  withLock(key, fn) {
    const prev = this.sessionLocks[key] || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    this.sessionLocks[key] = run.catch(() => {});
    return run;
  }

  withPeerLock(otherIdStr, fn) {
    return this.withLock(`peer:${otherIdStr || '__anon__'}`, fn);
  }

  withSelfLock(fn) {
    return this.withLock('__self__', fn);
  }

  withGroupLock(key, fn) {
    return this.withLock(`group:${key}`, fn);
  }

  schedulePrekeyReplenish() {
    setTimeout(() => {
      this.maybeReplenishPrekeys().catch(() => {});
    }, 3000);
  }

  scheduleHistorySync() {
    if (!this.kek) return;
    if (this.historySyncTimer) clearTimeout(this.historySyncTimer);
    this.historySyncTimer = setTimeout(() => {
      this.syncHistoryBackup().catch(() => {});
    }, 2500);
  }

  async syncHistoryBackup() {
    if (!this.kek) return;
    try {
      const db = await this.openDB();
      const allData = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SECURE, 'readonly');
        const store = tx.objectStore(STORE_SECURE);
        const req = store.openCursor();
        const data = {};
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(data);
            return;
          }
          data[cursor.key] = cursor.value;
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
      const json = JSON.stringify(allData);
      const enc = await this.encryptWithKek(json, this.kek);
      await api.uploadHistoryBackup(enc);
    } catch (e) {}
  }

  async restoreHistoryFromBackup() {
    if (!this.kek) return;
    try {
      const data = await api.getHistoryBackup();
      if (!data || !data.backup_data) return;
      const json = await this.decryptWithKek(data.backup_data, this.kek);
      const allData = JSON.parse(json);
      if (!allData || typeof allData !== 'object') return;
      const db = await this.openDB();
      const tx = db.transaction(STORE_SECURE, 'readwrite');
      const store = tx.objectStore(STORE_SECURE);
      for (const k of Object.keys(allData)) {
        store.put(allData[k], k);
      }
      await new Promise((resolve) => {
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch (e) {}
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

  async idbSet(storeName, key, val) {
    await storage.set(`${storeName}:${key}`, val);
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {}
  }

  async idbDelete(storeName, key) {
    await storage.delete(`${storeName}:${key}`);
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
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
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode(username.toLowerCase()),
        iterations: 600000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
    );
  }

  async getOrCreateDeviceKey() {
    if (this.deviceKey) return this.deviceKey;
    const raw = await this.idbGet(STORE_CRYPTO, KEY_DEVICE);
    if (raw) {
      try {
        const keyBytes = this.b64ToUint8(raw);
        this.deviceKey = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        return this.deviceKey;
      } catch (e) {
        console.warn('Failed to import existing device key, generating fresh key', e);
      }
    }

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    this.deviceKey = key;
    const exported = await crypto.subtle.exportKey('raw', key);
    await this.idbSet(STORE_CRYPTO, KEY_DEVICE, this.uint8ToB64(new Uint8Array(exported)));
    return key;
  }

  async encryptWithKd(plaintext) {
    await this.getOrCreateDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.deviceKey,
      this.enc(plaintext)
    );
    const combined = new Uint8Array(iv.length + ct.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ct), iv.length);
    return this.uint8ToB64(combined);
  }

  async decryptWithKd(b64) {
    await this.getOrCreateDeviceKey();
    const bytes = this.b64ToUint8(b64);
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.deviceKey,
      ct
    );
    return this.dec(decrypted);
  }

  async encryptWithKek(plaintext, kek) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      kek,
      this.enc(plaintext)
    );
    const combined = new Uint8Array(iv.length + ct.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ct), iv.length);
    return this.uint8ToB64(combined);
  }

  async decryptWithKek(b64, kek) {
    const bytes = this.b64ToUint8(b64);
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      kek,
      ct
    );
    return this.dec(decrypted);
  }

  // --- Matrix Olm Initialization ---

  async initOlm() {
    if (this.olmInitPromise) return this.olmInitPromise;
    this.olmInitPromise = (async () => {
      if (window.Olm && window.Olm.init) {
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
    // Never re-unpickle over a live account: a stale stored pickle would
    // regress one-time-key state that in-memory operations already advanced.
    if (this.account) return this.account;
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
    // Queue so the pickle is taken (and written) in call order — concurrent
    // decrypts must never let an older account state land last.
    const prev = this.accountSaveQueue;
    const run = prev.then(async () => {
      const enc = await this.encryptWithKd(this.account.pickle(PICKLE_KEY));
      await this.idbSet(STORE_OLM, 'account', enc);
    });
    this.accountSaveQueue = run.catch(() => {});
    return run;
  }

  createOlmAccount() {
    this.account = new window.Olm.Account();
    this.account.create();
    const k = JSON.parse(this.account.identity_keys());
    this.myIdKeys = { curve25519: k.curve25519, ed25519: k.ed25519 };
  }

  async publishPrekeys() {
    const devId = await this.getOrCreateDeviceId();
    const keys = JSON.parse(this.account.one_time_keys());
    const otks = Object.keys(keys.curve25519).map((id) => ({
      id,
      public_key: keys.curve25519[id],
    }));
    let fallback = JSON.parse(this.account.fallback_key());
    let fbKeys = Object.keys(fallback.curve25519 || {});
    if (!fbKeys.length) {
      try {
        this.account.generate_fallback_key();
        fallback = JSON.parse(this.account.fallback_key());
        fbKeys = Object.keys(fallback.curve25519 || {});
      } catch (_) {}
    }
    const fb = fbKeys.length ? fallback.curve25519[fbKeys[0]] : undefined;

    await api.publishPrekeys({
      device_id: devId,
      device_name: 'Introvert Native App',
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
    const now = Date.now();
    if (now - this.lastReplenishCheck < 60000) return;
    this.lastReplenishCheck = now;
    const run = this.replenishQueue.then(async () => {
      try {
        const devId = await this.getOrCreateDeviceId();
        const data = await api.getPrekeysCount(devId);
        if (!data || data.available < PREKEY_THRESHOLD) {
          if (!this.account) return;
          this.account.generate_one_time_keys(5);
          await this.publishPrekeys();
        }
      } catch (e) {}
    });
    this.replenishQueue = run.catch(() => {});
    return run;
  }

  async ensureReady() {
    // Memoized: live websocket events can arrive while bootstrap is still
    // initializing, and concurrent callers must share one init run.
    if (this.ensureReadyPromise) return this.ensureReadyPromise;
    this.ensureReadyPromise = this.initOlm()
      .then(() => this.getOrCreateDeviceKey())
      .then(() => this.getOrCreateDeviceId())
      .then(() => this.loadAccountFromStorage())
      .then(async (acct) => {
        if (!acct) {
          // First time on this device: generate fresh Olm account and publish keys
          await this.createAndPublishAccount();
          await this.ensureSelfSessions();
        } else {
          await this.loadSelfSessions();
          this.maybeReplenishPrekeys();
        }
        await this.restoreHistoryFromBackup();
        return true;
      })
      .catch((err) => {
        // Don't let one transient failure poison every later call: clear the
        // memo so the next caller retries from scratch.
        this.ensureReadyPromise = null;
        throw err;
      });
    return this.ensureReadyPromise;
  }

  async restoreFromBackup(password, username) {
    const pass = String(password || '').trim();
    if (!pass) throw new Error('Password is required');
    await this.initOlm();
    const user = (username || config.currentUser?.username || '').trim();
    const k = await this.deriveKek(pass, user);
    this.kek = k;
    await this.getOrCreateDeviceKey();

    const data = await api.getPrekeysBackup();
    if (!data || !data.backup) {
      throw new Error('No server key backup found for this account.');
    }

    try {
      const pickle = await this.decryptWithKek(data.backup, this.kek);
      this.account = new window.Olm.Account();
      this.account.unpickle(PICKLE_KEY, pickle);
      const keys = JSON.parse(this.account.identity_keys());
      this.myIdKeys = { curve25519: keys.curve25519, ed25519: keys.ed25519 };

      await this.saveAccount();
      await this.loadSelfSessions();
      await this.maybeReplenishPrekeys();
      return true;
    } catch (err) {
      throw new Error('Incorrect password or key backup could not be decrypted.');
    }
  }

  async createAndUploadBackup(password, username) {
    const pass = String(password || '').trim();
    if (!pass) throw new Error('Password is required');
    await this.initOlm();
    const user = (username || config.currentUser?.username || '').trim();
    const k = await this.deriveKek(pass, user);
    this.kek = k;
    if (!this.account) {
      await this.ensureReady();
    }
    const pickle = this.account.pickle(PICKLE_KEY);
    const enc = await this.encryptWithKek(pickle, this.kek);
    await api.publishPrekeys({
      identity_key: this.myIdKeys.curve25519,
      ed25519_key: this.myIdKeys.ed25519,
      fallback_key: null,
      one_time_keys: [],
      backup: enc,
    });
    return true;
  }

  async unlockWithPassword(password, username) {
    return this.restoreFromBackup(password, username);
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
    // Store the creation-state pickle STRING, never the session object: the
    // caller keeps ratcheting that same object, so an object reference would
    // silently alias the live session and the "baseline" would advance with it.
    const pickle = session.pickle(PICKLE_KEY);
    this.sessionBaselines[otherIdStr] = pickle;
    const enc = await this.encryptWithKd(pickle);
    await this.idbSet(STORE_OLM, `sessionBase:${otherIdStr}`, enc);
  }

  async loadSessionBaseline(otherIdStr) {
    let pickle = this.sessionBaselines[otherIdStr];
    if (!pickle) {
      const enc = await this.idbGet(STORE_OLM, `sessionBase:${otherIdStr}`);
      if (!enc) return null;
      try {
        pickle = await this.decryptWithKd(enc);
      } catch (e) {
        return null;
      }
      this.sessionBaselines[otherIdStr] = pickle;
    }
    // Always return a fresh unpickled session so replay never mutates the
    // cached snapshot.
    try {
      const s = new window.Olm.Session();
      s.unpickle(PICKLE_KEY, pickle);
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
    return this.withSelfLock(() => this.initSelfSessions());
  }

  async initSelfSessions() {
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

  async getOrCreateDeviceOutboundSession(otherIdStr, deviceId, identityKey, fallbackKey, otk) {
    const fullKey = `${otherIdStr}:${deviceId}`;
    if (this.sessions[fullKey]) return this.sessions[fullKey];
    const existing = await this.loadSession(fullKey);
    if (existing) return existing;

    const theirOtk = otk ? (typeof otk === 'object' ? otk.public_key : otk) : fallbackKey;
    if (!identityKey || !theirOtk) return null;

    const session = new window.Olm.Session();
    session.create_outbound(this.account, identityKey, theirOtk);

    await this.saveSessionBaseline(fullKey, session);
    await this.saveSession(fullKey, session);
    await this.idbSet(STORE_OLM, `sessionIdent:${fullKey}`, identityKey);
    return session;
  }

  // --- 1:1 Direct Message Encryption & Decryption ---

  async encryptDm(otherIdStr, otherUsername, plaintext) {
    return this.withPeerLock(otherIdStr, async () => {
      const myDevId = await this.getOrCreateDeviceId();
      const bundle = await api.getPeerBundle(otherUsername);
      let recipientDevices = bundle?.devices || [];
      const senderDevices = bundle?.sender_devices || [];

      if (!recipientDevices.length && bundle?.identity_key) {
        recipientDevices = [{
          device_id: 'default',
          identity_key: bundle.identity_key,
          ed25519_key: bundle.ed25519_key,
          one_time_key: bundle.one_time_key,
          fallback_key: bundle.fallback_key,
        }];
      }

      if (!recipientDevices.length) {
        throw new Error(`User @${otherUsername} has no encryption keys published.`);
      }

      const deviceCiphertexts = {};

      // 1. Encrypt for all recipient devices
      for (const dev of recipientDevices) {
        try {
          const sess = await this.getOrCreateDeviceOutboundSession(
            otherIdStr, dev.device_id, dev.identity_key, dev.fallback_key, dev.one_time_key
          );
          if (sess) {
            const enc = sess.encrypt(plaintext);
            deviceCiphertexts[dev.device_id] = { t: enc.type, b: enc.body };
            await this.saveSession(`${otherIdStr}:${dev.device_id}`, sess);
          }
        } catch (e) {
          console.warn(`Failed to encrypt for recipient device ${dev.device_id}`, e);
        }
      }

      // 2. Encrypt for sender's other devices
      const myUserId = String(config.currentUser?.id || '');
      for (const dev of senderDevices) {
        if (dev.device_id === myDevId) continue;
        try {
          const sess = await this.getOrCreateDeviceOutboundSession(
            myUserId, dev.device_id, dev.identity_key, dev.fallback_key, dev.one_time_key
          );
          if (sess) {
            const enc = sess.encrypt(plaintext);
            deviceCiphertexts[dev.device_id] = { t: enc.type, b: enc.body };
            await this.saveSession(`${myUserId}:${dev.device_id}`, sess);
          }
        } catch (e) {
          console.warn(`Failed to encrypt for sender device ${dev.device_id}`, e);
        }
      }

      // 3. Encrypt self-session for local storage and legacy fallback
      const selfEncrypted = await this.withSelfLock(async () => {
        await this.initSelfSessions();
        const enc = this.selfOutbound.encrypt(plaintext);
        await this.saveSelfSessions();
        return enc;
      });

      const primaryKey = recipientDevices[0]?.device_id || 'default';
      const primaryCipher = deviceCiphertexts[primaryKey] || Object.values(deviceCiphertexts)[0] || { t: 1, b: '' };

      const envelope = {
        v: 2,
        sender_device_id: myDevId,
        devices: deviceCiphertexts,
        t: primaryCipher.t,
        b: primaryCipher.b,
      };

      this.scheduleHistorySync();

      return {
        body: JSON.stringify(envelope),
        proto: 'olm',
        sender_ciphertext: JSON.stringify({ t: selfEncrypted.type, b: selfEncrypted.body }),
      };
    });
  }

  async decryptDm(msg, isOwn, otherIdStr, peerCurveKey) {
    if (!msg || !msg.body) return '';
    if (typeof msg.body === 'string' && msg.body.startsWith('/uploads/stickers/')) {
      return msg.body;
    }

    if (!this.account) {
      try { await this.ensureReady(); } catch (e) {}
    }

    const myDevId = await this.getOrCreateDeviceId();

    if (isOwn) {
      return this.withSelfLock(async () => {
        if (msg.body) {
          try {
            const env = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
            if (env && env.v === 2 && env.devices && env.devices[myDevId]) {
              const target = env.devices[myDevId];
              const myUserId = String(config.currentUser?.id || '');
              const senderDevId = env.sender_device_id || 'default';
              const devKey = `${myUserId}:${senderDevId}`;
              let live = await this.loadSession(devKey);
              if (!live) live = await this.loadSession(myUserId);
              if (live) {
                try {
                  const plain = live.decrypt(target.t, target.b);
                  await this.saveSession(devKey, live);
                  return plain;
                } catch (_) {}
              }
              const base = await this.loadSessionBaseline(devKey);
              if (base) {
                try {
                  const pBase = base.decrypt(target.t, target.b);
                  if (pBase) return pBase;
                } catch (_) {}
              }
              if (target.t === 0) {
                const s = new window.Olm.Session();
                try {
                  s.create_inbound(this.account, target.b);
                  this.account.remove_one_time_keys(s);
                  const pNew = s.decrypt(target.t, target.b);
                  await this.saveSession(devKey, s);
                  await this.saveAccount();
                  return pNew;
                } catch (_) {}
              }
            }
          } catch (_) {}
        }
        // Fallback to self-session
        const rawSelf = msg.sender_ciphertext || msg.body;
        try {
          await this.initSelfSessions();
          let selfEnv = typeof rawSelf === 'string' ? JSON.parse(rawSelf) : rawSelf;
          if (this.selfInbound && selfEnv && selfEnv.t !== undefined && selfEnv.b) {
            try { return this.selfInbound.decrypt(selfEnv.t, selfEnv.b); } catch (_) {}
          }
          if (this.selfInboundBaseline && selfEnv && selfEnv.t !== undefined && selfEnv.b) {
            try {
              const replay = new window.Olm.Session();
              replay.unpickle(PICKLE_KEY, this.selfInboundBaseline);
              return replay.decrypt(selfEnv.t, selfEnv.b);
            } catch (_) {}
          }
        } catch (_) {}
        return '[Unable to decrypt — encrypted for previous session]';
      });
    }

    // Incoming messages from peer:
    let env = null;
    if (typeof msg.body === 'object' && msg.body !== null) {
      env = msg.body;
    } else if (typeof msg.body === 'string') {
      try { env = JSON.parse(msg.body); } catch (_) { env = null; }
    }

    if (!env) {
      if (msg.proto && msg.proto !== 'olm') return msg.body;
      return typeof msg.body === 'string' ? msg.body : '';
    }

    let cipherToDecrypt = env;
    let senderDeviceId = 'default';

    if (env.v === 2 && env.devices) {
      senderDeviceId = env.sender_device_id || 'default';
      if (env.devices[myDevId]) {
        cipherToDecrypt = env.devices[myDevId];
      } else if (env.t !== undefined && env.b) {
        cipherToDecrypt = { t: env.t, b: env.b };
      } else {
        const devKeys = Object.keys(env.devices);
        if (devKeys.length) cipherToDecrypt = env.devices[devKeys[0]];
      }
    }

    if (!cipherToDecrypt || cipherToDecrypt.t === undefined || !cipherToDecrypt.b) {
      return typeof msg.body === 'string' ? msg.body : '';
    }

    const sessionKeyToUse = `${otherIdStr}:${senderDeviceId}`;

    return this.withPeerLock(sessionKeyToUse, async () => {
      let live = await this.loadSession(sessionKeyToUse);
      if (!live && otherIdStr) live = await this.loadSession(otherIdStr);

      if (live) {
        const livePickle = live.pickle(PICKLE_KEY);
        try {
          const plain = live.decrypt(cipherToDecrypt.t, cipherToDecrypt.b);
          try {
            await this.saveSession(sessionKeyToUse, live);
            if (otherIdStr) await this.saveSession(otherIdStr, live);
          } catch (e) {}
          return plain;
        } catch (e) {
          try {
            const restored = new window.Olm.Session();
            restored.unpickle(PICKLE_KEY, livePickle);
            this.sessions[sessionKeyToUse] = restored;
            if (otherIdStr) this.sessions[otherIdStr] = restored;
          } catch (e2) {}
        }
      }

      let base = await this.loadSessionBaseline(sessionKeyToUse);
      if (!base && otherIdStr) base = await this.loadSessionBaseline(otherIdStr);
      if (base) {
        try {
          const plain = base.decrypt(cipherToDecrypt.t, cipherToDecrypt.b);
          if (!live) {
            try {
              await this.saveSession(sessionKeyToUse, base);
              if (otherIdStr) await this.saveSession(otherIdStr, base);
            } catch (e) {}
          }
          return plain;
        } catch (e) {}
      }

      if (cipherToDecrypt.t === 0) {
        try {
          const fresh = new window.Olm.Session();
          fresh.create_inbound(this.account, cipherToDecrypt.b);
          this.account.remove_one_time_keys(fresh);
          this.schedulePrekeyReplenish();

          await this.saveSessionBaseline(sessionKeyToUse, fresh);
          if (otherIdStr) await this.saveSessionBaseline(otherIdStr, fresh);

          const plain = fresh.decrypt(cipherToDecrypt.t, cipherToDecrypt.b);
          await this.saveSession(sessionKeyToUse, fresh);
          if (otherIdStr) await this.saveSession(otherIdStr, fresh);
          await this.saveAccount();
          if (peerCurveKey) {
            await this.idbSet(STORE_OLM, `sessionIdent:${sessionKeyToUse}`, String(peerCurveKey));
            if (otherIdStr) await this.idbSet(STORE_OLM, `sessionIdent:${otherIdStr}`, String(peerCurveKey));
          }
          return plain;
        } catch (e) {
          this.schedulePrekeyReplenish();
          return '[Unable to decrypt — encrypted for previous session]';
        }
      }

      return '[Unable to decrypt — encrypted for previous session]';
    });
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
      this.scheduleHistorySync();
    });
    this.secureWriteQueues[otherIdStr] = next.catch(() => {});
    return next;
  }

  async secureDeleteMessage(otherIdStr, msgId) {
    const prev = this.secureWriteQueues[otherIdStr] || Promise.resolve();
    const next = prev.then(async () => {
      const msgs = await this.secureLoadMessages(otherIdStr);
      const filtered = msgs.filter((m) => String(m.id) !== String(msgId));
      const enc = await this.encryptWithKd(JSON.stringify(filtered));
      await this.idbSet(STORE_SECURE, `conv:${otherIdStr}`, enc);
      this.scheduleHistorySync();
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
    const idStr = String(recipientId);
    return this.withPeerLock(idStr, async () => {
      const sessKey = session.session_key();
      const session1to1 = await this.getOrCreateOutboundSession(idStr, recipientUsername);
      const enc = session1to1.encrypt(sessKey);
      await this.saveSession(idStr, session1to1);
      return JSON.stringify({ t: enc.type, b: enc.body });
    });
  }

  async syncRoomSessions(roomId, myId, members) {
    const others = members.filter((m) => Number(m.id) !== Number(myId));
    const allIds = members.map((m) => Number(m.id));

    // 1. Fetch & import pending Megolm keys for this room
    const pending = await api.getPendingRoomKeys(roomId);
    const deliveredIds = [];

    for (const k of pending) {
      if (String(k.room_id) === String(roomId) && String(k.sender_id) !== String(myId)) {
        const senderIdStr = String(k.sender_id);
        try {
          const sessionKey = await this.withPeerLock(senderIdStr, async () => {
            const env = JSON.parse(k.encrypted_key);
            if (env.t === 0) {
              const ns = new window.Olm.Session();
              ns.create_inbound(this.account, env.b);
              this.account.remove_one_time_keys(ns);
              this.schedulePrekeyReplenish();
              await this.saveSessionBaseline(senderIdStr, ns);
              const plain = ns.decrypt(env.t, env.b);
              await this.saveSession(senderIdStr, ns);
              await this.saveAccount();
              return plain;
            }
            const sess = await this.loadSession(senderIdStr);
            if (!sess) return null;
            const plain = sess.decrypt(env.t, env.b);
            await this.saveSession(senderIdStr, sess);
            return plain;
          });

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
    const lockKey = `out:${roomId}`;
    return this.withGroupLock(lockKey, async () => {
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
    });
  }

  async encryptRoomMessage(roomId, plaintext) {
    const lockKey = `out:${roomId}`;
    return this.withGroupLock(lockKey, async () => {
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
    });
  }

  async decryptRoomMessage(roomId, senderId, ciphertext, groupSessionId) {
    const key = `${roomId}:${senderId}:${groupSessionId}`;
    return this.withGroupLock(key, async () => {
      const ig = await this.loadGroupInbound(roomId, senderId, groupSessionId);
      if (!ig) {
        throw new Error('Missing inbound group session for sender');
      }
      const res = ig.decrypt(ciphertext);
      await this.saveGroupInbound(roomId, senderId, groupSessionId, ig);
      return res.plaintext;
    });
  }
}

export const cryptoEngine = new CryptoEngine();
