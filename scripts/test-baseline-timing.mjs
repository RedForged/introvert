import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });

console.log('--- Proving Baseline Saved BEFORE Decrypt vs AFTER Decrypt ---');

const acctA = new Olm.Account();
acctA.create();
acctA.generate_one_time_keys(1);
const aKeys = JSON.parse(acctA.identity_keys());
const aOtks = JSON.parse(acctA.one_time_keys());
const aOtk = Object.values(aOtks.curve25519)[0];

const acctB = new Olm.Account();
acctB.create();

// B sends message to A
const sB = new Olm.Session();
sB.create_outbound(acctB, aKeys.curve25519, aOtk);
const m0 = sB.encrypt('Message 0');
const m1 = sB.encrypt('Message 1');

// A receives m0
const sA = new Olm.Session();
sA.create_inbound(acctA, m0.body);
acctA.remove_one_time_keys(sA);

// Case 1: Baseline saved BEFORE decrypt
const baseBeforePickle = sA.pickle('key');
const p0 = sA.decrypt(m0.type, m0.body);
const p1 = sA.decrypt(m1.type, m1.body);
console.log('Live session decrypted m0:', p0, 'and m1:', p1);

// Now test replaying m0 and m1 on baseline saved BEFORE decrypt:
const replaySess = new Olm.Session();
replaySess.unpickle('key', baseBeforePickle);
try {
  const replay0 = replaySess.decrypt(m0.type, m0.body);
  console.log('✅ Replay session (saved BEFORE decrypt) decrypted m0:', replay0);
  const replay1 = replaySess.decrypt(m1.type, m1.body);
  console.log('✅ Replay session (saved BEFORE decrypt) decrypted m1:', replay1);
} catch (e) {
  console.log('❌ Replay failed:', e.message);
}

// Case 2: Baseline saved AFTER decrypt
const sA2 = new Olm.Session();
sA2.create_inbound(acctA, m0.body);
acctA.remove_one_time_keys(sA2);
sA2.decrypt(m0.type, m0.body);
const baseAfterPickle = sA2.pickle('key'); // SAVED AFTER DECRYPT

const replaySess2 = new Olm.Session();
replaySess2.unpickle('key', baseAfterPickle);
try {
  replaySess2.decrypt(m0.type, m0.body);
  console.log('Replay session (saved AFTER decrypt) decrypted m0');
} catch (e) {
  console.log('❌ Replay session (saved AFTER decrypt) FAILED on m0:', e.message);
}
