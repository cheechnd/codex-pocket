import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, renameSync, symlinkSync, rmSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// One installed instance. Candidate builds and tests never touch the running release.
const sourceDefault = fileURLToPath(new URL('../', import.meta.url));
const home = homedir();
const base = join(home, '.local/share/codex-pocket');
const configDir = join(home, '.config/codex-pocket');
const configFile = join(configDir, 'install.json');
const unit = join(home, '.config/systemd/user/codex-pocket.service');
const action = process.argv[2] ?? 'update';
const npm = join(dirname(process.execPath), 'npm');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.message})`);
};
const systemctl = (...args) => run('systemctl', ['--user', ...args]);
function point(name, target) {
  const temporary = join(base, `${name}.next`);
  rmSync(temporary, { force: true }); symlinkSync(target, temporary); renameSync(temporary, join(base, name));
}
function target(name) { return existsSync(join(base, name)) ? realpathSync(join(base, name)) : undefined; }
function health(port) {
  return fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
}
async function waitHealthy(config) {
  for (let n = 0; n < 40; n++) {
    const active = spawnSync('systemctl', ['--user', 'is-active', '--quiet', 'codex-pocket.service']).status === 0;
    if (active && await health(config.port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Installed Pocket did not become healthy; inspect journalctl --user -u codex-pocket.service');
}
function save(config) { writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); }
function quote(value) { return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"'; }
function writeService(config) {
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, `[Unit]\nDescription=Codex Pocket private web companion\nStartLimitIntervalSec=60\nStartLimitBurst=10\n\n[Service]\nType=simple\nWorkingDirectory=%h/.local/share/codex-pocket/current\nExecStart=${quote(config.node)} ${quote(join(base, 'current/dist/src/server/main.js'))}\nEnvironment=${quote(`PUBLIC_ORIGIN=${config.origin}`)}\nEnvironment=${quote(`CODEX_DAEMON_SOCKET=${config.socket}`)}\nEnvironment=${quote(`PORT=${config.port}`)}\nEnvironment=${quote(`POCKET_STATE_DIR=${config.state}`)}\nEnvironment=${quote(`POCKET_ATTACHMENTS_DIR=${config.attachments}`)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
  run('systemd-analyze', ['--user', 'verify', unit]);
  systemctl('daemon-reload');
}
function moveData(old, next) {
  // Keep the original alias: older daemon messages contain absolute image paths.
  if (existsSync(old)) {
    if (realpathSync(old) === next) return;
    if (existsSync(next)) throw new Error(`Both ${old} and ${next} exist; refusing to merge private state`);
    renameSync(old, next); symlinkSync(next, old);
  } else {
    mkdirSync(next, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(old), { recursive: true, mode: 0o700 });
    symlinkSync(next, old);
  }
}
function installCommands(config, release) {
  cpSync(join(release, 'deploy.mjs'), join(base, 'manage.next.mjs'));
  renameSync(join(base, 'manage.next.mjs'), join(base, 'manage.mjs'));
  const bin = join(home, '.local/bin'); mkdirSync(bin, { recursive: true });
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const [name, command] of [['pocket-update', 'update'], ['pocket-rollback', 'rollback']]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${shellQuote(config.node)} ${shellQuote(join(base, 'manage.mjs'))} ${command} "$@"\n`, { mode: 0o755 });
  }
  writeFileSync(join(bin, 'pocket-pair'), `#!/bin/sh\nexport POCKET_STATE_DIR=${shellQuote(config.state)}\nexec ${shellQuote(config.node)} ${shellQuote(join(base, 'current/dist/src/server/pair.js'))} "$@"\n`, { mode: 0o755 });
}
async function switchRelease(config, candidate) {
  const previous = target('current');
  point('current', candidate);
  try {
    systemctl('restart', 'codex-pocket.service');
    await waitHealthy(config);
  } catch (error) {
    if (previous) {
      point('current', previous); systemctl('restart', 'codex-pocket.service'); await waitHealthy(config);
      console.error('Previous release restored.');
    } else {
      spawnSync('systemctl', ['--user', 'stop', 'codex-pocket.service'], { stdio: 'ignore' });
      rmSync(join(base, 'current'), { force: true });
    }
    throw error;
  }
  if (previous && previous !== candidate) point('previous', previous);
}

if (!['install', 'update', 'rollback'].includes(action)) throw new Error('Usage: node scripts/deploy.mjs install|update|rollback');
mkdirSync(base, { recursive: true, mode: 0o700 });
const lock = join(base, 'deploy.lock');
try { mkdirSync(lock, { mode: 0o700 }); }
catch { throw new Error(`Another deployment is running, or left a lock at ${lock}. Check before removing it.`); }
try {
  let config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : undefined;
  if (action === 'rollback') {
    if (!config || !target('previous')) throw new Error('No previous installed release');
    await switchRelease(config, target('previous'));
    console.log('Pocket rolled back and healthy.');
  } else {
    if (action === 'install' && config) throw new Error('Already installed. Use pocket-update.');
    if (action === 'update' && !config) throw new Error('Install Pocket first with explicit PUBLIC_ORIGIN and CODEX_DAEMON_SOCKET.');
    const source = resolve(config?.source ?? process.argv[3] ?? sourceDefault);
    if (!config) {
      const origin = process.env.PUBLIC_ORIGIN, socket = process.env.CODEX_DAEMON_SOCKET;
      const port = Number(process.env.PORT ?? 4317);
      if (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) throw new Error('Set the exact private HTTPS PUBLIC_ORIGIN');
      if (!socket || !isAbsolute(socket) || !statSync(realpathSync(socket)).isSocket()) throw new Error('Explicitly select an existing daemon socket');
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
      if (existsSync(unit)) throw new Error('A codex-pocket.service unit already exists; refusing to overwrite it');
      config = { source, origin, socket, port, node: process.execPath, state: join(base, 'data/access'), attachments: join(source, '.local/attachments') };
    }
    const revision = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout?.trim() || 'local';
    const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${revision}`;
    const release = join(base, 'releases', id);
    mkdirSync(release, { recursive: true, mode: 0o700 });
    try {
      for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts', 'src', 'scripts', 'test']) cpSync(join(source, path), join(release, path), { recursive: true });
      mkdirSync(join(release, 'poc'));
      for (const path of ['client.mjs', 'verify.mjs']) cpSync(join(source, 'poc', path), join(release, 'poc', path));
      const logs = join(base, 'logs'); mkdirSync(logs, { recursive: true, mode: 0o700 });
      const env = { ...process.env, PATH: `${dirname(config.node)}:${process.env.PATH}` };
      // Keep ordinary checks in a local log, never the journal or repository.
      const { openSync, closeSync } = await import('node:fs');
      const logPath = join(logs, `${id}.log`), log = openSync(logPath, 'a', 0o600);
      console.log(`Checking candidate; log: ${logPath}`);
      try {
        for (const args of [['ci'], ['run', 'check'], ['test'], ['run', 'test:browser'], ['prune', '--omit=dev']]) run(npm, args, { cwd: release, env, stdio: ['ignore', log, log] });
      } finally { closeSync(log); }
      cpSync(join(release, 'scripts/deploy.mjs'), join(release, 'deploy.mjs'));
      // Browser verification built dist; production carries only runtime code/dependencies.
      for (const path of ['src', 'test', 'dist/test', 'poc', 'scripts', '.local', 'playwright-report', 'test-results']) rmSync(join(release, path), { recursive: true, force: true });
      writeFileSync(join(release, 'release.json'), JSON.stringify({ id, revision, builtAt: new Date().toISOString() }) + '\n');
    } catch (error) { rmSync(release, { recursive: true, force: true }); throw error; }
    if (action === 'install') {
      writeService(config);
      // Switch only after all checks pass. Stop only the owned detached Pocket process.
      const metadata = join(source, '.local/pocket-runtime.json');
      const running = existsSync(metadata) ? JSON.parse(readFileSync(metadata, 'utf8')) : undefined;
      if (running && existsSync(`/proc/${running.pid}`)) run(config.node, [join(source, 'scripts/pocket.mjs'), 'stop']);
      else if (await health(config.port)) throw new Error('Port already hosts an unmanaged backend; refusing to replace it');
      mkdirSync(join(base, 'data'), { recursive: true, mode: 0o700 });
      moveData(join(source, '.local/access'), config.state);
      moveData(config.attachments, join(base, 'data/attachments'));
      mkdirSync(configDir, { recursive: true, mode: 0o700 }); save(config);
      try { await switchRelease(config, release); }
      catch (error) {
        // State aliases keep the original manual start path usable if first startup fails.
        spawnSync('systemctl', ['--user', 'stop', 'codex-pocket.service'], { stdio: 'ignore' });
        rmSync(configFile, { force: true }); rmSync(unit, { force: true }); systemctl('daemon-reload');
        run(config.node, [join(source, 'scripts/pocket.mjs'), 'start'], { env: { ...process.env, PUBLIC_ORIGIN: config.origin, CODEX_DAEMON_SOCKET: config.socket, PORT: String(config.port) } });
        throw error;
      }
      systemctl('enable', 'codex-pocket.service');
    } else await switchRelease(config, release);
    installCommands(config, release);
    console.log(`Pocket installed and healthy: ${id}`);
  }
} finally { rmSync(lock, { recursive: true, force: true }); }
