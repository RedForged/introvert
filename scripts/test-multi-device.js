// Verification test for Multi-Device Olm Fan-out & Decryption in Introvert

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Fake IndexedDB (mirrors the browser API surface crypto.js uses) ----
class FakeIDB {
  constructor() {
    this.stores = new Map(); // storeName -> Map(key -> value)
  }
  open(name, version) {
    const self = this;
    const req = {
      result: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      const db = {
        objectStoreNames: {
          contains: (n) => self.stores.has(n),
        },
        createObjectStore: (n) => {
          if (!self.stores.has(n)) self.stores.set(n, new Map());
        },
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

globalThis.indexedDB = new FakeIDB();

const bridge = {
  api: {
    publishPrekeys: async (bundle) => { bridge.publishedBundle = bundle; return { ok: true }; },
    getPrekeysCount: async () => ({ available: 10 }),
    getPeerBundle: async () => bridge.mockPeerBundle,
    getHistoryBackup: async () => ({ backup_data: null }),
    uploadHistoryBackup: async () => ({ ok: true })
  },
  config: { currentUser: { id: 10, username: 'introvert_user' }, serverUrl: 'http://localhost' },
  storage: { map: new Map(), get: async (k) => bridge.storage.map.get(k) || null, set: async (k, v) => { bridge.storage.map.set(k, v); } }
};

globalThis.__testBridge = bridge;

const plugin = {
  name: 'stub-modules',
  setup(build) {
    build.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
    build.onResolve({ filter: /^\.\/config\.js$/ }, () => ({ path: 'config-stub', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'api-stub') return { contents: 'export const api = globalThis.__testBridge.api;', loader: 'js' };
      return { contents: 'export const config = globalThis.__testBridge.config;\nexport const storage = globalThis.__testBridge.storage;', loader: 'js' };
    });
  }
};

const cryptoPath = path.join(__dirname, '../src/core/crypto.js');
const outfile = path.join(__dirname, '.multi-dev-bundle.cjs');
await esbuild.build({
  entryPoints: [cryptoPath],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  plugins: [plugin],
  logLevel: 'silent'
});

const { cryptoEngine } = await import(outfile);
fs.rmSync(outfile, { force: true });

const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });
globalThis.window = globalThis;
window.Olm = Olm;
Olm.init = async () => Olm;

async function run() {
  console.log('🧪 Running Introvert Multi-Device Fan-out & Inbound Decryption Tests\n');

  await cryptoEngine.ensureReady();
  const myDeviceId = await cryptoEngine.getOrCreateDeviceId();
  assert.ok(myDeviceId.startsWith('dev_'), 'DeviceId must have dev_ prefix');
  assert.ok(bridge.publishedBundle.device_id === myDeviceId, 'Published bundle must contain device_id');

  // Simulate Extrovert Web Bob with 2 devices
  const bobDev1 = new Olm.Account(); bobDev1.create(); bobDev1.generate_one_time_keys(5);
  const bobDev2 = new Olm.Account(); bobDev2.create(); bobDev2.generate_one_time_keys(5);

  const bobDev1Keys = JSON.parse(bobDev1.identity_keys());
  const bobDev2Keys = JSON.parse(bobDev2.identity_keys());
  const bobDev1Otks = JSON.parse(bobDev1.one_time_keys());
  const bobDev2Otks = JSON.parse(bobDev2.one_time_keys());

  bridge.mockPeerBundle = {
    devices: [
      { device_id: 'bob_desktop', identity_key: bobDev1Keys.curve25519, one_time_key: { public_key: Object.values(bobDev1Otks.curve25519)[0] } },
      { device_id: 'bob_phone', identity_key: bobDev2Keys.curve25519, one_time_key: { public_key: Object.values(bobDev2Otks.curve25519)[0] } }
    ],
    sender_devices: []
  };

  // 1. Introvert sends fan-out DM to Bob
  const plainText = 'Hello from Introvert multi-device client!';
  const dmPayload = await cryptoEngine.encryptDm('20', 'bob', plainText);
  const envelope = JSON.parse(dmPayload.body);

  assert.strictEqual(envelope.v, 2, 'Must use v2 envelope');
  assert.strictEqual(envelope.sender_device_id, myDeviceId, 'Must include sender_device_id');
  assert.ok(envelope.devices['bob_desktop'], 'Must encrypt for bob_desktop');
  assert.ok(envelope.devices['bob_phone'], 'Must encrypt for bob_phone');

  // Bob Desktop decrypts
  const bobDev1Sess = new Olm.Session();
  bobDev1Sess.create_inbound(bobDev1, envelope.devices['bob_desktop'].b);
  const bob1Decrypted = bobDev1Sess.decrypt(envelope.devices['bob_desktop'].t, envelope.devices['bob_desktop'].b);
  assert.strictEqual(bob1Decrypted, plainText, 'Bob desktop must decrypt Introvert message');

  // Bob Phone decrypts
  const bobDev2Sess = new Olm.Session();
  bobDev2Sess.create_inbound(bobDev2, envelope.devices['bob_phone'].b);
  const bob2Decrypted = bobDev2Sess.decrypt(envelope.devices['bob_phone'].t, envelope.devices['bob_phone'].b);
  assert.strictEqual(bob2Decrypted, plainText, 'Bob phone must decrypt Introvert message');

  console.log('  ✅ [PASS] Introvert fan-out encrypts across multiple recipient devices');

  // 2. Bob Desktop replies to Introvert in v2 format
  const replyPlain = 'Reply from Extrovert Web to Introvert!';
  const replyEnc = bobDev1Sess.encrypt(replyPlain);
  const bobReplyMsg = {
    id: 1001,
    from_id: '20',
    body: JSON.stringify({
      v: 2,
      sender_device_id: 'bob_desktop',
      devices: {
        [myDeviceId]: { t: replyEnc.type, b: replyEnc.body }
      }
    }),
    proto: 'olm'
  };

  const introvertDecrypted = await cryptoEngine.decryptDm(bobReplyMsg, false, '20', bobDev1Keys.curve25519);
  assert.strictEqual(introvertDecrypted, replyPlain, 'Introvert must decrypt v2 multi-device message');
  console.log('  ✅ [PASS] Introvert decrypts v2 multi-device message from Extrovert Web');

  console.log('\n========================================\nSummary: All Multi-Device tests passed!\n========================================');
}

run().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
