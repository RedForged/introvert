import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });

console.log('--- Testing Dual-Session Architecture (Separate Outbound / Inbound) ---');

// Device 1 (Mac)
const mac = new Olm.Account();
mac.create();
mac.generate_one_time_keys(10);
const macKeys = JSON.parse(mac.identity_keys());
const macOtks = JSON.parse(mac.one_time_keys());
const macOtk1 = Object.values(macOtks.curve25519)[0];

// Device 2 (Android)
const android = new Olm.Account();
android.create();
android.generate_one_time_keys(10);
const androidKeys = JSON.parse(android.identity_keys());
const androidOtks = JSON.parse(android.one_time_keys());
const androidOtk1 = Object.values(androidOtks.curve25519)[0];

// Client class with separate outbound & inbound session tracking
class Client {
  constructor(name, account, myDevId, myUserId) {
    this.name = name;
    this.account = account;
    this.myDevId = myDevId;
    this.myUserId = myUserId;
    this.outboundSessions = new Map(); // key -> Session (for encrypting)
    this.inboundSessions = new Map();  // key -> Session (for decrypting)
  }

  getOrCreateOutbound(targetUserId, targetDevId, targetIdent, targetOtk) {
    const key = `${targetUserId}:${targetDevId}`;
    if (this.outboundSessions.has(key)) return this.outboundSessions.get(key);
    const s = new Olm.Session();
    s.create_outbound(this.account, targetIdent, targetOtk);
    this.outboundSessions.set(key, s);
    return s;
  }

  encryptFor(targetUserId, targetDevId, targetIdent, targetOtk, text) {
    const s = this.getOrCreateOutbound(targetUserId, targetDevId, targetIdent, targetOtk);
    const enc = s.encrypt(text);
    return { t: enc.type, b: enc.body };
  }

  decryptFrom(senderUserId, senderDevId, cipher) {
    const key = `${senderUserId}:${senderDevId}`;
    
    // 1. Try existing inbound session
    const inSess = this.inboundSessions.get(key);
    if (inSess) {
      try {
        return inSess.decrypt(cipher.t, cipher.b);
      } catch (_) {}
    }

    // 2. Try outbound session (in case peer replied along our ratchet)
    const outSess = this.outboundSessions.get(key);
    if (outSess) {
      try {
        return outSess.decrypt(cipher.t, cipher.b);
      } catch (_) {}
    }

    // 3. Create fresh inbound session if type 0
    if (cipher.t === 0 || cipher.t === 2) {
      const fresh = new Olm.Session();
      fresh.create_inbound(this.account, cipher.b);
      this.account.remove_one_time_keys(fresh);
      const plain = fresh.decrypt(cipher.t, cipher.b);
      this.inboundSessions.set(key, fresh);
      return plain;
    }

    throw new Error('Unable to decrypt');
  }
}

const macClient = new Client('Mac', mac, 'dev_mac', '15');
const androidClient = new Client('Android', android, 'dev_android', '15');

// Step 1: Mac sends M1 to Admin (fan-out to Android)
console.log('1. Mac sends M1 to Android');
const m1 = macClient.encryptFor('15', 'dev_android', androidKeys.curve25519, androidOtk1, 'M1: Hello from Mac');
console.log('   M1 cipher type:', m1.t);

// Step 2: Android sends M2 to Admin (fan-out to Mac) BEFORE receiving M1
console.log('2. Android sends M2 to Mac (before receiving M1)');
const m2 = androidClient.encryptFor('15', 'dev_mac', macKeys.curve25519, macOtk1, 'M2: Hello from Android');
console.log('   M2 cipher type:', m2.t);

// Step 3: Android receives M1
console.log('3. Android receives M1 from Mac:');
const p1 = androidClient.decryptFrom('15', 'dev_mac', m1);
console.log('   ✅ Android decrypted M1:', p1);

// Step 4: Mac receives M2
console.log('4. Mac receives M2 from Android:');
const p2 = macClient.decryptFrom('15', 'dev_android', m2);
console.log('   ✅ Mac decrypted M2:', p2);

// Step 5: Android sends M3 (type 1 follow-up)
console.log('5. Android sends M3 to Mac (follow-up)');
const m3 = androidClient.encryptFor('15', 'dev_mac', macKeys.curve25519, null, 'M3: Android second message');
console.log('   M3 cipher type:', m3.t);

// Step 6: Mac receives M3
console.log('6. Mac receives M3:');
const p3 = macClient.decryptFrom('15', 'dev_android', m3);
console.log('   ✅ Mac decrypted M3:', p3);

// Step 7: Mac sends M4 (type 1 follow-up)
console.log('7. Mac sends M4 to Android (follow-up)');
const m4 = macClient.encryptFor('15', 'dev_android', androidKeys.curve25519, null, 'M4: Mac second message');
console.log('   M4 cipher type:', m4.t);

// Step 8: Android receives M4
console.log('8. Android receives M4:');
const p4 = androidClient.decryptFrom('15', 'dev_mac', m4);
console.log('   ✅ Android decrypted M4:', p4);

// Step 9: Multiple further exchanges
for (let i = 5; i <= 10; i++) {
  const isMac = i % 2 === 1;
  const sender = isMac ? macClient : androidClient;
  const receiver = isMac ? androidClient : macClient;
  const text = `Message ${i} from ${sender.name}`;
  const cipher = sender.encryptFor('15', receiver.myDevId, null, null, text);
  const plain = receiver.decryptFrom('15', sender.myDevId, cipher);
  console.log(`   ✅ ${receiver.name} decrypted M${i}: "${plain}"`);
}

console.log('\n🎉 PERFECT BI-DIRECTIONAL MULTI-DEVICE DOUBLE RATCHET SUCCESS!');
