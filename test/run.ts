import { testCrypto } from './crypto.test.ts';
import { testE2E, testTracker, testSessionExpiry } from './e2e.test.ts';
import { testAlerts, testRecorderAndReport } from './features.test.ts';
import { readFileSync } from 'node:fs';
// La versión del programa debe coincidir con package.json
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const srcVersion = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').match(/const VERSION = '([^']+)'/)?.[1];
if (pkgVersion !== srcVersion) throw new Error(`Versión distinta: package.json ${pkgVersion} / src/main.ts ${srcVersion}`);
console.log(`versión OK (${pkgVersion})`);
testCrypto();
testTracker();
testAlerts();
testRecorderAndReport();
await testE2E();
await testSessionExpiry();
