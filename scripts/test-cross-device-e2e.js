// End-to-end regression test for Introvert Mac <-> Android <-> Web cross-device decryption

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FakeIDB {
  constructor() {
    this.stores = new Map();
  }
  open(name, version) {
    const self = this;
    const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: (n) => self.stores.has(n) },
        createObjectStore: (n) => { if (!self.stores.has(n)) self.stores.set(n, new Map()); },
        transaction: (n, mode) => {
          if (!self.stores.has(n)) self.stores.set(n, new Map());
          const store = self.stores.get(n);
          const tx = {
            objectStore: () => ({
              get: (key) => {
                const r = { result: undefined, onsuccess: null, onerror: null };
                queueMicrotask(() => { r.result = store.get(key); if (r.onsuccess) r.onsuccess(); });
                return r;
              },
              put: (value, key) => {
                const r = { result: undefined, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  store.set(key, value);
                  if (r.onsuccess) r.onsuccess();
                  if (tx.oncomplete) tx.oncomplete();
                });
                return r;
              },
              delete: (key) => {
                const r = { result: undefined, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  store.delete(key);
                  if (r.onsuccess) r.onsuccess();
                  if (tx.oncomplete) tx.oncomplete();
                });
                return r;
              },
            }),
            oncomplete: null,
            onerror: null,
          };
          return tx;
        },
      };
      req.result = db;
      if (!self.stores.has('cryptokeys') || !self.stores.has('olm') || !self.stores.has('securemsgs')) {
        if (req.onupgradeneeded) req.onupgradeneeded();
      }
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  }
}

const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });
globalThis.window = globalThis;
window.Olm = Olm;
Olm.init = async () => Olm;

async function createClientInstance(userId, username, deviceId) {
  const idb = new FakeIDB();
  const storageMap = new Map();
  const bridge = {
    api: {
      publishPrekeys: async (bundle) => {
        bridge.publishedBundle = bundle;
        return { ok: true };
      },
      getPrekeysCount: async () => ({ available: 10 }),
      getDevices: async () => [],
      getPeerBundle: async (peerUsername) => bridge.mockGetPeerBundle(peerUsername),
      getHistoryBackup: async () => ({ backup_data: null }),
      uploadHistoryBackup: async () => ({ ok: true }),
    },
    config: { currentUser: { id: userId, username }, serverUrl: 'http://localhost' },
    storage: {
      map: storageMap,
      get: async (k) => storageMap.get(k) || null,
      set: async (k, v) => { storageMap.set(k, v); },
      delete: async (k) => { storageMap.delete(k); },
    },
  };

  storageMap.set('cryptokeys:deviceId', deviceId);

  const plugin = {
    name: 'stub-modules-' + deviceId,
    setup(build) {
      build.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
      build.onResolve({ filter: /^\.\/config\.js$/ }, () => ({ path: 'config-stub', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
        if (args.path === 'api-stub') return { contents: 'export const api = globalThis.__testBridges["' + deviceId + '"].api;', loader: 'js' };
        return { contents: 'export const config = globalThis.__testBridges["' + deviceId + '"].config;\nexport const storage = globalThis.__testBridges["' + deviceId + '"].storage;', loader: 'js' };
      });
    }
  };

  if (!globalThis.__testBridges) globalThis.__testBridges = {};
  globalThis.__testBridges[deviceId] = bridge;

  const cryptoPath = path.join(__dirname, '../src/core/crypto.js');
  const outfile = path.join(__dirname, `.bundle-${deviceId}.cjs`);
  await esbuild.build({
    entryPoints: [cryptoPath],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    plugins: [plugin],
    logLevel: 'silent',
  });

  globalThis.indexedDB = idb;
  const mod = await import(outfile + '?t=' + Date.now());
  fs.rmSync(outfile, { force: true });
  const engine = mod.cryptoEngine;

  return { engine, bridge, idb, storageMap };
}

async function run() {
  console.log('🧪 Cross-Device Decryption E2E Verification');

  const mac = await createClientInstance(10, 'kapitalpirat', 'dev_mac');
  await mac.engine.ensureReady();
  const macPub = mac.bridge.publishedBundle;

  const android = await createClientInstance(10, 'kapitalpirat', 'dev_android');
  await android.engine.ensureReady();
  const androidPub = android.bridge.publishedBundle;

  const adminAcct = new Olm.Account();
  adminAcct.create();
  adminAcct.generate_one_time_keys(10);
  const adminKeys = JSON.parse(adminAcct.identity_keys());
  const adminOtks = JSON.parse(adminAcct.one_time_keys());

  let adminOtkIndex = 0;
  let macOtkIndex = 0;
  let androidOtkIndex = 0;

  const claimAdminOtk = () => {
    const list = Object.entries(adminOtks.curve25519);
    if (adminOtkIndex < list.length) {
      const [id, public_key] = list[adminOtkIndex++];
      return { id, public_key };
    }
    return null;
  };

  const claimMacOtk = () => {
    if (macOtkIndex < macPub.one_time_keys.length) {
      return macPub.one_time_keys[macOtkIndex++];
    }
    return null;
  };

  const claimAndroidOtk = () => {
    if (androidOtkIndex < androidPub.one_time_keys.length) {
      return androidPub.one_time_keys[androidOtkIndex++];
    }
    return null;
  };

  const getBundleFor = (requesterUsername, targetUsername) => {
    const recDevices = [];
    if (targetUsername === 'admin') {
      recDevices.push({
        device_id: 'admin_web',
        identity_key: adminKeys.curve25519,
        one_time_key: claimAdminOtk(),
        fallback_key: null,
      });
    } else if (targetUsername === 'kapitalpirat') {
      recDevices.push(
        { device_id: 'dev_mac', identity_key: macPub.identity_key, fallback_key: macPub.fallback_key, one_time_key: claimMacOtk() },
        { device_id: 'dev_android', identity_key: androidPub.identity_key, fallback_key: androidPub.fallback_key, one_time_key: claimAndroidOtk() }
      );
    }

    const senderDevices = [];
    if (requesterUsername === 'kapitalpirat') {
      senderDevices.push(
        { device_id: 'dev_mac', identity_key: macPub.identity_key, fallback_key: macPub.fallback_key, one_time_key: claimMacOtk() },
        { device_id: 'dev_android', identity_key: androidPub.identity_key, fallback_key: androidPub.fallback_key, one_time_key: claimAndroidOtk() }
      );
    }
    return { devices: recDevices, sender_devices: senderDevices };
  };

  mac.bridge.mockGetPeerBundle = (target) => getBundleFor('kapitalpirat', target);
  android.bridge.mockGetPeerBundle = (target) => getBundleFor('kapitalpirat', target);

  // 1. Mac sends 3 messages
  const macMessages = [];
  for (let i = 1; i <= 3; i++) {
    const text = `Message ${i} from Mac`;
    globalThis.indexedDB = mac.idb;
    const enc = await mac.engine.encryptDm('20', 'admin', text);
    macMessages.push({
      id: 100 + i,
      from_id: '10',
      to_id: '20',
      body: enc.body,
      sender_ciphertext: enc.sender_ciphertext,
      proto: 'olm',
      created_at: 1000 + i,
      expected: text,
    });
  }

  // 2. Admin Web decrypts Mac messages
  let adminWebSess = null;
  for (const m of macMessages) {
    const env = JSON.parse(m.body);
    const cipher = env.devices['admin_web'];
    if (!adminWebSess) {
      adminWebSess = new Olm.Session();
      adminWebSess.create_inbound(adminAcct, cipher.b);
    }
    const plain = adminWebSess.decrypt(cipher.t, cipher.b);
    assert.strictEqual(plain, m.expected);
  }
  console.log('  ✅ [PASS] Admin Web successfully decrypts all 3 Mac messages');

  // 3. Android Introvert decrypts Mac messages (isOwn = true)
  for (const m of macMessages) {
    globalThis.indexedDB = android.idb;
    const plain = await android.engine.decryptDm(m, true, '20', adminKeys.curve25519);
    assert.strictEqual(plain, m.expected);
  }
  console.log('  ✅ [PASS] Android Introvert successfully decrypts all 3 Mac messages');

  // 4. Android sends 2 messages to Admin
  const androidMessages = [];
  for (let i = 1; i <= 2; i++) {
    const text = `Message ${i} from Android`;
    globalThis.indexedDB = android.idb;
    const enc = await android.engine.encryptDm('20', 'admin', text);
    androidMessages.push({
      id: 200 + i,
      from_id: '10',
      to_id: '20',
      body: enc.body,
      sender_ciphertext: enc.sender_ciphertext,
      proto: 'olm',
      created_at: 2000 + i,
      expected: text,
    });
  }

  // 5. Admin Web decrypts Android messages
  let adminToAndroidSess = null;
  for (const m of androidMessages) {
    const env = JSON.parse(m.body);
    const cipher = env.devices['admin_web'];
    if (!adminToAndroidSess) {
      adminToAndroidSess = new Olm.Session();
      adminToAndroidSess.create_inbound(adminAcct, cipher.b);
    }
    const plain = adminToAndroidSess.decrypt(cipher.t, cipher.b);
    assert.strictEqual(plain, m.expected);
  }
  console.log('  ✅ [PASS] Admin Web successfully decrypts Android messages');

  // 6. Mac Introvert decrypts Android messages (isOwn = true)
  for (const m of androidMessages) {
    globalThis.indexedDB = mac.idb;
    const plain = await mac.engine.decryptDm(m, true, '20', adminKeys.curve25519);
    assert.strictEqual(plain, m.expected);
  }
  console.log('  ✅ [PASS] Mac Introvert successfully decrypts Android messages');

  console.log('\n========================================\nSummary: All Cross-Device tests passed!\n========================================');
}

run().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
