// Regression test for the introvert DM receive/decrypt path.
// Bundles the REAL src/core/crypto.js engine (stubbed api/config + fake
// IndexedDB) and replays the failure scenarios that produced
// "don't decrypt / EXTREMELY inconsistently decrypt":
//
//  1. Live-event shape: the websocket payload carries `from_id` (not
//     `sender_id`); keying sessions by the sender's real id is required.
//  2. Sequential in-order decrypt of a fresh PreKey chain (t=0 then t>0).
//  3. CONCURRENT decrypts of the same peer (the old Promise.all race) must
//     all succeed thanks to per-peer serialization.
//  4. History replay AFTER the live session ratcheted past a message
//     (baseline fallback must return the right plaintext).
//  5. Simulated app reload: sessions reloaded from storage still decrypt
//     old (baseline replay) and new (live) messages.
//  6. Sender-side session reset (new PreKey chain) heals the conversation.
//
// Run: node scripts/test-crypto-receive.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0;
let failed = 0;
let chain = Promise.resolve();
// Tests are sequential SCENARIOS sharing one session: run strictly in order.
function test(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✅ [PASS] ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ [FAIL] ${name}:`, e.message);
    }
  });
}
async function finish() {
  await chain;
  console.log(`\n========================================\nSummary: ${passed} passed, ${failed} failed.\n========================================`);
  if (failed > 0) process.exit(1);
}

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

// ---- Bridge: stub modules injectable before the engine bundle loads ----
const bridge = {
  api: {
    publishPrekeys: async (bundle) => {
      bridge.lastPrekeyBundle = bundle;
      return { ok: true, available: 5 };
    },
    getPrekeysCount: async () => ({ available: 100 }),
    getDevices: async () => [],
    getSafetyKeys: async () => null,
    getPeerBundle: async () => null,
    getPrekeysBackup: async () => ({ backup: null }),
    getPendingRoomKeys: async () => [],
    ackDeliveredRoomKeys: async () => {},
    getRoomSessionStatus: async () => null,
    publishRoomSession: async () => ({ session_id: '1' }),
    currentUserId: () => 1,
  },
  config: {
    currentUser: { id: 1, username: 'me' },
    serverUrl: 'https://example.invalid',
  },
  storage: {
    map: new Map(),
    get: async (key) => (bridge.storage.map.has(key) ? bridge.storage.map.get(key) : null),
    set: async (key, value) => { bridge.storage.map.set(key, value); },
    delete: async (key) => { bridge.storage.map.delete(key); },
  },
};

globalThis.__testBridge = bridge;
globalThis.indexedDB = new FakeIDB();

// crypto.js stubs for './api.js' and './config.js' (paths relative to src/core/crypto.js)
const plugin = {
  name: 'stub-modules',
  setup(build) {
    build.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
    build.onResolve({ filter: /^\.\/config\.js$/ }, () => ({ path: 'config-stub', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'api-stub') {
        return { contents: 'export const api = globalThis.__testBridge.api;', loader: 'js' };
      }
      return {
        contents:
          'export const config = globalThis.__testBridge.config;\n' +
          'export const storage = globalThis.__testBridge.storage;\n' +
          'export const OFFICIAL_CLIENT_ID = "x";\n' +
          'export const OFFICIAL_SERVER_URL = "https://example.invalid";',
        loader: 'js',
      };
    });
  },
};

const cryptoPath = path.join(__dirname, '../src/core/crypto.js');
const outfile = path.join(__dirname, '.crypto-engine-bundle.cjs');
await esbuild.build({
  entryPoints: [cryptoPath],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  plugins: [plugin],
  logLevel: 'silent',
});

const { cryptoEngine } = await import(outfile);
fs.rmSync(outfile, { force: true });

// ---- Load Olm (node environment FIRST: no globalThis.window yet) ----
const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });

// Now attach Olm to the (fake) window exactly like the browser app does.
// crypto.js calls window.Olm.init({ locateFile }); we are already initialized.
globalThis.window = globalThis;
window.Olm = Olm;
Olm.init = async () => Olm;

console.log('🧪 Introvert receive-path decryption regression tests\n');

// ---- Shared setup: receiver = real engine, sender = raw Olm peer ----
await cryptoEngine.ensureReady();
const receiverIdKeys = JSON.parse(cryptoEngine.account.identity_keys());
// ensureReady() published and marked the initial OTKs; take one from the
// bundle that was actually published (the sender claims it from the server).
const receiverOtkPub = bridge.lastPrekeyBundle.one_time_keys[0].public_key;

const senderAcct = new Olm.Account();
senderAcct.create();
senderAcct.generate_one_time_keys(10);
const senderIdKeys = JSON.parse(senderAcct.identity_keys());

let senderSession = new Olm.Session();
senderSession.create_outbound(senderAcct, receiverIdKeys.curve25519, receiverOtkPub);

const SENDER_ID = '101';
const makeMsg = (id, enc) => ({
  id,
  from_id: SENDER_ID, // websocket payload has from_id — NOT sender_id
  body: JSON.stringify({ t: enc.type, b: enc.body }),
  proto: 'olm',
});

const m1 = makeMsg('1', senderSession.encrypt('hello 1')); // t = 0 (PreKey)
const m2 = makeMsg('2', senderSession.encrypt('hello 2'));
const m3 = makeMsg('3', senderSession.encrypt('hello 3'));

test('fresh PreKey message (t=0) decrypts and persists the session', async () => {
  const plain = await cryptoEngine.decryptDm(m1, false, SENDER_ID, senderIdKeys.curve25519);
  if (plain !== 'hello 1') throw new Error(`got ${JSON.stringify(plain)}`);
  if (!cryptoEngine.sessions[SENDER_ID]) throw new Error('live session not cached');
  const stored = await cryptoEngine.idbGet('olm', `session:${SENDER_ID}`);
  if (!stored) throw new Error('live session not persisted to storage');
  const storedBase = await cryptoEngine.idbGet('olm', `sessionBase:${SENDER_ID}`);
  if (!storedBase) throw new Error('baseline session not persisted');
});

test('follow-up messages (t>0) decrypt in order', async () => {
  const p2 = await cryptoEngine.decryptDm(m2, false, SENDER_ID, senderIdKeys.curve25519);
  if (p2 !== 'hello 2') throw new Error(`got ${JSON.stringify(p2)}`);
  const p3 = await cryptoEngine.decryptDm(m3, false, SENDER_ID, senderIdKeys.curve25519);
  if (p3 !== 'hello 3') throw new Error(`got ${JSON.stringify(p3)}`);
});

const m4 = makeMsg('4', senderSession.encrypt('hello 4'));
const m5 = makeMsg('5', senderSession.encrypt('hello 5'));
const m6 = makeMsg('6', senderSession.encrypt('hello 6'));

test('CONCURRENT decrypts (old Promise.all race) all succeed', async () => {
  const [p4, p5, p6] = await Promise.all([
    cryptoEngine.decryptDm(m4, false, SENDER_ID, senderIdKeys.curve25519),
    cryptoEngine.decryptDm(m5, false, SENDER_ID, senderIdKeys.curve25519),
    cryptoEngine.decryptDm(m6, false, SENDER_ID, senderIdKeys.curve25519),
  ]);
  if (p4 !== 'hello 4' || p5 !== 'hello 5' || p6 !== 'hello 6') {
    throw new Error(`got ${JSON.stringify([p4, p5, p6])}`);
  }
});

test('history replay AFTER the live ratchet passed the message (baseline fallback)', async () => {
  // Live session is now past hello 1..6; re-decrypting old history must go
  // through the baseline and must NOT corrupt the live session.
  const livePickleBefore = await cryptoEngine.idbGet('olm', `session:${SENDER_ID}`);
  const p1 = await cryptoEngine.decryptDm(m1, false, SENDER_ID, senderIdKeys.curve25519);
  if (p1 !== 'hello 1') throw new Error(`got ${JSON.stringify(p1)}`);
  const p3 = await cryptoEngine.decryptDm(m3, false, SENDER_ID, senderIdKeys.curve25519);
  if (p3 !== 'hello 3') throw new Error(`got ${JSON.stringify(p3)}`);
  const livePickleAfter = await cryptoEngine.idbGet('olm', `session:${SENDER_ID}`);
  if (livePickleBefore !== livePickleAfter) throw new Error('baseline replay overwrote the live session');
});

const m7 = makeMsg('7', senderSession.encrypt('hello 7'));

test('new live message still decrypts after replay churn', async () => {
  const p7 = await cryptoEngine.decryptDm(m7, false, SENDER_ID, senderIdKeys.curve25519);
  if (p7 !== 'hello 7') throw new Error(`got ${JSON.stringify(p7)}`);
});

test('simulated app reload: sessions from storage still decrypt', async () => {
  // Drop all in-memory state (like a fresh page load) — storage must suffice.
  cryptoEngine.sessions = {};
  cryptoEngine.sessionBaselines = {};
  const m8 = makeMsg('8', senderSession.encrypt('hello 8'));
  const p8 = await cryptoEngine.decryptDm(m8, false, SENDER_ID, senderIdKeys.curve25519);
  if (p8 !== 'hello 8') throw new Error(`got ${JSON.stringify(p8)}`);
  // Old history still replays from the stored baseline after reload.
  const p2 = await cryptoEngine.decryptDm(m2, false, SENDER_ID, senderIdKeys.curve25519);
  if (p2 !== 'hello 2') throw new Error(`got ${JSON.stringify(p2)}`);
});

test('sender-side session reset (new PreKey chain) heals the conversation', async () => {
  // The initial pool is published/consumed; the fallback key covers new chains.
  const fallback = JSON.parse(cryptoEngine.account.fallback_key());
  const otk2 = Object.values(fallback.curve25519)[0];
  const fresh = new Olm.Session();
  fresh.create_outbound(senderAcct, receiverIdKeys.curve25519, otk2);
  const n1 = makeMsg('n1', fresh.encrypt('new 1'));
  const pN1 = await cryptoEngine.decryptDm(n1, false, SENDER_ID, senderIdKeys.curve25519);
  if (pN1 !== 'new 1') throw new Error(`got ${JSON.stringify(pN1)}`);
  const n2 = makeMsg('n2', fresh.encrypt('new 2'));
  const pN2 = await cryptoEngine.decryptDm(n2, false, SENDER_ID, senderIdKeys.curve25519);
  if (pN2 !== 'new 2') throw new Error(`got ${JSON.stringify(pN2)}`);
  // The baseline now belongs to the new chain, so old-chain history fails
  // cleanly with a placeholder (the UI serves already-decrypted history from
  // the local plaintext cache). Note: until a sender receives a reply, Olm
  // marks every message type 0 — the consumed prekey means create_inbound
  // can't re-derive the old chain, which is exactly the expected outcome.
  const oldPlain = await cryptoEngine.decryptDm(m7, false, SENDER_ID, senderIdKeys.curve25519);
  if (oldPlain !== '[Unable to decrypt — encrypted for previous session]') {
    throw new Error(`expected clean failure, got ${JSON.stringify(oldPlain)}`);
  }
});

test('unknown-sender envelope fails cleanly (no crash, placeholder text)', async () => {
  const ghost = { id: 'g1', from_id: '999', body: JSON.stringify({ t: 1, b: m2.body.slice(5) + 'AA' }), proto: 'olm' };
  const plain = await cryptoEngine.decryptDm(ghost, false, '999', 'curve');
  if (typeof plain !== 'string' || !plain.startsWith('[Unable to decrypt')) {
    throw new Error(`expected placeholder, got ${JSON.stringify(plain)}`);
  }
});

await finish();
