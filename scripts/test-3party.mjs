import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });

console.log('--- Comprehensive 3-Party Multi-Device Olm Interoperability Test ---');

class MockDevice {
  constructor(name, userId, devId) {
    this.name = name;
    this.userId = userId;
    this.devId = devId;
    this.account = new Olm.Account();
    this.account.create();
    this.account.generate_one_time_keys(20);
    this.outbound = new Map();
    this.inbound = new Map();
    this.inboundBase = new Map();
  }

  getBundle() {
    const idKeys = JSON.parse(this.account.identity_keys());
    const otks = JSON.parse(this.account.one_time_keys());
    const otkIds = Object.keys(otks.curve25519);
    const otk = otkIds.length ? otks.curve25519[otkIds[0]] : null;
    return {
      device_id: this.devId,
      identity_key: idKeys.curve25519,
      ed25519_key: idKeys.ed25519,
      one_time_key: otk ? { id: otkIds[0], public_key: otk } : null,
      fallback_key: idKeys.curve25519,
    };
  }

  fetchFreshBundleFor(targetDev) {
    return targetDev.getBundle();
  }

  encryptForDevices(targetUserId, devices, plaintext) {
    const deviceCiphers = {};
    for (const dev of devices) {
      if (dev.device_id === this.devId) continue;
      const key = `${targetUserId}:${dev.device_id}`;
      let s = this.outbound.get(key);
      if (!s) {
        s = new Olm.Session();
        const otk = dev.one_time_key ? dev.one_time_key.public_key : dev.fallback_key;
        s.create_outbound(this.account, dev.identity_key, otk);
        this.outbound.set(key, s);
      }
      const enc = s.encrypt(plaintext);
      deviceCiphers[dev.device_id] = { t: enc.type, b: enc.body };
    }
    return {
      v: 2,
      sender_device_id: this.devId,
      devices: deviceCiphers,
    };
  }

  decryptMessage(senderUserId, envelope, isOwn) {
    const senderDevId = envelope.sender_device_id;
    const cipher = envelope.devices[this.devId];
    if (!cipher) throw new Error(`${this.name}: No cipher for ${this.devId}`);
    const key = `${senderUserId}:${senderDevId}`;

    // 1. Inbound live
    const inLive = this.inbound.get(key);
    if (inLive) {
      try {
        return inLive.decrypt(cipher.t, cipher.b);
      } catch (_) {}
    }

    // 2. Inbound baseline
    const inBase = this.inboundBase.get(key);
    if (inBase) {
      try {
        const replay = new Olm.Session();
        replay.unpickle('key', inBase);
        return replay.decrypt(cipher.t, cipher.b);
      } catch (_) {}
    }

    // 3. Outbound live
    const outLive = this.outbound.get(key);
    if (outLive) {
      try {
        return outLive.decrypt(cipher.t, cipher.b);
      } catch (_) {}
    }

    // 4. Create fresh inbound
    if (cipher.t === 0 || cipher.t === 2) {
      const fresh = new Olm.Session();
      fresh.create_inbound(this.account, cipher.b);
      this.account.remove_one_time_keys(fresh);
      this.inboundBase.set(key, fresh.pickle('key'));
      const plain = fresh.decrypt(cipher.t, cipher.b);
      this.inbound.set(key, fresh);
      return plain;
    }

    throw new Error(`${this.name}: Failed to decrypt from ${key}`);
  }
}

// Setup:
// User 15 (Kapitalpirat): Mac & Android
// User 9 (Admin): Web
const mac = new MockDevice('Mac', '15', 'dev_mac');
const android = new MockDevice('Android', '15', 'dev_android');
const web = new MockDevice('Web', '9', 'dev_web');

function getKapitalpiratBundles() {
  return [mac.getBundle(), android.getBundle()];
}
function getAdminBundles() {
  return [web.getBundle()];
}

// Step 1: Mac sends to Admin (fan-out to Admin Web and own Android)
console.log('1. Mac sends Msg 1 to Admin');
const env1 = mac.encryptForDevices('9', getAdminBundles(), 'Hello Admin from Mac');
Object.assign(env1.devices, mac.encryptForDevices('15', getKapitalpiratBundles(), 'Hello Admin from Mac').devices);

console.log('   Web receives Msg 1:', web.decryptMessage('15', env1, false));
console.log('   Android receives Msg 1:', android.decryptMessage('15', env1, true));

// Step 2: Android sends to Admin (fan-out to Admin Web and own Mac)
console.log('\n2. Android sends Msg 2 to Admin');
const env2 = android.encryptForDevices('9', getAdminBundles(), 'Hello Admin from Android');
Object.assign(env2.devices, android.encryptForDevices('15', getKapitalpiratBundles(), 'Hello Admin from Android').devices);

console.log('   Web receives Msg 2:', web.decryptMessage('15', env2, false));
console.log('   Mac receives Msg 2:', mac.decryptMessage('15', env2, true));

// Step 3: Admin Web replies to Kapitalpirat (fan-out to Mac and Android)
console.log('\n3. Web replies Msg 3 to Kapitalpirat');
const env3 = web.encryptForDevices('15', getKapitalpiratBundles(), 'Hello from Web!');

console.log('   Mac receives Msg 3:', mac.decryptMessage('9', env3, false));
console.log('   Android receives Msg 3:', android.decryptMessage('9', env3, false));

// Step 4: 10 interleaved messages across all 3 devices
console.log('\n4. Running 10 interleaved multi-device rounds:');
for (let i = 4; i <= 13; i++) {
  const sender = (i % 3 === 0) ? mac : (i % 3 === 1) ? android : web;
  const isWebSender = sender === web;
  const text = `Message ${i} from ${sender.name}`;

  let env;
  if (isWebSender) {
    env = web.encryptForDevices('15', getKapitalpiratBundles(), text);
    const pMac = mac.decryptMessage('9', env, false);
    const pAndroid = android.decryptMessage('9', env, false);
    if (pMac !== text || pAndroid !== text) throw new Error(`Mismatch in round ${i}`);
  } else {
    env = sender.encryptForDevices('9', getAdminBundles(), text);
    Object.assign(env.devices, sender.encryptForDevices('15', getKapitalpiratBundles(), text).devices);
    const pWeb = web.decryptMessage('15', env, false);
    const peerSelf = sender === mac ? android : mac;
    const pSelf = peerSelf.decryptMessage('15', env, true);
    if (pWeb !== text || pSelf !== text) throw new Error(`Mismatch in round ${i}`);
  }
  console.log(`   ✅ Round ${i} (${sender.name}) verified on all destinations`);
}

console.log('\n🎉 ALL MULTI-DEVICE 3-PARTY DOUBLE RATCHET TESTS PASSED 100%!');
