import { resolve } from 'node:path';
import { AccessControl } from './access.js';
const directory = resolve(process.env.POCKET_STATE_DIR ?? '.local/access');
const code = new AccessControl(directory).pairingCode(process.argv.includes('--revoke'));
console.log(code);
