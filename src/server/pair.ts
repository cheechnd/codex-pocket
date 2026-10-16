import { resolve } from 'node:path';
import { AccessControl } from './access.js';
const directory = resolve(process.env.POCKET_STATE_DIR ?? '.local/access');
new AccessControl(directory).pairingCode(process.argv.includes('--revoke'));
console.log(`One-time pairing code written to ${directory}/pairing-code (valid 10 minutes).`);
console.log('Read it locally or copy it to your phone. Do not commit it or put it in a URL.');
