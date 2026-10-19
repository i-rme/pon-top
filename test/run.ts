import { testCrypto } from './crypto.test.ts';
import { testE2E, testTracker, testSessionExpiry } from './e2e.test.ts';
import { testAlerts, testRecorderAndReport } from './features.test.ts';
testCrypto();
testTracker();
testAlerts();
testRecorderAndReport();
await testE2E();
await testSessionExpiry();
