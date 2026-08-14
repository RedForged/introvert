import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });

console.log('--- Proving Outbound/Inbound Key Collision ---');

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

// Storage simulation for Mac and Android using single "devKey" for both in & out
const macSessions = {}; // devKey -> Session
const androidSessions = {}; // devKey -> Session

// 1. Android sends Message 1 to Mac
console.log('1. Android creates Outbound session to Mac and sends M1');
const androidToMacOut = new Olm.Session();
androidToMacOut.create_outbound(android, macKeys.curve25519, macOtk1);
androidSessions['15:dev_mac'] = androidToMacOut;
const m1Cipher = androidToMacOut.encrypt('M1 from Android');

// Mac receives M1
console.log('2. Mac receives M1 from Android (PreKey t=0)');
const macInFromAndroid = new Olm.Session();
macInFromAndroid.create_inbound(mac, m1Cipher.body);
mac.remove_one_time_keys(macInFromAndroid);
const m1Plain = macInFromAndroid.decrypt(m1Cipher.type, m1Cipher.body);
console.log('   Mac decrypted M1:', m1Plain);
macSessions['15:dev_android'] = macInFromAndroid; // Mac stores INBOUND session at '15:dev_android'

// 3. Mac sends Message 2 to Android
console.log('3. Mac sends M2 to Android');
// Mac checks macSessions['15:dev_android']:
let macOut = macSessions['15:dev_android'];
console.log('   Mac loaded session for 15:dev_android. Is it the inbound session?', macOut === macInFromAndroid);
// If Mac reuses macOut (which was created as INBOUND from Android):
const m2Cipher = macOut.encrypt('M2 from Mac');
console.log('   M2 cipher type:', m2Cipher.type); // type 1

// Android receives M2
console.log('4. Android receives M2 from Mac');
let androidSession = androidSessions['15:dev_mac']; // This is androidToMacOut!
try {
  const m2Plain = androidSession.decrypt(m2Cipher.type, m2Cipher.body);
  console.log('   Android decrypted M2 on existing session:', m2Plain);
} catch (e) {
  console.log('   Android FAILED to decrypt M2 on androidToMacOut:', e.message);
}

// 5. Android sends Message 3 to Mac
console.log('5. Android sends M3 to Mac');
const m3Cipher = androidSession.encrypt('M3 from Android');

// Mac receives M3
console.log('6. Mac receives M3 from Android');
let macSession = macSessions['15:dev_android'];
try {
  const m3Plain = macSession.decrypt(m3Cipher.type, m3Cipher.body);
  console.log('   Mac decrypted M3:', m3Plain);
} catch (e) {
  console.log('   Mac FAILED to decrypt M3:', e.message);
}
