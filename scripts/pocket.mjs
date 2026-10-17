import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, openSync, mkdirSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const main = resolve(root, 'dist/src/server/main.js');
const runtime = resolve(root, '.local/pocket-runtime.json');
const action = process.argv[2] ?? 'status';
// Installed Pocket is owned by systemd; never launch a competing detached server.
if (existsSync(resolve(homedir(), '.config/codex-pocket/install.json'))) {
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('Usage: start|stop|status');
  const result = spawnSync('systemctl', ['--user', action, 'codex-pocket.service', ...(action === 'status' ? ['--no-pager'] : [])], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
mkdirSync(resolve(root, '.local'), { recursive: true });
const saved = existsSync(runtime) ? JSON.parse(readFileSync(runtime, 'utf8')) : undefined;
function owned(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[1] === main; } catch { return false; }
}
if (action === 'stop') {
  if (!saved || !owned(saved.pid)) throw new Error('No matching owned Pocket process. Refusing to signal an unrelated PID.');
  process.kill(saved.pid, 'SIGTERM');
  for (let i = 0; i < 50 && owned(saved.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (owned(saved.pid)) throw new Error('Pocket has not finished shutting down; no force-kill was attempted');
  unlinkSync(runtime); console.log('Pocket backend stopped. Tailscale Serve route was left unchanged.');
} else if (action === 'status') {
  console.log(saved && owned(saved.pid) ? `Pocket running: ${saved.origin} (PID ${saved.pid})` : 'Pocket backend is not running');
} else if (action === 'start') {
  if (saved && owned(saved.pid)) { console.log(`Pocket already running: ${saved.origin}`); process.exit(0); }
  const origin = process.env.PUBLIC_ORIGIN, socket = process.env.CODEX_DAEMON_SOCKET;
  const port = Number(process.env.PORT ?? 4317);
  if (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) throw new Error('Set PUBLIC_ORIGIN to the exact private HTTPS origin');
  if (!socket || !isAbsolute(socket) || !statSync(realpathSync(socket)).isSocket()) throw new Error('Select an existing CODEX_DAEMON_SOCKET explicitly');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  if (!existsSync(main)) throw new Error('Run npm run build first');
  const log = openSync(resolve(root, '.local/server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [main], { cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env, PUBLIC_ORIGIN: origin, CODEX_DAEMON_SOCKET: socket, POCKET_STATE_DIR: process.env.POCKET_STATE_DIR ?? resolve(root, '.local/access'), PORT: String(port) } });
  child.unref();
  writeFileSync(runtime, JSON.stringify({ pid: child.pid, origin, port }), { mode: 0o600 });
  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!owned(child.pid)) throw new Error('Pocket exited during startup. Check .local/server.log');
    try { healthy = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { /* Startup still pending. */ }
  }
  if (!healthy) throw new Error('Pocket did not become healthy; check the log before retrying');
  console.log(`Pocket started: ${origin}. Tailscale Serve configuration is separate.`);
} else throw new Error('Usage: node scripts/pocket.mjs start|stop|status');
