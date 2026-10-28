import { createHash } from 'node:crypto';
import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { PocketError, type Submission, type Thread } from '../daemon/types.js';
import { DaemonAdapter } from '../daemon/adapter.js';

export interface NewSessionInput {
  clientRequestId: string;
  directory: string;
  newDirectoryName?: string;
  text: string;
}

export interface NewSessionRecord {
  id: string;
  state: 'creating' | 'created' | 'outcome-unknown' | 'failed';
  cwd?: string;
  thread?: Thread;
  submission?: Submission;
  message?: string;
}

interface Retained { hash: string; record: NewSessionRecord; promise?: Promise<NewSessionRecord>; createdAt: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CHILD = /^(?![.]$)(?![.][.]$)[^/\\\x00-\x1f\x7f]+$/;

export class NewSessionManager {
  private readonly records = new Map<string, Retained>();
  private readonly limit = 500;
  constructor(private readonly adapter: DaemonAdapter) {}

  async options() { return this.adapter.newSessionOptions(); }

  get(id: string): Promise<NewSessionRecord> | NewSessionRecord {
    const retained = this.records.get(id);
    if (!retained) throw new PocketError('not-found', 'New-session request is not retained; check Codex CLI before retrying');
    const record = retained.record;
    if (record.state === 'created' && record.submission?.state === 'outcome-unknown') {
      return this.reconcile(retained);
    }
    return { ...record };
  }

  async create(input: unknown): Promise<NewSessionRecord> {
    const parsed = this.validateInput(input);
    const hash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    const existing = this.records.get(parsed.clientRequestId);
    if (existing) {
      if (existing.hash !== hash) throw new PocketError('conflict', 'Request ID already belongs to a different new-session request');
      return existing.promise ?? { ...existing.record };
    }
    this.prune();
    if (this.records.size >= this.limit) throw new PocketError('capacity', 'New-session ledger full; wait for retained outcomes to expire');
    const retained: Retained = { hash, record: { id: parsed.clientRequestId, state: 'creating' }, createdAt: Date.now() };
    this.records.set(parsed.clientRequestId, retained);
    retained.promise = this.perform(parsed, retained).finally(() => { delete retained.promise; });
    return retained.promise;
  }

  private async perform(input: NewSessionInput, retained: Retained): Promise<NewSessionRecord> {
    let cwd: string | undefined;
    try {
      cwd = await this.resolveDirectory(input);
      retained.record.cwd = cwd;
      const submissionId = `new-${input.clientRequestId}`;
      const result = await this.adapter.createSession(cwd, input.text, submissionId);
      retained.record = { id: input.clientRequestId, state: 'created', cwd, thread: result.thread, submission: result.submission };
    } catch (error) {
      const unknown = error instanceof PocketError && error.code === 'outcome-unknown';
      retained.record = {
        id: input.clientRequestId,
        state: unknown ? 'outcome-unknown' : 'failed',
        ...(cwd ? { cwd } : {}),
        message: unknown
          ? `New conversation creation outcome is unknown${cwd ? `; the directory remains at ${cwd}` : ''}. Check Codex CLI; do not retry this request.`
          : this.failureMessage(error, cwd),
      };
    }
    return { ...retained.record };
  }

  private async reconcile(retained: Retained) {
    const submission = retained.record.submission!;
    try {
      retained.record.submission = await this.adapter.submission(submission.id);
    } catch { /* A missing/failed reconciliation cannot establish non-acceptance. */ }
    return { ...retained.record };
  }

  private validateInput(value: unknown): NewSessionInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PocketError('input', 'Invalid new-session request');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !['clientRequestId', 'directory', 'newDirectoryName', 'text'].includes(key))) throw new PocketError('input', 'Unsupported new-session option');
    if (typeof input.clientRequestId !== 'string' || !UUID.test(input.clientRequestId)) throw new PocketError('input', 'clientRequestId must be a UUID');
    if (typeof input.directory !== 'string' || !input.directory.startsWith('/') || /[\x00-\x1f\x7f]/.test(input.directory) || Buffer.byteLength(input.directory) > 4096) throw new PocketError('input', 'Choose an absolute directory path of at most 4096 bytes');
    if (input.newDirectoryName !== undefined && (typeof input.newDirectoryName !== 'string' || !input.newDirectoryName.trim() || !SAFE_CHILD.test(input.newDirectoryName) || Buffer.byteLength(input.newDirectoryName) > 255)) throw new PocketError('input', 'Folder name must be one safe child name of at most 255 bytes');
    if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 64 * 1024) throw new PocketError('input', 'Initial message is required and must be at most 64 KiB');
    return { clientRequestId: input.clientRequestId, directory: input.directory, ...(input.newDirectoryName !== undefined ? { newDirectoryName: input.newDirectoryName } : {}), text: input.text };
  }

  private async resolveDirectory(input: NewSessionInput): Promise<string> {
    const parent = await this.existingDirectory(input.directory);
    if (input.newDirectoryName === undefined) return parent;
    const child = join(parent, input.newDirectoryName);
    // lstat is deliberately followed by mkdir without recursive mode: no
    // existing path can be adopted, overwritten, or traversed.
    try { await lstat(child); throw new PocketError('conflict', 'The requested new directory already exists'); }
    catch (error) { if (error instanceof PocketError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await mkdir(child, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PocketError('conflict', 'The requested new directory already exists');
      throw new PocketError('input', 'Could not create the new folder; choose a writable parent directory');
    }
    try { return await this.existingDirectory(child); }
    catch (error) { throw new PocketError('input', `New directory was created but is not usable: ${this.errorText(error)}`); }
  }

  private async existingDirectory(value: string) {
    try {
      const canonical = await realpath(value);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new PocketError('input', 'Selected path is not an existing directory');
      await access(canonical, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
      return canonical;
    } catch (error) {
      if (error instanceof PocketError) throw error;
      throw new PocketError('input', 'Choose an existing directory that you can read and write');
    }
  }

  private failureMessage(error: unknown, cwd?: string) {
    const suffix = cwd && error instanceof PocketError && error.code !== 'input' ? ` The directory remains at ${cwd}; no automatic cleanup was attempted.` : '';
    return `${this.errorText(error)}${suffix}`;
  }
  private errorText(error: unknown) { return error instanceof PocketError ? error.message : 'Daemon unavailable; verify the explicitly selected socket'; }

  private prune() {
    const cutoff = Date.now() - 3_600_000;
    for (const [id, retained] of this.records) {
      if (retained.promise || retained.record.state === 'outcome-unknown' || retained.record.submission?.state === 'outcome-unknown') continue;
      if (retained.createdAt < cutoff) this.records.delete(id);
    }
  }
}
