import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OlmModule = await import('@matrix-org/olm');
const Olm = OlmModule.default || OlmModule;
const wasmPath = path.join(__dirname, '../public/lib/olm.wasm');
await Olm.init({ wasmBinary: fs.readFileSync(wasmPath) });

console.log('--- Proving Real Dual-Outbound Session Conflict ---');

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

const macSessions = {};
const androidSessions = {};

// Step 1: Mac sends M1 to Admin (fan-out creates Outbound session to Android)
console.log('1. Mac sends M1: creates Outbound session to Android using Android OTK');
const macToAndroidOut = new Olm.Session();
macToAndroidOut.create_outbound(mac, androidKeys.curve25519, androidOtk1);
macSessions['15:dev_android'] = macToAndroidOut;
const m1CipherForAndroid = macToAndroidOut.encrypt('M1 from Mac (sent to admin)');
console.log('   M1 cipher type for Android:', m1CipherForAndroid.type); // type 0

// Step 2: Android (before receiving M1) sends M2 to Admin (fan-out creates Outbound session to Mac)
console.log('2. Android sends M2: creates Outbound session to Mac using Mac OTK');
const androidToMacOut = new Olm.Session();
androidToMacOut.create_outbound(android, macKeys.curve25519, macOtk1);
androidSessions['15:dev_mac'] = androidToMacOut;
const m2CipherForMac = androidToMacOut.encrypt('M2 from Android (sent to admin)');
console.log('   M2 cipher type for Mac:', m2CipherForMac.type); // type 0

// Step 3: Android receives M1 from Mac (type 0 PreKey)
console.log('\n3. Android receives M1 from Mac:');
// Android has androidSessions['15:dev_mac'] = androidToMacOut.
// Android tries to decrypt M1 on androidSessions['15:dev_mac']:
try {
  androidSessions['15:dev_mac'].decrypt(m1CipherForAndroid.type, m1CipherForAndroid.body);
  console.log('   Android decrypted M1 on existing session');
} catch (e) {
  console.log('   Android live.decrypt(M1) failed as expected:', e.message);
  // Because it failed and m1 is type 0, Android creates INBOUND session:
  const androidInFromMac = new Olm.Session();
  androidInFromMac.create_inbound(android, m1CipherForAndroid.body);
  android.remove_one_time_keys(androidInFromMac);
  const plain = androidInFromMac.decrypt(m1CipherForAndroid.type, m1CipherForAndroid.body);
  console.log('   Android decrypted M1 with fresh inbound:', plain);
  // ANDROID STORES THIS INBOUND SESSION AT '15:dev_mac':
  androidSessions['15:dev_mac'] = androidInFromMac;
  console.log('   --> Android OVERWROTE its outbound session to Mac with the inbound session!');
}

// Step 4: Mac receives M2 from Android (type 0 PreKey)
console.log('\n4. Mac receives M2 from Android:');
try {
  macSessions['15:dev_android'].decrypt(m2CipherForMac.type, m2CipherForMac.body);
  console.log('   Mac decrypted M2 on existing session');
} catch (e) {
  console.log('   Mac live.decrypt(M2) failed as expected:', e.message);
  // Mac creates INBOUND session:
  const macInFromAndroid = new Olm.Session();
  macInFromAndroid.create_inbound(mac, m2CipherForMac.body);
  mac.remove_one_time_keys(macInFromAndroid);
  const plain = macInFromAndroid.decrypt(m2CipherForMac.type, m2CipherForMac.body);
  console.log('   Mac decrypted M2 with fresh inbound:', plain);
  // MAC STORES THIS INBOUND SESSION AT '15:dev_android':
  macSessions['15:dev_android'] = macInFromAndroid;
  console.log('   --> Mac OVERWROTE its outbound session to Android with the inbound session!');
}

// Step 5: Android sends M3 (follow-up message)
console.log('\n5. Android sends M3 to admin (fan-out to Mac):');
// Android loads androidSessions['15:dev_mac']:
const androidSess = androidSessions['15:dev_mac'];
// Android encrypts M3:
const m3CipherForMac = androidSess.encrypt('M3 from Android');
console.log('   M3 cipher type for Mac:', m3CipherForMac.type); // type 1

// Step 6: Mac receives M3 from Android (type 1 normal message)
console.log('\n6. Mac receives M3 from Android:');
// Mac loads macSessions['15:dev_android']:
const macSess = macSessions['15:dev_android'];
try {
  const m3Plain = macSess.decrypt(m3CipherForMac.type, m3CipherForMac.body);
  console.log('   Mac decrypted M3:', m3Plain);
} catch (e) {
  console.log('   ❌ Mac FAILED to decrypt M3:', e.message);
}

// Step 7: Mac sends M4 (follow-up message)
console.log('\n7. Mac sends M4 to admin (fan-out to Android):');
const m4CipherForAndroid = macSess.encrypt('M4 from Mac');

// Step 8: Android receives M4 from Mac
console.log('\n8. Android receives M4 from Mac:');
try {
  const m4Plain = androidSess.decrypt(m4CipherForAndroid.type, m4CipherForAndroid.body);
  console.log('   Android decrypted M4:', m4Plain);
} catch (e) {
  console.log('   ❌ Android FAILED to decrypt M4:', e.message);
}
