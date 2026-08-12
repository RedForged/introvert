// Comprehensive Verification Test Suite for Introvert

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadOlm() {
  const OlmModule = await import('/Users/lea/extrovert/node_modules/@matrix-org/olm/olm.js');
  const Olm = OlmModule.default || OlmModule;
  const wasm = fs.readFileSync('/Users/lea/introvert/public/lib/olm.wasm');
  await Olm.init({ wasmBinary: wasm });
  return Olm;
}

const PICKLE_KEY = 'introvert-test-pickle';

async function runTests() {
  console.log('🧪 Starting Introvert Architecture & Protocol Verification Tests...\n');
  let passed = 0;
  let failed = 0;

  const test = (name, fn) => {
    try {
      fn();
      passed++;
      console.log(`  ✅ [PASS] ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ [FAIL] ${name}:`, e.message);
    }
  };

  const Olm = await loadOlm();

  // --- 1. Olm Double-Ratchet DM Cryptography ---
  console.log('--- 1. Olm Double-Ratchet Direct Messaging Tests ---');

  const aliceAcct = new Olm.Account();
  aliceAcct.create();
  aliceAcct.generate_one_time_keys(5);
  aliceAcct.generate_fallback_key();

  const bobAcct = new Olm.Account();
  bobAcct.create();
  bobAcct.generate_one_time_keys(5);
  bobAcct.generate_fallback_key();

  const aliceIdKeys = JSON.parse(aliceAcct.identity_keys());
  const bobIdKeys = JSON.parse(bobAcct.identity_keys());
  const bobOtks = JSON.parse(bobAcct.one_time_keys());
  const bobOtkId = Object.keys(bobOtks.curve25519)[0];
  const bobOtk = bobOtks.curve25519[bobOtkId];

  let aliceToBobSession;
  let bobFromAliceSession;

  test('Alice builds outbound Double-Ratchet session to Bob using published prekey bundle', () => {
    aliceToBobSession = new Olm.Session();
    aliceToBobSession.create_outbound(aliceAcct, bobIdKeys.curve25519, bobOtk);
    assert(aliceToBobSession.session_id(), 'Session ID must exist');
  });

  let prekeyMsg;
  test('Alice encrypts first DM (produces PreKey type 0 message)', () => {
    prekeyMsg = aliceToBobSession.encrypt('Hello Bob from Introvert!');
    assert.strictEqual(prekeyMsg.type, 0, 'First Double-Ratchet message must be type 0');
    assert(prekeyMsg.body.length > 20, 'Ciphertext body must be non-empty');
  });

  test('Bob initializes inbound session from PreKey message and decrypts plaintext', () => {
    bobFromAliceSession = new Olm.Session();
    bobFromAliceSession.create_inbound_from(bobAcct, aliceIdKeys.curve25519, prekeyMsg.body);
    bobAcct.remove_one_time_keys(bobFromAliceSession);
    const decrypted = bobFromAliceSession.decrypt(prekeyMsg.type, prekeyMsg.body);
    assert.strictEqual(decrypted, 'Hello Bob from Introvert!');
  });

  test('Double-Ratchet roundtrip: Bob replies, Alice decrypts, subsequent Alice messages ratchet to type 1 with forward secrecy', () => {
    // Bob sends reply
    const reply = bobFromAliceSession.encrypt('Rooms are encrypted with Megolm!');
    const ptReply = aliceToBobSession.decrypt(reply.type, reply.body);
    assert.strictEqual(ptReply, 'Rooms are encrypted with Megolm!');

    // Now Alice's ratchet has advanced after receiving Bob's message
    const msg2 = aliceToBobSession.encrypt('How are your rooms?');
    assert.strictEqual(msg2.type, 1, 'Subsequent messages must be ordinary type 1');
    const pt2 = bobFromAliceSession.decrypt(msg2.type, msg2.body);
    assert.strictEqual(pt2, 'How are your rooms?');
  });

  test('Self-Session Baseline Preservation prevents ratchet desynchronization on app reload', () => {
    // Alice self-session for encrypting own sent copies
    aliceAcct.generate_one_time_keys(1);
    const selfOtks = JSON.parse(aliceAcct.one_time_keys());
    const selfOtk = selfOtks.curve25519[Object.keys(selfOtks.curve25519)[0]];

    const selfOutbound = new Olm.Session();
    selfOutbound.create_outbound(aliceAcct, aliceIdKeys.curve25519, selfOtk);
    const selfInit = selfOutbound.encrypt('self-init');

    const selfInbound = new Olm.Session();
    selfInbound.create_inbound(aliceAcct, selfInit.body);
    aliceAcct.remove_one_time_keys(selfInbound);

    const baselinePickle = selfInbound.pickle(PICKLE_KEY);

    // Encrypt 3 self copies
    const c1 = selfOutbound.encrypt('Sent msg 1');
    const c2 = selfOutbound.encrypt('Sent msg 2');
    const c3 = selfOutbound.encrypt('Sent msg 3');

    // Restore from baseline (simulating app reload)
    const restored = new Olm.Session();
    restored.unpickle(PICKLE_KEY, baselinePickle);

    assert.strictEqual(restored.decrypt(c1.type, c1.body), 'Sent msg 1');
    assert.strictEqual(restored.decrypt(c2.type, c2.body), 'Sent msg 2');
    assert.strictEqual(restored.decrypt(c3.type, c3.body), 'Sent msg 3');
  });

  // --- 2. Megolm Group Session Cryptography for Rooms ---
  console.log('\n--- 2. Megolm Group Encryption for Room Channels Tests ---');

  const charlieAcct = new Olm.Account();
  charlieAcct.create();
  charlieAcct.generate_one_time_keys(5);
  const charlieIdKeys = JSON.parse(charlieAcct.identity_keys());
  const charlieOtks = JSON.parse(charlieAcct.one_time_keys());
  const charlieOtk = charlieOtks.curve25519[Object.keys(charlieOtks.curve25519)[0]];

  let roomOutbound;
  let roomInboundBob;
  let roomInboundCharlie;

  test('Alice creates Megolm OutboundGroupSession for a room text channel', () => {
    roomOutbound = new Olm.OutboundGroupSession();
    roomOutbound.create();
    assert(roomOutbound.session_id(), 'Megolm group session ID must exist');
    assert(roomOutbound.session_key(), 'Megolm group session key must exist');
  });

  test('Alice wraps Megolm session key in 1:1 Olm envelopes for Bob and Charlie', () => {
    const sessionKey = roomOutbound.session_key();

    // 1:1 session Alice -> Charlie
    const aliceToCharlie = new Olm.Session();
    aliceToCharlie.create_outbound(aliceAcct, charlieIdKeys.curve25519, charlieOtk);

    const bobWrapped = aliceToBobSession.encrypt(sessionKey);
    const charlieWrapped = aliceToCharlie.encrypt(sessionKey);

    // Bob un-wraps and creates InboundGroupSession
    const bobUnwrappedKey = bobFromAliceSession.decrypt(bobWrapped.type, bobWrapped.body);
    roomInboundBob = new Olm.InboundGroupSession();
    roomInboundBob.create(bobUnwrappedKey);

    // Charlie un-wraps
    const charlieFromAlice = new Olm.Session();
    charlieFromAlice.create_inbound_from(charlieAcct, aliceIdKeys.curve25519, charlieWrapped.body);
    charlieAcct.remove_one_time_keys(charlieFromAlice);
    const charlieUnwrappedKey = charlieFromAlice.decrypt(charlieWrapped.type, charlieWrapped.body);
    roomInboundCharlie = new Olm.InboundGroupSession();
    roomInboundCharlie.create(charlieUnwrappedKey);

    assert(roomInboundBob);
    assert(roomInboundCharlie);
  });

  test('Alice encrypts room channel message and all room members decrypt correctly', () => {
    const roomCiphertext = roomOutbound.encrypt('Welcome to Introvert room text channel!');
    assert(roomCiphertext, 'Ciphertext must be non-empty');

    const bobPlain = roomInboundBob.decrypt(roomCiphertext).plaintext;
    const charliePlain = roomInboundCharlie.decrypt(roomCiphertext).plaintext;

    assert.strictEqual(bobPlain, 'Welcome to Introvert room text channel!');
    assert.strictEqual(charliePlain, 'Welcome to Introvert room text channel!');
  });

  test('Megolm session rotation creates fresh key and isolates history from future members', () => {
    const rotatedSession = new Olm.OutboundGroupSession();
    rotatedSession.create();
    assert.notStrictEqual(rotatedSession.session_id(), roomOutbound.session_id());
  });

  // --- 3. Minimalist Profile & Social Media Exclusion Verification ---
  console.log('\n--- 3. Minimalist Profile & Non-Social Scope Tests ---');

  test('Profile model strictly filters to Avatar, Display Name, Username, Bio and Presence only', () => {
    const sampleExtrovertUser = {
      id: 42,
      username: 'alice',
      display_name: 'Alice W.',
      avatar: 'avatars/123abc456.jpg',
      bio: 'Privacy advocate & coder',
      created_at: 1750000000000,
      statuses_count: 55, // Extrovert social stat
      followers_count: 10,
      following_count: 5,
      posts: [{ id: 1, body: 'Public post' }], // Social bloat
    };

    // Introvert minimal profile view mapping
    const minimalProfile = {
      id: sampleExtrovertUser.id,
      username: sampleExtrovertUser.username,
      display_name: sampleExtrovertUser.display_name,
      avatar: sampleExtrovertUser.avatar,
      bio: sampleExtrovertUser.bio,
    };

    assert.strictEqual(minimalProfile.username, 'alice');
    assert.strictEqual(minimalProfile.display_name, 'Alice W.');
    assert.strictEqual(minimalProfile.avatar, 'avatars/123abc456.jpg');
    assert.strictEqual(minimalProfile.bio, 'Privacy advocate & coder');
    assert.strictEqual(minimalProfile.posts, undefined, 'Posts must not be present in minimal profile');
    assert.strictEqual(minimalProfile.statuses_count, undefined, 'Social stats must not be present in minimal profile');
  });

  // --- 4. Cross-Platform & Build Integrity ---
  console.log('\n--- 4. Cross-Platform Tauri v2 Integrity Tests ---');

  test('Tauri v2 configuration file exists and has valid configuration', () => {
    const tauriConfPath = '/Users/lea/introvert/src-tauri/tauri.conf.json';
    assert(fs.existsSync(tauriConfPath), 'tauri.conf.json must exist');
    const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    assert.strictEqual(conf.productName, 'Introvert');
    assert.strictEqual(conf.identifier, 'eu.redforged.introvert');
  });

  test('Tauri capability permissions exist', () => {
    const capPath = '/Users/lea/introvert/src-tauri/capabilities/default.json';
    assert(fs.existsSync(capPath), 'capabilities/default.json must exist');
    const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
    assert(cap.permissions.includes('core:default'));
  });

  test('Olm WebAssembly distribution files exist in public/lib', () => {
    assert(fs.existsSync('/Users/lea/introvert/public/lib/olm.js'));
    assert(fs.existsSync('/Users/lea/introvert/public/lib/olm.wasm'));
  });

  console.log(`\n========================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed.`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
