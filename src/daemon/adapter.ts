import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Transport } from './transport.js';
import { PocketError, type Thread, type Page, type Notice, type Submission, type SavedPage, type QuestionTarget, type Entry } from './types.js';

export const sendLimitation = 'Use one device at a time. Use Send for idle messages or follow-ups to the displayed active turn.';
/** Shared loaded-thread reader; HTTP and browser independent. */
export class DaemonAdapter extends EventEmitter {
  private attached = new Map<string, Promise<void>>();
  private leases = new Map<string, number>();
  private blocked = new Map<string, Set<string | number>>();
  private sequence = 0;
  private questionClaims = new Map<string, string>();
  private questionKey(id: string, target: QuestionTarget) { return JSON.stringify([id, target.turnId, target.itemId]); }
  private pendingQuestion(id: string, entries: Entry[]): QuestionTarget | null {
    for (const { turnId, item } of entries) {
      if (item.type === 'userMessage') return null;
      if (item.type === 'agentMessage' && item.delivery === 'async' && Array.isArray(item.questions) && item.questions.length && item.questions.every(q => q && typeof q.title === 'string' && q.title.trim())) {
        const target = { itemId: item.id, turnId };
        return this.questionClaims.has(this.questionKey(id, target)) ? null : target;
      }
    }
    return null;
  }
  private submissions = new Map<string, { record: Submission; hash: string; createdAt: number }>();
  private sending = new Set<string>();
  private terminal = new Map<string, string>();
  private reconciling = new Map<string, Promise<Submission>>();
  constructor(readonly transport: Transport) {
    super();
    transport.on('state', () => {
      if (transport.state !== 'connected') { this.attached.clear(); this.blocked.clear(); }
      this.emit('state');
    });
    transport.on('notice', (notice: Notice) => {
      const id = notice.params.threadId;
      if (notice.requestId !== undefined && id) {
        const requests = this.blocked.get(id) ?? new Set(); requests.add(notice.requestId); this.blocked.set(id, requests);
      }
      if (notice.method === 'serverRequest/resolved') this.blocked.get(id)?.delete(notice.params.requestId);
      if (notice.method === 'turn/completed' && id && notice.params.turn?.id) {
        const turn = notice.params.turn;
        this.terminal.set(`${id}/${turn.id}`, turn.status);
        if (this.terminal.size > 1000) this.terminal.delete(this.terminal.keys().next().value!);
        for (const { record } of this.submissions.values()) if (record.threadId === id && record.turnId === turn.id) this.finish(record, turn.status);
      }
      this.emit('event', { sequence: ++this.sequence, ...notice });
    });
  }
  status() { return { connection: this.transport.state, version: this.transport.version, canSend: this.transport.state === 'connected', canBrowseHistory: true, limitation: sendLimitation, history: 'thread/items/list, 50 items per page' }; }
  async loadedIds(): Promise<string[]> {
    const ids: string[] = []; let cursor: string | null = null;
    for (let n = 0; n < 20; n++) {
      const page: { data: string[]; nextCursor?: string | null } = await this.transport.request('thread/loaded/list', { cursor, limit: 100 });
      if (!Array.isArray(page.data)) throw new PocketError('incompatible', 'Loaded-thread listing unsupported');
      ids.push(...page.data); cursor = page.nextCursor ?? null;
      if (!cursor) return [...new Set(ids)];
    }
    throw new PocketError('capacity', 'Loaded conversation list exceeds supported bound');
  }
  async assertLoaded(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !(await this.loadedIds()).includes(id)) throw new PocketError('unloaded', 'Choose a conversation already loaded in the selected daemon');
  }
  private validId(id: string) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id); }
  private validCursor(cursor: unknown) { return cursor === undefined || cursor === null || (typeof cursor === 'string' && cursor.length <= 4096); }
  private sanitize(thread: any, id?: string): Thread {
    if (!thread || typeof thread !== 'object' || !this.validId(thread.id) || (id !== undefined && thread.id !== id) || typeof thread.cwd !== 'string' || !thread.status || typeof thread.status !== 'object' || typeof thread.status.type !== 'string') throw new PocketError('incompatible', 'Thread metadata unsupported');
    return { id: thread.id, name: typeof thread.name === 'string' ? thread.name : thread.name === null ? null : undefined, cwd: thread.cwd, preview: typeof thread.preview === 'string' ? thread.preview.slice(0, 120) : undefined, status: thread.status, updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined, recencyAt: typeof thread.recencyAt === 'number' ? thread.recencyAt : thread.recencyAt === null ? null : undefined };
  }
  private async readMetadata(id: string): Promise<Thread> {
    const { thread } = await this.transport.request('thread/read', { threadId: id, includeTurns: false });
    return this.sanitize(thread, id);
  }
  async read(id: string): Promise<Thread> {
    await this.assertLoaded(id);
    const thread = await this.readMetadata(id);
    try {
      // One turn header, without items/transcript, distinguishes completion from metadata updates.
      const page = await this.transport.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      const turn = page?.data?.[0];
      if (this.validId(turn?.id) && ['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)) thread.latestTurn = { id: turn.id, status: turn.status };
    } catch { /* Unavailable completion metadata must not invent an unread marker. */ }
    return thread;
  }
  async list() {
    const ids = await this.loadedIds(); const result: Thread[] = [];
    // Bound parallel RPCs; threads may disappear between listing and reading.
    for (let i = 0; i < ids.length; i += 8) {
      const pages = await Promise.allSettled(ids.slice(i, i + 8).map(id => this.read(id)));
      for (const page of pages) if (page.status === 'fulfilled' && (page.value.name?.trim() || page.value.preview?.trim())) result.push(page.value);
    }
    return result.sort((a, b) => (b.recencyAt ?? b.updatedAt ?? 0) - (a.recencyAt ?? a.updatedAt ?? 0));
  }
  async saved(cursor?: string, search?: string): Promise<SavedPage> {
    if (!this.validCursor(cursor)) throw new PocketError('input', 'Invalid saved-thread cursor');
    if (search !== undefined && typeof search !== 'string') throw new PocketError('input', 'Invalid saved-thread search');
    const trimmed = search?.trim();
    if (trimmed && trimmed.length > 200) throw new PocketError('input', 'Saved-thread search is too long');
    const loaded = new Set(await this.loadedIds());
    const params: Record<string, unknown> = { cursor: cursor ?? null, limit: 50, sortKey: 'recency_at', sortDirection: 'desc', archived: false, useStateDbOnly: true, modelProviders: [] };
    if (trimmed) params.searchTerm = trimmed;
    const page: any = await this.transport.request('thread/list', params);
    if (!page || !Array.isArray(page.data) || page.data.length > 50 || !this.validCursor(page.nextCursor) || (page.nextCursor !== null && page.nextCursor !== undefined && typeof page.nextCursor !== 'string')) throw new PocketError('incompatible', 'Saved-thread listing unsupported');
    const data = page.data.map((record: any) => ({ ...this.sanitize(record), loaded: loaded.has(record.id) })).filter((thread: Thread) => !!(thread.name?.trim() || thread.preview?.trim()));
    return { data, nextCursor: page.nextCursor ?? null };
  }
  private async reconcileOpen(id: string): Promise<Thread | null> {
    try {
      if (!(await this.loadedIds()).includes(id)) return null;
      const thread = await this.readMetadata(id);
      // The ambiguous resume is now confirmed by the daemon's loaded list and
      // authoritative metadata read. Retain that subscription without retrying.
      if (!this.attached.has(id)) this.attached.set(id, Promise.resolve());
      return thread;
    } catch { return null; /* Absence or failed reconciliation preserves unknown. */ }
  }
  private async authoritativeOpen(id: string): Promise<Thread> {
    if (!(await this.loadedIds()).includes(id)) throw new PocketError('incompatible', 'Daemon did not load the selected conversation');
    return this.readMetadata(id);
  }
  async open(id: string): Promise<Thread> {
    if (!this.validId(id)) throw new PocketError('input', 'Invalid conversation ID');
    const loaded = (await this.loadedIds()).includes(id);
    if (loaded) { await this.attachShared(id); return this.authoritativeOpen(id); }
    const metadata = await this.readMetadata(id);
    if (!metadata.name?.trim() && !metadata.preview?.trim()) throw new PocketError('not-found', 'Conversation metadata unavailable');
    const promise = this.attachShared(id, true).then(() => this.authoritativeOpen(id)).catch(async error => {
      if (error instanceof PocketError && error.code === 'outcome-unknown') {
        const recovered = await this.reconcileOpen(id);
        if (recovered) return recovered;
      }
      throw error;
    });
    return promise;
  }
  private async attachShared(id: string, resume = false) {
    if (!this.attached.has(id)) {
      if (this.attached.size >= 32) throw new PocketError('capacity', 'Subscription limit reached; restart this local app to release owned subscriptions');
      const promise = this.transport.request('thread/resume', { threadId: id, excludeTurns: true }, resume).then(() => {});
      this.attached.set(id, promise);
      promise.catch(() => { if (this.attached.get(id) === promise) this.attached.delete(id); });
    }
    await this.attached.get(id);
  }
  async attach(id: string) {
    await this.assertLoaded(id);
    await this.attachShared(id);
  }
  async acquire(id: string) {
    await this.attach(id); this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; const count = (this.leases.get(id) ?? 1) - 1; count ? this.leases.set(id, count) : this.leases.delete(id); } };
    // Retain bounded daemon subscriptions until app shutdown. Never unsubscribe/unload on browser leave.
  }
  async history(id: string, cursor?: string): Promise<Page & { thread: Thread; sequence: number; blocked: boolean; question: QuestionTarget | null }> {
    await this.attach(id);
    const page = await this.transport.request<Page>('thread/items/list', { threadId: id, cursor: cursor ?? null, limit: 50, sortDirection: 'desc' });
    if (!Array.isArray(page.data) || page.data.length > 50 || page.data.some(e => !e.turnId || !e.item?.id)) throw new PocketError('incompatible', 'Bounded item history unsupported by this daemon');
    // Keep sequence conservative: SSE hydration buffers are reconciled by item IDs.
    const recent: Page = cursor ? await this.transport.request('thread/items/list', { threadId: id, cursor: null, limit: 50, sortDirection: 'desc' }) : page;
    const data = [...page.data].reverse().map(entry => {
      if (entry.item.type !== 'imageGeneration') return entry;
      // Keep the activity/status, but don't transfer the tool's embedded image
      // bytes to every browser. Generated-image previews aren't supported here.
      const { result: _result, ...summary } = entry.item as Entry['item'] & { result?: unknown };
      return { ...entry, item: summary };
    });
    return { data, nextCursor: page.nextCursor, thread: await this.read(id), sequence: this.sequence, blocked: !!this.blocked.get(id)?.size, question: this.pendingQuestion(id, recent.data) };
  }
  private finish(record: Submission, status: string) {
    record.state = status === 'completed' ? 'completed' : 'failed';
    record.message = status === 'completed' ? 'Completed' : `Turn ended: ${status}`;
  }
  private prune() {
    for (const [id, entry] of this.submissions) if (entry.record.state !== 'sending' && Date.now() - entry.createdAt > 3_600_000) this.submissions.delete(id);
    for (const [key, id] of this.questionClaims) if (!this.submissions.has(id)) this.questionClaims.delete(key);
  }
  async send(id: string, text: string, clientSubmissionId: string, images: string[] = [], question?: QuestionTarget, expectedTurnId?: string): Promise<Submission> {
    if (typeof text !== 'string' || (!text.trim() && !images.length) || images.length > 4 || images.some(path => typeof path !== 'string' || !path.startsWith('/')) || Buffer.byteLength(text) > 64 * 1024 || typeof clientSubmissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientSubmissionId)) throw new PocketError('input', 'Invalid message or submission ID');
    if (question !== undefined && (!question || !this.validId(question.itemId) || !this.validId(question.turnId))) throw new PocketError('input', 'Invalid question target');
    if (expectedTurnId !== undefined && (!this.validId(expectedTurnId) || (question && question.turnId !== expectedTurnId))) throw new PocketError('input', 'Invalid active turn target');
    const targetTurnId = expectedTurnId ?? question?.turnId;
    this.prune();
    const hash = createHash('sha256').update(JSON.stringify([id, text, images, question ?? null, expectedTurnId ?? null])).digest('hex');
    const existing = this.submissions.get(clientSubmissionId);
    if (existing) {
      if (existing.hash !== hash) throw new PocketError('conflict', 'Submission ID already belongs to a different message');
      return { ...existing.record };
    }
    if (this.sending.has(id) || [...this.submissions.values()].some(e => e.record.threadId === id && (['sending', 'outcome-unknown'].includes(e.record.state) || (e.record.state === 'accepted' && (!targetTurnId || e.record.turnId !== targetTurnId))))) throw new PocketError('busy', 'A submission is pending or has an unknown outcome. Check its status before sending again.');
    if (this.submissions.size >= 1000) throw new PocketError('capacity', 'Submission ledger full; retained outcomes expire after one hour');
    const record: Submission = { id: clientSubmissionId, threadId: id, state: 'sending' };
    this.submissions.set(clientSubmissionId, { record, hash, createdAt: Date.now() });
    this.sending.add(id);
    let dispatched = false;
    try {
      await this.attach(id);
      const thread = await this.read(id);
      if (this.blocked.get(id)?.size) throw new PocketError('busy', 'Conversation needs action in Codex CLI');
      if (question) {
        const page: Page = await this.transport.request('thread/items/list', { threadId: id, cursor: null, limit: 50, sortDirection: 'desc' });
        const pending = this.pendingQuestion(id, page.data);
        if (!pending || pending.itemId !== question.itemId || pending.turnId !== question.turnId) throw new PocketError('conflict', 'Question was answered or is no longer available. Refresh the conversation.');
      }
      if (expectedTurnId && (thread.status.type !== 'active' || thread.latestTurn?.id !== expectedTurnId || thread.latestTurn.status !== 'inProgress')) throw new PocketError('conflict', 'The active turn changed or finished. Refresh and send again.');
      const steering = thread.status.type === 'active' && targetTurnId && thread.latestTurn?.id === targetTurnId && thread.latestTurn.status === 'inProgress';
      if (thread.status.type !== 'idle' && !steering) throw new PocketError('busy', 'Conversation is busy. Refresh to send a follow-up to the current turn.');
      if (question) this.questionClaims.set(this.questionKey(id, question), clientSubmissionId);
      // User-approved single-device assumption: this is an observation, not an atomic CLI lock.
      dispatched = true;
      const result = await this.transport.request(steering ? 'turn/steer' : 'turn/start', {
        threadId: id, clientUserMessageId: clientSubmissionId, ...(steering ? { expectedTurnId: targetTurnId } : {}),
        input: [...(text.length ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(path => ({ type: 'localImage', path }))],
      }, true);
      const acceptedTurnId = steering ? result.turnId : result.turn?.id;
      if (typeof acceptedTurnId !== 'string' || (steering && acceptedTurnId !== targetTurnId)) throw new PocketError('outcome-unknown', 'Daemon response lacks a turn ID; check status before sending again');
      record.turnId = acceptedTurnId; record.state = 'accepted'; record.message = 'Accepted';
      const terminal = this.terminal.get(`${id}/${record.turnId}`);
      if (terminal) this.finish(record, terminal);
    } catch (error) {
      const ambiguous = dispatched && (!(error instanceof PocketError) || error.code === 'outcome-unknown');
      record.state = ambiguous ? 'outcome-unknown' : 'failed';
      record.message = ambiguous ? 'Outcome unknown. Check status; do not resend. If still unknown, review this conversation in Codex CLI.' : error instanceof PocketError ? error.message : 'Submission failed';
      if (question && !ambiguous && this.questionClaims.get(this.questionKey(id, question)) === clientSubmissionId) this.questionClaims.delete(this.questionKey(id, question));
      if (!dispatched) throw error;
    } finally { this.sending.delete(id); }
    return { ...record };
  }
  outstanding() {
    this.prune();
    return [...this.submissions.values()].filter(e => ['sending', 'accepted', 'outcome-unknown'].includes(e.record.state)).map(e => ({ ...e.record }));
  }
  async submission(id: string): Promise<Submission> {
    this.prune();
    const entry = this.submissions.get(id);
    if (!entry) throw new PocketError('not-found', 'Submission not retained. After a restart or one hour, check Codex CLI before resending.');
    const { record } = entry;
    if (!['outcome-unknown', 'accepted'].includes(record.state) || this.transport.state !== 'connected') return { ...record };
    if (this.reconciling.has(id)) return this.reconciling.get(id)!;
    const work = (async () => {
      try {
        await this.assertLoaded(record.threadId);
        if (!record.turnId) {
          let cursor: string | null = null;
          for (let i = 0; i < 4; i++) {
            const page: Page = await this.transport.request('thread/items/list', { threadId: record.threadId, cursor, limit: 50, sortDirection: 'desc' });
            // clientId is the protocol's correlation field, never text equality.
            const matched = page.data.find(e => e.item.type === 'userMessage' && e.item.clientId === id);
            if (matched) { record.turnId = matched.turnId; record.state = 'accepted'; record.message = 'Accepted (recovered from history)'; break; }
            cursor = page.nextCursor; if (!cursor) break;
          }
        }
        if (record.turnId) {
          const terminal = this.terminal.get(`${record.threadId}/${record.turnId}`);
          if (terminal) this.finish(record, terminal);
          else {
            const page = await this.transport.request('thread/turns/list', { threadId: record.threadId, limit: 50, sortDirection: 'desc', itemsView: 'notLoaded' });
            const turn = page.data.find((turn: any) => turn.id === record.turnId);
            if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) this.finish(record, turn.status);
          }
        }
      } catch { /* Absence or a read failure cannot establish non-acceptance. Never retry. */ }
      return { ...record };
    })();
    this.reconciling.set(id, work);
    try { return await work; } finally { this.reconciling.delete(id); }
  }
  close() { this.transport.close(); this.removeAllListeners(); }
}
