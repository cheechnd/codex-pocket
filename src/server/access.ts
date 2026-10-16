import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getIronSession } from 'iron-session';
import { PocketError } from '../daemon/types.js';

interface AccessState {
  password: string;
  pairing?: { hash: string; expires: number };
  sessions: { id: string; expires: number }[];
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const lifetime = 7 * 24 * 3600;
/** iron-session owns cookie encryption/signing. This store adds single-use pairing and revocation. */
export class AccessControl {
  private attempts = 0;
  private attemptWindow = 0;
  readonly stateFile: string;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = statSync(directory);
    if ((directoryStat.mode & 0o077) || directoryStat.uid !== process.getuid?.()) throw new Error('Access directory must be owned by this user with mode 0700');
    this.stateFile = join(directory, 'state.json');
    if (!existsSync(this.stateFile)) {
      try { writeFileSync(this.stateFile, JSON.stringify({ password: randomBytes(32).toString('hex'), sessions: [] }), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    this.load();
  }
  private load(): AccessState {
    const stat = statSync(this.stateFile);
    if ((stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Access state must be owned by this user with mode 0600');
    const state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as AccessState;
    if (typeof state.password !== 'string' || state.password.length < 32 || !Array.isArray(state.sessions)) throw new Error('Invalid access state');
    return state;
  }
  private save(state: AccessState) {
    const temporary = `${this.stateFile}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.stateFile);
  }
  pairingCode(revoke = false) {
    const state = this.load();
    if (revoke) state.sessions = [];
    const code = randomBytes(12).toString('hex').match(/.{4}/g)!.join('-');
    state.pairing = { hash: digest(code).toString('hex'), expires: Date.now() + 10 * 60_000 };
    this.save(state);
    writeFileSync(join(this.directory, 'pairing-code'), code + '\n', { mode: 0o600 });
    return code;
  }
  private async session(req: IncomingMessage, res: ServerResponse, origin: string) {
    return getIronSession<{ id: string }>(req, res, {
      password: this.load().password,
      cookieName: origin.startsWith('https:') ? '__Host-codex-pocket' : 'codex-pocket-local',
      ttl: lifetime,
      cookieOptions: { secure: origin.startsWith('https:'), httpOnly: true, sameSite: 'strict', path: '/' },
    });
  }
  isValid(id: string | undefined) {
    try { return !!id && this.load().sessions.some(s => s.id === id && s.expires > Date.now()); } catch { return false; }
  }
  async authenticate(req: IncomingMessage, res: ServerResponse, origin: string) {
    const session = await this.session(req, res, origin);
    return this.isValid(session.id) ? session.id : undefined;
  }
  async pair(req: IncomingMessage, res: ServerResponse, origin: string, code: unknown) {
    if (Date.now() - this.attemptWindow > 60_000) { this.attemptWindow = Date.now(); this.attempts = 0; }
    if (++this.attempts > 10) throw new PocketError('rate-limit', 'Too many pairing attempts. Wait one minute.');
    const session = await this.session(req, res, origin);
    // Read/consume synchronously after the await, so concurrent uses cannot both succeed.
    const state = this.load();
    const supplied = typeof code === 'string' && code.length <= 100 ? code.trim().toLowerCase() : '';
    if (!state.pairing || state.pairing.expires <= Date.now() || !timingSafeEqual(digest(supplied), Buffer.from(state.pairing.hash, 'hex'))) throw new PocketError('unauthorized', 'Pairing code is invalid, expired or already used. Generate a new code on your computer.');
    state.pairing = undefined;
    state.sessions = state.sessions.filter(s => s.expires > Date.now());
    if (state.sessions.length >= 32) state.sessions.shift();
    session.id = randomBytes(24).toString('hex');
    state.sessions.push({ id: session.id, expires: Date.now() + lifetime * 1000 });
    this.save(state); await session.save();
  }
  async logout(req: IncomingMessage, res: ServerResponse, origin: string) {
    const session = await this.session(req, res, origin); const state = this.load();
    state.sessions = state.sessions.filter(s => s.id !== session.id); this.save(state); session.destroy();
  }
}
