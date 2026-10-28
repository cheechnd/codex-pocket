import { renderMarkdown } from './markdown.js';
const $ = id => document.getElementById(id);
let selected, source, epoch = 0, cursor, busy = false, dirty = false, timer, threads = [];
let pickerScope = 'loaded', pickerCursor = null, pickerLoading = false, pickerGeneration = 0, pickerTimer, pickerQuery = '';
let historyLoading = false, historyFailed = false, historyScrollTimer, historyScrollAt = 0, historyAutoArmed = true;
const opening = new Set();
let openIntent = 0;
const drafts = new Map(), attachments = new Map(), items = new Map(), submissions = new Map();
// Text only, kept on this device across app sessions. Pending IDs guard against
// duplicate sends even when the server no longer retains its outcome ledger.
const draftStorageKey = 'pocket-drafts-v1';
const newSessionStorageKey = 'pocket-new-session-v1';
let pendingCreation, creationEpoch = 0;
try {
  const stored = JSON.parse(localStorage.getItem(newSessionStorageKey) ?? 'null');
  if (stored && /^[0-9a-f-]{36}$/i.test(stored.requestId ?? '') && typeof stored.directory === 'string' && typeof stored.text === 'string') pendingCreation = { ...stored, state: stored.state === 'failed' ? 'failed' : 'outcome-unknown' };
} catch { /* A malformed creation record must not prevent the app from loading. */ }
function persistPendingCreation() {
  try {
    if (pendingCreation) localStorage.setItem(newSessionStorageKey, JSON.stringify(pendingCreation));
    else localStorage.removeItem(newSessionStorageKey);
  } catch { /* Storage denial must not prevent an explicit creation attempt. */ }
}
try {
  let raw = localStorage.getItem(draftStorageKey);
  // Carry over drafts saved by the earlier tab-scoped implementation.
  if (raw === null) {
    try { raw = sessionStorage.getItem(draftStorageKey); } catch {}
    if (raw !== null) localStorage.setItem(draftStorageKey, raw);
  }
  try { sessionStorage.removeItem(draftStorageKey); } catch {}
  const stored = JSON.parse(raw ?? 'null');
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  if (stored?.version === 1) {
    for (const entry of Array.isArray(stored.drafts) ? stored.drafts : []) {
      if (Array.isArray(entry) && validId(entry[0]) && typeof entry[1] === 'string') drafts.set(entry[0], entry[1]);
    }
    for (const record of Array.isArray(stored.pending) ? stored.pending : []) {
      if (record && validId(record.threadId) && validId(record.id) && typeof record.text === 'string') {
        submissions.set(record.threadId, { id: record.id, threadId: record.threadId, text: record.text, state: 'outcome-unknown', message: 'Outcome unknown. Check send status; do not resend.' });
      }
    }
  }
} catch { /* Unavailable or malformed storage falls back to in-memory drafts. */ }
function persistDrafts() {
  const pending = [...submissions.values()].filter(record => !record.turnId && ['sending', 'accepted', 'outcome-unknown'].includes(record.state) && typeof record.text === 'string')
    .map(({ id, threadId, text }) => ({ id, threadId, text }));
  try {
    const textDrafts = [...drafts].filter(([, text]) => text.length);
    if (textDrafts.length || pending.length) localStorage.setItem(draftStorageKey, JSON.stringify({ version: 1, drafts: textDrafts, pending }));
    else localStorage.removeItem(draftStorageKey);
  } catch { /* Storage denial/quota must not prevent editing or sending. */ }
}
function setDraft(threadId, text) { drafts.set(threadId, text); persistDrafts(); }
let connected = false, ready = false, authenticated = false;
let canAttachImages = false, canBrowseHistory = false, preparationCount = 0, preparationEpoch = 0;
const MAX_IMAGES = 4, MAX_SOURCE_BYTES = 20 * 1024 * 1024, MAX_DECODED_BYTES = 8 * 1024 * 1024, MAX_TOTAL_DECODED_BYTES = 20 * 1024 * 1024, MAX_EDGE = 4096;
const checking = new Set();
let initialTranscript = true, followLatest = true, bottomFrame, previousScrollTop = 0, viewportFollowLock = false, readerAnchor;
const scroller = $('message-scroll');
const navigationSession = crypto.randomUUID(), navigationThreads = new Map();
let backPending = false;
const listNavigation = () => ({ pocket: navigationSession, view: 'list' });
history.replaceState(listNavigation(), '');
history.scrollRestoration = 'manual';
function recordConversation(thread) {
  navigationThreads.set(thread.id, thread);
  while (navigationThreads.size > 32) navigationThreads.delete(navigationThreads.keys().next().value);
  const state = { pocket: navigationSession, view: 'conversation', threadId: thread.id };
  if (history.state?.pocket === navigationSession && history.state.view === 'conversation') history.replaceState(state, '');
  else history.pushState(state, '');
}

const readReceiptKey = 'pocket-read-v1', readReceipts = new Map();
let readReceiptRevision = 0;
try {
  const stored = JSON.parse(localStorage.getItem(readReceiptKey) ?? '[]');
  for (const [id, value] of Array.isArray(stored) ? stored.slice(-1000) : []) {
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(id) && value && [value.seen, value.finished].every(turn => turn === null || (typeof turn === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(turn)))) readReceipts.set(id, value);
  }
} catch { /* Read markers are optional; never persist conversation content. */ }
function saveReadReceipts() {
  ++readReceiptRevision;
  while (readReceipts.size > 1000) readReceipts.delete(readReceipts.keys().next().value);
  try { localStorage.setItem(readReceiptKey, JSON.stringify([...readReceipts])); } catch { /* Memory-only fallback. */ }
}
function observeCompletions(entries) {
  let changed = false;
  for (const thread of entries) {
    const turn = thread.latestTurn;
    if (!turn || typeof turn.id !== 'string') continue;
    const finished = turn.status === 'completed' ? turn.id : null;
    const receipt = readReceipts.get(thread.id);
    // First observation is the baseline, so old untouched chats do not light up.
    if (!receipt) { readReceipts.set(thread.id, { seen: finished, finished }); changed = true; }
    else if (finished && receipt.finished !== finished) { receipt.finished = finished; changed = true; }
  }
  if (changed) saveReadReceipts();
}
function markCurrentViewed() {
  if (!selected || !ready || document.hidden || !followLatest) return;
  const turn = selected.latestTurn, receipt = readReceipts.get(selected.id);
  if (!turn || turn.status !== 'completed' || !receipt || receipt.finished !== turn.id || receipt.seen === turn.id) return;
  if (![...items.values()].some(entry => entry.turnId === turn.id)) return;
  receipt.seen = turn.id; saveReadReceipts(); renderThreads();
}
const setView = view => { $('app').dataset.view = view; $('welcome').hidden = view !== 'list'; $('new-session').hidden = view !== 'new-session'; };
function icon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', ({ chevron: 'm9 5 7 7-7 7', copy: 'M9 5H5v14h10v-4M9 3h10v12H9z', check: 'm5 12 4 4L19 6', up: 'M12 19V5m-6 6 6-6 6 6', folder: 'M3 7V5h7l2 2h9v13H3Z' })[kind]); svg.append(path); return svg;
}
function projectName(thread) { return thread.cwd?.split('/').filter(Boolean).at(-1) || 'Codex'; }
function avatarFor(thread) {
  const project = projectName(thread);
  const words = project.split(/[-_ .]+/);
  const text = (words.length > 1 ? words.slice(0, 2).map(w => w[0]).join('') : project.slice(0, 2)).toUpperCase();
  const colors = ['#7184b4', '#9c7bb6', '#b18c66', '#6a9b90', '#bd7c89'];
  return { text, color: colors[[...project].reduce((n, char) => n + char.charCodeAt(0), 0) % colors.length] };
}
function timeLabel(seconds) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000), today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function setConnection(state) {
  $('connection').dataset.state = state; $('connection').textContent = state[0].toUpperCase() + state.slice(1);
}
function showActivity(text, state) {
  const node = $('activity');
  if (node.dataset.state === state && node.dataset.label === text) return;
  node.dataset.state = state; node.dataset.label = text; node.hidden = text === 'idle';
  node.replaceChildren(); node.title = state === 'active' ? 'Codex is working' : '';
  if (state === 'active') {
    const label = document.createElement('span'); label.className = 'sr-only'; label.textContent = 'Working';
    const dots = document.createElement('span'); dots.className = 'working-dots'; dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) dots.append(document.createElement('span'));
    node.append(label, dots);
  } else node.textContent = text;
}
function setActivity(thread, blocked = false) {
  const text = activity(thread, blocked);
  showActivity(text, /Needs action/.test(text) ? 'blocked' : thread.status.type);
}
async function api(path) { const res = await fetch(path, { cache: 'no-store' }); const body = await res.json(); if (!res.ok) { const err = new Error(body.message); err.code = body.error; if (res.status === 401) showPairing(); throw err; } return body; }
function error(err) { $('error').textContent = typeof err === 'string' ? err : err.message; }
function activity(thread, blocked = false) { return blocked || thread.status.activeFlags?.some(f => /approval|input/i.test(f)) ? 'Needs action in Codex CLI' : thread.status.type === 'active' ? 'Working' : thread.status.type; }
async function status() {
  if (!authenticated) return;
  try { const state = await api('/api/status'); setConnection(state.connection); connected = state.connection === 'connected'; canAttachImages = state.canAttachImages === true; canBrowseHistory = state.canBrowseHistory === true; updateHistoryCapability(); updateComposer(); }
  catch { setConnection('offline'); connected = false; canAttachImages = false; canBrowseHistory = false; updateHistoryCapability(); updateComposer(); }
}
function titleFor(thread) { return thread.name?.trim() || thread.preview?.trim() || 'Untitled conversation'; }
function updateHistoryCapability() {
  $('scope-all').hidden = !canBrowseHistory;
  if (!canBrowseHistory && pickerScope === 'all') setPickerScope('loaded');
}
function loadedThreads() {
  const filter = $('filter').value.trim().toLowerCase();
  return threads.filter(thread => !filter || `${thread.name ?? ''} ${thread.preview ?? ''} ${thread.cwd ?? ''}`.toLowerCase().includes(filter));
}
function renderThreads() {
  const shown = pickerScope === 'loaded' ? loadedThreads() : threads;
  $('threads').replaceChildren();
  for (const thread of shown) {
    const button = document.createElement('button'); button.className = 'thread'; button.dataset.threadId = thread.id;
    button.dataset.loaded = String(thread.loaded !== false); button.disabled = opening.has(thread.id) || pickerLoading;
    button.setAttribute('aria-current', String(selected?.id === thread.id)); button.title = thread.cwd;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true');
    const style = avatarFor(thread); avatar.textContent = style.text; avatar.style.setProperty('--avatar', style.color);
    const main = document.createElement('span'); main.className = 'thread-main';
    const top = document.createElement('span'); top.className = 'thread-top';
    const title = document.createElement('strong'); title.textContent = titleFor(thread);
    const recency = thread.recencyAt ?? thread.updatedAt;
    const time = document.createElement('time'); time.textContent = timeLabel(recency);
    if (recency) { time.dateTime = new Date(recency * 1000).toISOString(); time.title = new Date(recency * 1000).toLocaleString(); }
    top.append(title, time);
    const project = document.createElement('small'); project.textContent = projectName(thread);
    main.append(top, project);
    const chevron = icon('chevron'); chevron.classList.add('thread-chevron');
    button.append(avatar, main, chevron);
    const blocked = /Needs action/.test(activity(thread)), active = thread.status?.type === 'active';
    const receipt = readReceipts.get(thread.id), unread = receipt?.finished && receipt.finished !== receipt.seen;
    if (blocked || active || unread) {
      const state = document.createElement('span');
      state.className = `thread-state${blocked ? ' blocked' : active ? '' : ' unread'}`;
      state.title = blocked ? 'Needs action in Codex CLI' : active ? 'Working' : 'Finished — not viewed';
      state.setAttribute('aria-label', state.title); button.append(state);
    }
    button.onclick = () => openOrSelect(thread); $('threads').append(button);
  }
  $('more-threads').hidden = pickerScope !== 'all' || !pickerCursor || pickerLoading || threads.length >= 1000;
  if (!$('threads').childElementCount && !pickerLoading) { const empty = document.createElement('p'); empty.className = 'list-empty'; empty.textContent = pickerScope === 'loaded' && $('filter').value.trim() ? 'No results' : 'No conversations'; $('threads').append(empty); }
}

const newChatDraftKey = 'pocket-new-chat-draft-v1';
let newSessionMode = 'existing', newSessionChosen = false, newSessionParent = '', newSessionEditor = false, newSessionChoosing = true;
function newSessionKind() { return newSessionMode; }
function persistNewChatDraft() {
  try { localStorage.setItem(newChatDraftKey, JSON.stringify({ ...captureNewSessionForm(), chosen: newSessionChosen, editor: newSessionEditor })); } catch {}
}
function restoreNewChatDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(newChatDraftKey) ?? 'null');
    if (!saved || typeof saved.text !== 'string' || typeof saved.directory !== 'string') return;
    $('new-session-text').value = saved.text; $('new-session-directory').value = saved.directory;
    $('new-session-folder').value = typeof saved.newDirectoryName === 'string' ? saved.newDirectoryName : '';
    newSessionMode = saved.newDirectoryName !== undefined ? 'new' : 'existing'; newSessionChosen = !!saved.chosen;
    newSessionEditor = !!saved.editor; newSessionChoosing = !newSessionChosen && !newSessionEditor;
  } catch {}
}
function updateNewSessionForm() {
  const locked = !!pendingCreation && ['creating', 'outcome-unknown'].includes(pendingCreation.state), failed = pendingCreation?.state === 'failed';
  const path = $('new-session-directory').value, name = $('new-session-folder').value;
  $('new-session-choose').hidden = !newSessionChoosing;
  $('new-session-folder-editor').hidden = !newSessionEditor;
  $('new-session-ready').hidden = newSessionChoosing || newSessionEditor;
  $('new-session-folder-wrap').hidden = newSessionMode !== 'new';
  $('new-session-editor-title').textContent = newSessionMode === 'new' ? 'New folder' : 'Use another folder';
  $('new-session-directory-label').textContent = newSessionMode === 'new' ? 'Inside' : 'Folder path';
  $('new-session-destination').textContent = newSessionMode === 'new' ? `${path.replace(/\/$/, '')}/${name || 'my-project'} · Created when you send` : 'Choose an existing folder on your computer.';
  $('new-session-project-name').textContent = newSessionChosen ? (newSessionMode === 'new' ? name : path.split('/').filter(Boolean).at(-1) || path) : 'Choose project';
  $('new-session-project-path').textContent = newSessionChosen ? (newSessionMode === 'new' ? `${path.replace(/\/$/, '')}/${name} · New folder` : path) : 'Select a folder to start';
  $('new-session-change').setAttribute('aria-label', newSessionChosen ? 'Change project' : 'Choose project');
  $('new-session-change').setAttribute('aria-expanded', String(newSessionChoosing || newSessionEditor));
  $('new-session-status').textContent = pendingCreation?.message ?? '';
  $('new-session-status').dataset.state = pendingCreation?.state ?? '';
  $('new-session-start').hidden = failed;
  $('new-session-start').disabled = locked || !connected || !newSessionChosen || newSessionEditor || !$('new-session-text').value.trim();
  $('new-session-start').setAttribute('aria-busy', String(pendingCreation?.state === 'creating'));
  $('new-session-check').hidden = !locked; $('new-session-retry').hidden = !failed;
  for (const id of ['new-session-directory', 'new-session-folder', 'new-session-text', 'new-session-change', 'new-session-use-folder']) $(id).disabled = locked;
}
function chooseNewSession(path, mode = 'existing', editor = false) {
  if (pendingCreation && pendingCreation.state !== 'failed') return;
  if (pendingCreation) { pendingCreation = undefined; persistPendingCreation(); }
  newSessionMode = mode; newSessionEditor = editor; newSessionChosen = !editor; newSessionChoosing = false;
  $('new-session-directory').value = path; $('new-session-folder-error').textContent = '';
  updateNewSessionForm(); persistNewChatDraft();
  // Move focus to visible chrome, without summoning the keyboard.
  $(editor ? 'new-session-editor-title' : 'new-session-change').focus({ preventScroll: true });
}
function closeNewSession() {
  persistNewChatDraft();
  if (history.state?.pocket === navigationSession && history.state.view === 'new-session') history.back();
  else returnToList();
}
async function loadNewSessionOptions() {
  try {
    const options = await api('/api/new-session/options');
    const paths = [...new Set((Array.isArray(options.directories) ? options.directories : []).filter(path => typeof path === 'string' && path.startsWith('/')))].slice(0, 100);
    newSessionParent = options.defaultParent ?? paths[0] ?? '';
    $('new-session-directories').replaceChildren(...paths.map(path => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'project-choice';
      button.append(icon('folder'));
      const name = document.createElement('strong'); name.textContent = path.split('/').filter(Boolean).at(-1) || path;
      const location = document.createElement('span'); location.textContent = path;
      const info = document.createElement('span'); info.append(name, location); button.append(info, icon('chevron')); button.onclick = () => chooseNewSession(path);
      return button;
    }));
    $('new-session-empty').hidden = paths.length > 0;
    $('new-session-empty').textContent = 'No recent folders. Choose another folder or create a project.';
    if (!pendingCreation && !newSessionEditor && !newSessionChosen && !$('new-session-directory').value) $('new-session-directory').value = newSessionParent;
  } catch (err) { $('new-session-empty').hidden = false; $('new-session-empty').textContent = 'Recent projects unavailable. You can enter a folder path instead.'; }
}
function captureNewSessionForm() {
  return { directory: $('new-session-directory').value, newDirectoryName: newSessionKind() === 'new' ? $('new-session-folder').value : undefined, text: $('new-session-text').value };
}
function seedCreatedSession(record) {
  const showCreated = ['new-session', 'loading'].includes($('app').dataset.view);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(record?.thread?.id ?? '') || typeof record.thread.cwd !== 'string' || typeof record.thread.status?.type !== 'string') throw new Error('Invalid new chat response');
  const thread = { ...record.thread, loaded: true }, submission = record.submission;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(submission?.id ?? '') || submission.threadId !== thread.id || !['sending', 'accepted', 'completed', 'failed', 'outcome-unknown'].includes(submission.state)) throw new Error('Invalid first-message outcome');
  submissions.set(thread.id, { ...submission, text: pendingCreation?.text ?? '' });
  const unresolved = !submission.turnId;
  if (unresolved) {
    const text = pendingCreation?.text ?? submission?.text ?? '';
    drafts.set(thread.id, text);
    const current = submissions.get(thread.id) ?? { id: submission?.id, threadId: thread.id, text, state: 'outcome-unknown' };
    current.text = text; current.state = submission.state === 'failed' ? 'failed' : 'outcome-unknown'; current.message = submission?.message ?? 'First message outcome unknown. Check send status; do not resend.';
    submissions.set(thread.id, current); persistDrafts();
  }
  pendingCreation = undefined; persistPendingCreation();
  threads = threads.filter(entry => entry.id !== thread.id); mergeThreads([thread]);
  $('new-session').hidden = true;
  newSessionChosen = false; newSessionMode = 'existing'; newSessionEditor = false; newSessionChoosing = true;
  try { localStorage.removeItem(newChatDraftKey); } catch {}
  $('new-session-form').reset();
  if (showCreated) { history.replaceState(listNavigation(), ''); select(thread, true); }
  else { renderThreads(); $('announcement').textContent = 'New chat is ready in your conversations.'; }
  void loadPicker({ reset: true });
}
async function reconcileNewSession() {
  if (!authenticated || !pendingCreation) return;
  const current = creationEpoch, requestId = pendingCreation.requestId;
  try {
    const response = await fetch(`/api/new-session/${encodeURIComponent(requestId)}`, { cache: 'no-store' });
    const result = await response.json();
    if (!authenticated || current !== creationEpoch || pendingCreation?.requestId !== requestId) return;
    if (response.status === 401) { showPairing(); return; }
    if (response.status === 404) { pendingCreation.state = 'outcome-unknown'; pendingCreation.message = 'Creation status is unavailable. Check Codex CLI; this chat will not be started again automatically.'; persistPendingCreation(); updateNewSessionForm(); return; }
    if (!response.ok) throw new Error(result.message ?? 'Could not check new chat status');
    if (result.id !== requestId || !['creating', 'created', 'outcome-unknown', 'failed'].includes(result.state)) throw new Error('Invalid creation status');
    pendingCreation = { ...pendingCreation, ...result };
    if (result.state === 'created') seedCreatedSession(result); else if (result.state === 'failed') persistPendingCreation(); else persistPendingCreation();
    updateNewSessionForm();
  } catch (err) { if (!authenticated || current !== creationEpoch || pendingCreation?.requestId !== requestId) return; pendingCreation.state = 'outcome-unknown'; pendingCreation.message = `Could not verify new chat status. Check Codex CLI before retrying. ${err.message ?? ''}`.trim(); persistPendingCreation(); updateNewSessionForm(); }
}
async function startNewSession(event) {
  event.preventDefault();
  if ($('new-session-start').disabled) return;
  const fields = captureNewSessionForm();
  if (!/^\//.test(fields.directory) || !fields.text.trim() || (newSessionKind() === 'new' && !fields.newDirectoryName)) { $('new-session-status').textContent = 'Choose an absolute existing directory and enter a first message.'; return; }
  const requestId = crypto.randomUUID(), current = creationEpoch;
  pendingCreation = { requestId, ...fields, state: 'creating', message: 'Creating chat…' }; persistPendingCreation(); updateNewSessionForm();
  try {
    const response = await fetch('/api/new-session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: JSON.stringify({ clientRequestId: requestId, ...fields }) });
    const result = await response.json();
    if (!authenticated || current !== creationEpoch || pendingCreation?.requestId !== requestId) return;
    if (response.status === 401) { showPairing(); return; }
    if (!response.ok) {
      if ([400, 403, 409, 413, 429].includes(response.status)) { pendingCreation.state = 'failed'; pendingCreation.message = result.message ?? 'Check the new chat fields and try again.'; persistPendingCreation(); updateNewSessionForm(); return; }
      if (result?.id === requestId && result?.state) { pendingCreation = { ...pendingCreation, ...result }; persistPendingCreation(); updateNewSessionForm(); return; }
      throw new Error(result.message ?? 'Could not start chat');
    }
    if (result.id !== requestId || !['creating', 'created', 'outcome-unknown', 'failed'].includes(result.state)) throw new Error('Invalid new chat response');
    pendingCreation = { ...pendingCreation, ...result };
    if (result.state === 'created') seedCreatedSession(result); else { persistPendingCreation(); updateNewSessionForm(); }
  } catch (err) { if (!authenticated || current !== creationEpoch || pendingCreation?.requestId !== requestId) return; pendingCreation.state = 'outcome-unknown'; pendingCreation.message = 'Creation outcome unknown. Check status or Codex CLI; do not retry automatically.'; persistPendingCreation(); updateNewSessionForm(); }
}
function mergeThreads(entries, replace = false) {
  observeCompletions(entries);
  const byId = new Map(replace ? [] : threads.map(thread => [thread.id, thread]));
  for (const thread of entries) if (byId.size < 1000 || byId.has(thread.id)) byId.set(thread.id, { ...byId.get(thread.id), ...thread });
  threads = [...byId.values()].slice(0, 1000);
}
async function loadPicker({ reset = false, append = false } = {}) {
  if (!authenticated || (pickerScope === 'all' && !canBrowseHistory)) return;
  const generation = reset ? ++pickerGeneration : pickerGeneration;
  pickerLoading = true; renderThreads();
  try {
    let result;
    if (pickerScope === 'loaded') {
      result = await api('/api/threads');
      if (generation !== pickerGeneration) return;
      mergeThreads(result.map(thread => ({ ...thread, loaded: true })), true);
      pickerCursor = null;
    } else {
      const params = new URLSearchParams(); if (pickerQuery) params.set('search', pickerQuery); if (append && pickerCursor) params.set('cursor', pickerCursor);
      result = await api(`/api/saved-threads${params.toString() ? `?${params}` : ''}`);
      if (generation !== pickerGeneration) return;
      mergeThreads(result.data ?? [], !append); pickerCursor = result.nextCursor ?? null;
    }
    renderThreads();
  } catch (err) { if (generation === pickerGeneration) error(err); }
  finally { if (generation === pickerGeneration) { pickerLoading = false; renderThreads(); } }
}
async function list() { if (!authenticated) return; $('error').textContent = ''; await status(); if (authenticated) await loadPicker({ reset: true }); }
function setPickerScope(scope) {
  if (scope === 'all' && !canBrowseHistory) return;
  clearTimeout(pickerTimer); ++openIntent;
  pickerScope = scope; pickerQuery = $('filter').value.trim(); pickerCursor = null; ++pickerGeneration;
  $('scope-loaded').setAttribute('aria-pressed', String(scope === 'loaded')); $('scope-all').setAttribute('aria-pressed', String(scope === 'all'));
  $('filter').setAttribute('aria-label', scope === 'all' ? 'Search conversations in All' : 'Filter by title or project');
  $('filter').placeholder = scope === 'all' ? 'Search conversations' : 'Search'; void loadPicker();
}
function setPickerQuery(value) {
  pickerQuery = value.trim(); pickerCursor = null; ++openIntent;
  if (pickerScope === 'loaded') renderThreads();
  else { ++pickerGeneration; pickerLoading = true; clearTimeout(pickerTimer); pickerTimer = setTimeout(() => void loadPicker(), 250); renderThreads(); }
}
async function openOrSelect(thread) {
  if (thread.loaded !== false) { ++openIntent; select(thread, true); return; }
  if (opening.has(thread.id) || !authenticated) return;
  const intent = ++openIntent, currentEpoch = epoch, generation = pickerGeneration;
  opening.add(thread.id); renderThreads(); $('error').textContent = '';
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(thread.id)}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: '{}' });
    const result = await response.json();
    if (response.status === 401) { showPairing(); return; }
    if (!response.ok) throw new Error(result.message ?? 'Could not open conversation');
    if (!result || result.id !== thread.id || !result.status) throw new Error('Invalid conversation response');
    if (!authenticated || intent !== openIntent || currentEpoch !== epoch || generation !== pickerGeneration) return;
    const opened = { ...result, loaded: true }; threads = threads.map(entry => entry.id === thread.id ? opened : entry); select(opened, true);
  } catch (err) { if (authenticated && intent === openIntent && currentEpoch === epoch && generation === pickerGeneration) error(err); }
  finally { opening.delete(thread.id); renderThreads(); }
}
function safeAttachmentUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === location.origin && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && /^\/api\/attachments\/[0-9a-f]{64}$/.test(parsed.pathname) ? parsed.href : null;
  } catch { return null; }
}
function imageParts(item) {
  return (item.content ?? []).filter(part => part?.type === 'image' || part?.type === 'localImage').map(part => ({ url: safeAttachmentUrl(part.url), width: part.width, height: part.height, placeholder: part.type === 'localImage' || !safeAttachmentUrl(part.url) }));
}
function renderImages(parts, bubble) {
  for (const part of parts) {
    if (!part.url) { const placeholder = document.createElement('span'); placeholder.className = 'image-placeholder'; placeholder.textContent = 'Image'; bubble.append(placeholder); continue; }
    const image = document.createElement('img'); image.className = 'message-image'; image.src = part.url; image.alt = 'Attached image'; image.loading = 'lazy';
    if ([part.width, part.height].every(size => Number.isInteger(size) && size > 0 && size <= 4096)) {
      image.width = part.width; image.height = part.height;
      image.style.width = `${Math.min(part.width, 320, 320 * part.width / part.height)}px`;
      image.style.aspectRatio = `${part.width} / ${part.height}`;
    }
    const link = document.createElement('a'); link.className = 'message-image-link'; link.href = part.url; link.target = '_blank'; link.rel = 'noopener'; link.append(image); bubble.append(link);
  }
}
function atBottom() { return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2; }
function scrollToLatest() { readerAnchor = undefined; scroller.scrollTop = scroller.scrollHeight; previousScrollTop = scroller.scrollTop; $('new-content').hidden = true; markCurrentViewed(); }
function captureReaderAnchor() {
  const bounds = scroller.getBoundingClientRect();
  const visible = node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom; };
  const rows = [...$('transcript').children].filter(visible);
  const row = rows.find(node => !node.classList.contains('activity')) ?? rows[0];
  if (!row) return;
  const node = [...row.querySelectorAll('.bubble>p,.bubble pre,.message-image')].find(visible) ?? row;
  return { epoch, key: row.dataset.key, node, offset: node.getBoundingClientRect().top - bounds.top, rowOffset: row.getBoundingClientRect().top - bounds.top };
}
function restoreReaderAnchor() {
  const anchor = readerAnchor;
  if (!anchor || anchor.epoch !== epoch || followLatest || !selected) return;
  const row = [...$('transcript').children].find(node => node.dataset.key === anchor.key);
  const node = anchor.node.isConnected ? anchor.node : row;
  if (!node) { readerAnchor = undefined; return; }
  const offset = node === anchor.node ? anchor.offset : anchor.rowOffset;
  const delta = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  if (Math.abs(delta) > .5) scroller.scrollTop += delta;
  previousScrollTop = scroller.scrollTop;
}
function settleBottom() {
  if (!selected || !followLatest || bottomFrame !== undefined) return;
  const current = epoch;
  bottomFrame = requestAnimationFrame(() => {
    bottomFrame = undefined;
    if (current === epoch && selected && followLatest) scrollToLatest();
  });
}
function render(preservePosition = false) {
  if (preservePosition) viewportFollowLock = false;
  const follow = !preservePosition && (initialTranscript || followLatest);
  if (!follow) readerAnchor = captureReaderAnchor();
  while (items.size > 1000) items.delete(items.keys().next().value);
  $('history-bound').hidden = items.size < 1000;
  const expanded = new Set([...$('transcript').querySelectorAll('details[open][data-key]')].map(details => details.dataset.key));
  const codeScroll = new Map([...$('transcript').querySelectorAll('.code-block')].map(pre => [pre.dataset.key, pre.scrollLeft]));
  const transcript = $('transcript');
  const existingRows = new Map([...transcript.children].map(row => [row.dataset.key, row]));
  const nextRows = [];
  const toolNames = { commandExecution: 'Terminal', fileChange: 'Files', reasoning: 'Thinking', mcpToolCall: 'Tool', webSearch: 'Search', plan: 'Plan' };
  let activityGroup;
  for (const [key, { item, turnId }] of items) {
    const chat = ['userMessage', 'agentMessage'].includes(item.type);
    // Keep unchanged messages (especially decoded images) mounted while paging
    // or streaming. Recreating them briefly collapses their measured height.
    const signature = chat ? JSON.stringify(item) : null;
    const existingRow = existingRows.get(key);
    if (chat && existingRow?.itemSignature === signature) {
      activityGroup = undefined; nextRows.push(existingRow); continue;
    }
    const row = document.createElement('article'); row.className = `message ${item.type}${chat ? '' : ' activity'}`; row.dataset.key = key;
    row.itemSignature = signature;
    row.setAttribute('aria-label', item.type === 'userMessage' ? 'You' : item.type === 'agentMessage' ? 'Codex' : 'Activity');
    const text = item.text || (item.delivery === 'async' && Array.isArray(item.questions) ? item.questions.filter(q => q && typeof q.title === 'string').map(q => [q.title, ...(Array.isArray(q.options) ? q.options.filter(option => typeof option === 'string') : []).map(option => `• ${option}`)].join('\n')).join('\n\n') : (item.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n'));
    if (chat) {
      activityGroup = undefined;
      const bubble = document.createElement('div'); bubble.className = 'bubble'; renderMarkdown(text, bubble); renderImages(imageParts(item), bubble); row.append(bubble);
      if (item.type === 'agentMessage') {
        const copy = document.createElement('button'); copy.className = 'copy-button'; copy.setAttribute('aria-label', 'Copy message'); copy.title = 'Copy'; copy.append(icon('copy'));
        copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.replaceChildren(icon('check')); copy.setAttribute('aria-label', 'Copied'); $('announcement').textContent = 'Message copied'; setTimeout(() => { copy.replaceChildren(icon('copy')); copy.setAttribute('aria-label', 'Copy message'); }, 1500); } catch (err) { error(err); } };
        row.append(copy);
      }
    } else {
      if (!activityGroup || activityGroup.turnId !== turnId) {
        const groupKey = `activity/${key}`;
        const group = document.createElement('details'); group.dataset.key = groupKey; group.open = expanded.has(groupKey);
        const heading = document.createElement('summary');
        const content = document.createElement('div'); content.className = 'activity-items';
        group.append(heading, content); row.append(group); nextRows.push(row);
        activityGroup = { turnId, heading, content, count: 0, working: false };
      }
      activityGroup.count++;
      activityGroup.working ||= item.status === 'inProgress';
      activityGroup.heading.textContent = `Activity · ${activityGroup.count}${activityGroup.working ? ' · Working' : ''}`;
      const details = document.createElement('details'); details.dataset.key = key; details.open = expanded.has(key);
      const summary = document.createElement('summary');
      const state = ({ inProgress: 'Working', completed: 'Done', failed: 'Failed', declined: 'Declined' })[item.status] ?? item.status;
      summary.textContent = `${toolNames[item.type] ?? 'Activity'}${state ? ` · ${state}` : ''}`;
      const pre = document.createElement('pre'); pre.textContent = text || item.command || ''; details.append(summary); if (pre.textContent) details.append(pre); activityGroup.content.append(details);
      continue;
    }
    nextRows.push(row);
    row.querySelectorAll('.code-block').forEach((pre, i) => { pre.dataset.key = `${key}/${i}`; pre.scrollLeft = codeScroll.get(pre.dataset.key) ?? 0; });
  }
  let position = transcript.firstChild;
  for (const row of nextRows) {
    if (row !== position) transcript.insertBefore(row, position);
    position = row.nextSibling;
  }
  while (position) { const next = position.nextSibling; position.remove(); position = next; }
  initialTranscript = false;
  followLatest = follow;
  if (follow) { scrollToLatest(); settleBottom(); }
  else { restoreReaderAnchor(); $('new-content').hidden = atBottom(); }
}
async function hydrate(older = false) {
  if (!selected || !authenticated || document.hidden) return;
  if (older && (!cursor || items.size >= 1000)) return;
  if (busy) { if (!older) dirty = true; return; }
  busy = true; const current = epoch; const id = selected.id;
  const requestedCursor = cursor;
  if (older) { historyAutoArmed = false; historyLoading = true; updateHistoryControl(); }
  try {
    const page = await api(`/api/threads/${id}/history${older ? `?cursor=${encodeURIComponent(requestedCursor)}` : ''}`);
    // A slow response may arrive after the reader has started another swipe.
    // Hold the prepend until that motion settles, without starting another read.
    while (older && current === epoch && Date.now() - historyScrollAt < 180) {
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    if (current !== epoch) return;
    if (older) {
      // Stop automatic paging if the source cannot advance, rather than loop.
      if (page.nextCursor && (page.nextCursor === requestedCursor || !page.data.some(entry => !items.has(`${entry.turnId}/${entry.item.id}`)))) throw new Error('Earlier history did not advance. Try loading it again.');
      const combined = new Map(page.data.map(entry => [`${entry.turnId}/${entry.item.id}`, entry]));
      for (const [key, value] of items) combined.set(key, value);
      items.clear(); for (const [key, value] of combined) items.set(key, value);
      cursor = page.nextCursor; historyFailed = false;
      render(true); updateHistoryControl(); restoreReaderAnchor();
    } else {
      for (const entry of page.data) items.set(`${entry.turnId}/${entry.item.id}`, entry);
      render();
    }
    if (older || cursor === undefined) cursor = page.nextCursor;
    updateHistoryControl(); setActivity(page.thread, page.blocked); selected = { ...page.thread, blocked: page.blocked, question: page.question ?? null }; ready = true; observeCompletions([page.thread]); markCurrentViewed(); renderThreads(); updateComposer(); $('error').textContent = '';
  } catch (err) { if (current === epoch) { if (older) historyFailed = true; error(err); } }
  finally {
    busy = false;
    if (current === epoch) { historyLoading = false; updateHistoryControl(); restoreReaderAnchor(); }
    if (dirty) { dirty = false; schedule(); }
    if (current === epoch && historyAutoArmed) scheduleEarlierHistory();
  }
}
function updateHistoryControl() {
  // Retain the loading row's space at the beginning of a paged transcript.
  // Otherwise hiding it on the last page can require a negative scroll offset.
  if (cursor) $('older').parentElement.dataset.paged = 'true';
  $('older').hidden = !cursor || items.size >= 1000;
  $('older').disabled = historyLoading;
  $('older').textContent = historyLoading ? 'Loading earlier messages…' : historyFailed ? 'Retry earlier messages' : 'Load earlier messages';
}
function maybeLoadEarlier() {
  if (!historyAutoArmed || !ready || followLatest || busy || historyFailed || scroller.scrollTop > 160) return;
  void hydrate(true);
}
function scheduleEarlierHistory() {
  clearTimeout(historyScrollTimer);
  const current = epoch;
  // Wait for scrolling to settle. In particular, don't adjust scrollTop while
  // iOS is still applying touch momentum, or react to our own prepend offset.
  historyScrollTimer = setTimeout(() => {
    historyScrollTimer = undefined;
    if (current === epoch) maybeLoadEarlier();
  }, 180);
}
function schedule() { if (!timer) timer = setTimeout(() => { timer = undefined; void hydrate(); }, 250); }
function select(thread, navigate = false) {
  if (navigate) recordConversation(thread);
  source?.close(); ++epoch; selected = thread; ready = false; initialTranscript = true; followLatest = true; viewportFollowLock = false; historyLoading = false; historyFailed = false; historyAutoArmed = true; setView('conversation'); items.clear(); cursor = undefined;
  $('picker').hidden = true; $('conversation').hidden = false; $('title').textContent = titleFor(thread); $('project').textContent = projectName(thread); $('project').title = thread.cwd;
  const avatar = avatarFor(thread); $('contact-avatar').textContent = avatar.text; $('contact-avatar').style.setProperty('--avatar', avatar.color); renderThreads();
  $('history-bound').hidden = true; $('older').hidden = true; $('new-content').hidden = true;
  delete $('older').parentElement.dataset.paged;
  $('draft').value = drafts.get(thread.id) ?? ''; $('transcript').replaceChildren(); previousScrollTop = scroller.scrollTop; showActivity('Connecting', 'connecting'); resizeDraft(); updateComposer();
  source = new EventSource(`/api/threads/${thread.id}/events`);
  const current = epoch;
  source.addEventListener('ready', () => { if (current === epoch) void hydrate(); });
  source.addEventListener('change', event => { if (current !== epoch) return; const notice = JSON.parse(event.data); if (notice.method === 'turn/completed') $('announcement').textContent = 'Reply finished'; if (notice.needsCli) { selected.blocked = true; setActivity(selected, true); } if (notice.method === 'turn/started') { selected.question = null; selected.status = { type: 'active' }; setActivity(selected, selected.blocked); } updateComposer(); schedule(); });
  source.addEventListener('connection', event => { if (current !== epoch) return; const state = JSON.parse(event.data); setConnection(state.connection); connected = state.connection === 'connected'; ready = false; updateComposer(); if (state.connection === 'connected') { source.close(); select(selected); } });
  source.onerror = () => { if (current !== epoch) return; setConnection('reconnecting'); ready = false; updateComposer(); void status(); };
  void checkSubmission(thread.id);
}
function updateComposer() {
  if ($('app').dataset.view === 'new-session') updateNewSessionForm();
  const pending = selected && submissions.get(selected.id);
  const questionReply = selected?.question && !selected.blocked && (selected.status.type === 'idle' || (selected.status.type === 'active' && selected.latestTurn?.id === selected.question.turnId));
  const activeTurnId = selected?.status.type === 'active' && selected.latestTurn?.status === 'inProgress' ? selected.latestTurn.id : null;
  const targetTurnId = activeTurnId ?? (questionReply ? selected.question.turnId : null);
  const locked = pending && (['sending', 'outcome-unknown'].includes(pending.state) || (pending.state === 'accepted' && (!targetTurnId || pending.turnId !== targetTurnId)));
  const draftImages = selected ? attachments.get(selected.id) ?? [] : [];
  $('send').disabled = !selected || !connected || !ready || (selected.status.type !== 'idle' && !activeTurnId) || selected.blocked || !!locked || !!preparationCount || (draftImages.length > 0 && !canAttachImages) || (!$('draft').value.trim() && !draftImages.length);
  $('attach').disabled = !selected || !canAttachImages || !!locked || !!preparationCount || draftImages.length >= MAX_IMAGES;
  $('attach').title = canAttachImages ? 'Attach images' : 'Image attachments unavailable';
  $('send').setAttribute('aria-label', pending?.state === 'sending' ? 'Sending…' : 'Send');
  $('send').setAttribute('aria-busy', String(pending?.state === 'sending'));
  $('send').title = questionReply ? 'Reply to question' : activeTurnId ? 'Send follow-up' : 'Send';
  $('draft').placeholder = questionReply ? 'Reply to question' : activeTurnId ? 'Follow-up' : 'Message';
  $('submission-status').textContent = pending && ['failed', 'outcome-unknown'].includes(pending.state) ? pending.message ?? '' : '';
  $('submission-status').dataset.state = pending?.state ?? '';
  resizeDraft();
  $('check-submission').hidden = pending?.state !== 'outcome-unknown';
  renderAttachments();
}
let attachmentPreview;
function openAttachmentPreview(image, pointer = false) {
  if (!selected) return;
  attachmentPreview = { threadId: selected.id, imageId: image.id };
  $('attachment-preview').dataset.pointer = String(pointer);
  $('attachment-preview-name').textContent = image.name;
  $('attachment-preview-image').alt = image.name;
  $('attachment-preview-image').src = image.dataUrl;
  if (!$('attachment-preview').open) $('attachment-preview').showModal();
}
$('attachment-preview-close').onclick = () => $('attachment-preview').close();
$('attachment-preview').addEventListener('keydown', () => { delete $('attachment-preview').dataset.pointer; });
$('attachment-preview').addEventListener('pointerdown', () => { $('attachment-preview').dataset.pointer = 'true'; });
$('attachment-preview').addEventListener('close', () => {
  const previous = attachmentPreview; attachmentPreview = undefined;
  $('attachment-preview-image').removeAttribute('src');
  $('attachment-preview-image').alt = ''; $('attachment-preview-name').textContent = '';
  if (selected?.id === previous?.threadId) {
    [...$('attachments').querySelectorAll('.attachment-open')].find(button => button.dataset.imageId === previous.imageId)?.focus({ preventScroll: true });
  }
});
function renderAttachments() {
  const tray = $('attachments'); tray.replaceChildren();
  const current = selected ? attachments.get(selected.id) ?? [] : [];
  if ($('attachment-preview').open && (attachmentPreview?.threadId !== selected?.id || !current.some(image => image.id === attachmentPreview?.imageId))) $('attachment-preview').close();
  for (const image of current) {
    const figure = document.createElement('figure'); figure.className = 'attachment';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'attachment-open'; open.dataset.imageId = image.id;
    open.setAttribute('aria-label', `Preview image ${image.name}`); open.setAttribute('aria-haspopup', 'dialog');
    const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; preview.loading = 'lazy'; open.append(preview);
    open.onclick = event => openAttachmentPreview(image, event.detail > 0); figure.append(open);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.setAttribute('aria-label', `Remove image ${image.name}`); remove.title = `Remove ${image.name}`; remove.textContent = '×';
    remove.onclick = () => { const next = (attachments.get(selected.id) ?? []).filter(entry => entry.id !== image.id); attachments.set(selected.id, next); renderAttachments(); updateComposer(); };
    figure.append(remove); tray.append(figure);
  }
  tray.hidden = !current.length;
}
function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error(`${file.name || 'File'} is not an image`));
    if (file.size > MAX_SOURCE_BYTES) return reject(new Error(`${file.name || 'Image'} is larger than 20 MiB`));
    const url = URL.createObjectURL(file), image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
      if (image.naturalWidth * image.naturalHeight > 32_000_000) return reject(new Error(`${file.name || 'Image'} has too many pixels`));
      try {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); if (!context) return reject(new Error(`Could not prepare ${file.name || 'image'}`));
      context.drawImage(image, 0, 0, width, height);
      const screenshot = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/bmp';
      let dataUrl = canvas.toDataURL(screenshot ? 'image/png' : 'image/jpeg', screenshot ? undefined : 0.86);
      const byteSize = url => Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);
      if (byteSize(dataUrl) > MAX_DECODED_BYTES) dataUrl = canvas.toDataURL('image/jpeg', 0.86);
      const decoded = byteSize(dataUrl);
      if (decoded > MAX_DECODED_BYTES) throw new Error(`${file.name || 'Image'} is larger than 8 MiB after preparation`);
      resolve({ id: crypto.randomUUID(), name: file.name || 'image', dataUrl, decoded });
      } catch (err) { reject(err); }
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name || 'image'}`)); };
    image.src = url;
  });
}
async function addImageFiles(fileList) {
  if (!selected || !canAttachImages) return;
  const threadId = selected.id, batch = [...fileList].filter(file => file.type.startsWith('image/'));
  const current = attachments.get(threadId) ?? [];
  if (!batch.length) return;
  if (current.length + batch.length > MAX_IMAGES) { error(`You can attach up to ${MAX_IMAGES} images.`); return; }
  if (preparationCount) { error('Images are still being prepared. Try again in a moment.'); return; }
  if (!attachments.has(threadId) && attachments.size >= 32) { error('Too many image drafts. Remove unused attachments first.'); return; }
  const run = preparationEpoch; preparationCount++; updateComposer();
  try {
    const prepared = await Promise.all(batch.map(readImage));
    if (run !== preparationEpoch || !authenticated) return;
    if (current.reduce((sum, image) => sum + image.decoded, 0) + prepared.reduce((sum, image) => sum + image.decoded, 0) > MAX_TOTAL_DECODED_BYTES) throw new Error('Attached images exceed 20 MiB.');
    attachments.set(threadId, [...(attachments.get(threadId) ?? []), ...prepared]); renderAttachments(); updateComposer();
  } catch (err) { if (run === preparationEpoch) error(err); }
  finally { preparationCount--; updateComposer(); }
}
function applySubmission(threadId, result) {
  const previous = submissions.get(threadId);
  if (!previous || previous.id !== result.id || result.threadId !== threadId) return;
  Object.assign(previous, result);
  // Only clear the captured draft once acceptance is authoritative. Preserve edits made meanwhile.
  if (result.turnId) {
    if (typeof previous.text === 'string' && drafts.get(threadId) === previous.text) {
      drafts.set(threadId, '');
      if (selected?.id === threadId && $('draft').value === previous.text) $('draft').value = '';
    }
    if (Array.isArray(previous.images) && previous.images.length) {
      const captured = new Set(previous.images.map(image => image.id));
      attachments.set(threadId, (attachments.get(threadId) ?? []).filter(image => !captured.has(image.id)));
      previous.images = []; // Release accepted image bytes; history uses authenticated thumbnails.
    }
  }
  persistDrafts(); updateComposer();
}
async function checkSubmission(threadId) {
  const pending = submissions.get(threadId);
  if (!authenticated || !pending || !['sending', 'accepted', 'outcome-unknown'].includes(pending.state) || checking.has(pending.id)) return;
  checking.add(pending.id);
  try { applySubmission(threadId, await api(`/api/submissions/${pending.id}`)); }
  catch (err) {
    if (err.code === 'not-found') { pending.state = 'outcome-unknown'; pending.message = 'Send status unavailable. Check Codex CLI before sending again.'; }
  } finally { checking.delete(pending.id); updateComposer(); }
}
$('send').onclick = async () => {
  if ($('send').disabled || !selected) return;
  // Capture the target and exact text before any await or navigation.
  const question = selected.question;
  const expectedTurnId = selected.status.type === 'active' ? selected.latestTurn?.id : undefined;
  const threadId = selected.id, text = $('draft').value, images = [...(attachments.get(threadId) ?? [])];
  const pending = { id: crypto.randomUUID(), threadId, text, images, state: 'sending', message: 'Sending…' };
  drafts.set(threadId, text); submissions.set(threadId, pending); persistDrafts(); updateComposer();
  try {
    const res = await fetch(`/api/threads/${threadId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pocket-Request': '1' },
      body: JSON.stringify({ text, images: images.map(image => ({ dataUrl: image.dataUrl })), clientSubmissionId: pending.id, ...(question ? { question } : {}), ...(expectedTurnId ? { expectedTurnId } : {}) }),
    });
    const result = await res.json();
    if (!res.ok) {
      pending.state = res.status >= 500 ? 'outcome-unknown' : 'failed';
      pending.message = result.message ?? 'Send failed';
    } else if (result.id === pending.id && result.threadId === threadId && typeof result.state === 'string') applySubmission(threadId, result);
    else throw new Error('Invalid submission response');
  } catch {
    pending.state = 'outcome-unknown'; pending.message = 'Outcome unknown. Check send status; do not resend.';
  } finally { persistDrafts(); updateComposer(); if (selected?.id === threadId) schedule(); }
};
$('check-submission').onclick = () => { if (selected) void checkSubmission(selected.id); };
setInterval(() => { if (document.hidden || !authenticated) return; for (const threadId of submissions.keys()) void checkSubmission(threadId); }, 3000);
function resizeDraft() { $('draft').style.height = 'auto'; $('draft').style.height = `${Math.min($('draft').scrollHeight || 32, 132)}px`; }
$('draft').oninput = () => { if (selected) setDraft(selected.id, $('draft').value); updateComposer(); };
$('attach').onclick = () => { if (!$('attach').disabled) $('image-input').click(); };
$('image-input').onchange = event => { void addImageFiles(event.target.files); event.target.value = ''; };
$('draft').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
  if (!files.length || !canAttachImages || $('attach').disabled) return;
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain');
  if (text) { $('draft').setRangeText(text, $('draft').selectionStart, $('draft').selectionEnd, 'end'); setDraft(selected.id, $('draft').value); }
  void addImageFiles(files);
});
function returnToList() {
  ++epoch; ++openIntent; source?.close(); selected = undefined; ready = false;
  clearTimeout(timer); timer = undefined;
  $('conversation').hidden = true; $('picker').hidden = false; setView('list'); updateComposer(); void list();
}
async function openNewSession(navigate = true) {
  if (!authenticated) return;
  $('error').textContent = ''; source?.close(); ++epoch; ++openIntent; selected = undefined; ready = false;
  clearTimeout(timer); timer = undefined;
  if (navigate && history.state?.view !== 'new-session') history.pushState({ pocket: navigationSession, view: 'new-session' }, '');
  if (pendingCreation) {
    $('new-session-directory').value = pendingCreation.directory ?? ''; $('new-session-folder').value = pendingCreation.newDirectoryName ?? ''; $('new-session-text').value = pendingCreation.text ?? '';
    newSessionMode = pendingCreation.newDirectoryName ? 'new' : 'existing'; newSessionChosen = true; newSessionEditor = false; newSessionChoosing = false;
  }
  setView('new-session'); $('conversation').hidden = true; $('picker').hidden = false; renderThreads(); updateNewSessionForm();
  if (navigate) $('new-session-title').focus({ preventScroll: true });
  if (!pendingCreation) await loadNewSessionOptions();
  if ($('app').dataset.view === 'new-session') updateNewSessionForm();
}
$('back').onclick = () => {
  if (backPending) return;
  if (history.state?.pocket === navigationSession && history.state.view === 'conversation') { backPending = true; history.back(); }
  else { history.replaceState(listNavigation(), ''); returnToList(); }
};
window.addEventListener('popstate', event => {
  backPending = false;
  if (!authenticated) { history.replaceState(listNavigation(), ''); showPairing(); return; }
  const state = event.state;
  if (state?.pocket === navigationSession && state.view === 'new-session') { void openNewSession(false); return; }
  if (state?.pocket === navigationSession && state.view === 'conversation') {
    const thread = navigationThreads.get(state.threadId);
    if (thread) { ++openIntent; select(thread); return; }
  }
  history.replaceState(listNavigation(), ''); returnToList();
});
$('new-chat').onclick = () => { void openNewSession(); };
$('new-session-form').onsubmit = event => { void startNewSession(event); };
$('new-session-create-folder').onclick = () => chooseNewSession(newSessionParent, 'new', true);
$('new-session-other-folder').onclick = () => chooseNewSession('', 'existing', true);
$('new-session-change').onclick = () => {
  if (pendingCreation && pendingCreation.state !== 'failed') return;
  if (pendingCreation) { pendingCreation = undefined; persistPendingCreation(); }
  newSessionChoosing = !newSessionChoosing; newSessionEditor = false; updateNewSessionForm();
  if (newSessionChoosing) ($('new-session-directories').querySelector('button') ?? $('new-session-create-folder')).focus({ preventScroll: true });
};
$('new-session-folder-back').onclick = () => { newSessionEditor = false; newSessionChoosing = true; updateNewSessionForm(); };
$('new-session-use-folder').onclick = () => {
  const path = $('new-session-directory').value, name = $('new-session-folder').value;
  if (!path.startsWith('/') || (newSessionMode === 'new' && (!name.trim() || name === '.' || name === '..' || /[\/\\]/.test(name)))) {
    $('new-session-folder-error').textContent = 'Enter an absolute folder path' + (newSessionMode === 'new' ? ' and a folder name without slashes.' : '.'); return;
  }
  newSessionChosen = true; newSessionEditor = false; newSessionChoosing = false; updateNewSessionForm(); persistNewChatDraft(); $('new-session-change').focus({ preventScroll: true });
};
for (const id of ['new-session-directory', 'new-session-folder', 'new-session-text']) $(id).oninput = () => { updateNewSessionForm(); persistNewChatDraft(); };
$('new-session-close').onclick = closeNewSession;
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('app').dataset.view !== 'new-session' || $('attachment-preview').open) return;
  event.preventDefault();
  if (newSessionEditor || (newSessionChoosing && newSessionChosen)) { newSessionEditor = false; newSessionChoosing = !newSessionChosen; updateNewSessionForm(); $('new-session-change').focus({ preventScroll: true }); } else closeNewSession();
});
restoreNewChatDraft();
$('new-session-check').onclick = () => { void reconcileNewSession(); };
$('new-session-retry').onclick = () => {
  pendingCreation = undefined; persistPendingCreation();
  updateNewSessionForm(); $('new-session-form').requestSubmit($('new-session-start'));
};
$('scope-loaded').onclick = () => setPickerScope('loaded'); $('scope-all').onclick = () => setPickerScope('all'); $('filter').oninput = event => setPickerQuery(event.target.value); $('more-threads').onclick = () => { if (!pickerLoading) void loadPicker({ append: true }); }; $('older').onclick = () => { historyFailed = false; void hydrate(true); };
$('new-content').onclick = () => { followLatest = true; scrollToLatest(); settleBottom(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) { ++epoch; source?.close(); ready = false; updateComposer(); } else void bootstrap(); });
window.addEventListener('pageshow', event => { if (event.persisted) void bootstrap(); });
window.addEventListener('pagehide', () => source?.close());
setInterval(() => { if (!document.hidden) void status(); }, 5000);

let refreshingActivity = false;
setInterval(async () => {
  if (!authenticated || !connected || document.hidden || refreshingActivity || pickerLoading || (selected && innerWidth <= 800)) return;
  const generation = pickerGeneration, receiptRevision = readReceiptRevision;
  refreshingActivity = true;
  try {
    const loaded = await api('/api/threads');
    if (!authenticated || generation !== pickerGeneration || receiptRevision !== readReceiptRevision) return;
    observeCompletions(loaded);
    if (pickerScope === 'loaded') mergeThreads(loaded.map(thread => ({ ...thread, loaded: true })), true);
    else {
      const byId = new Map(loaded.map(thread => [thread.id, thread]));
      threads = threads.map(thread => byId.has(thread.id) ? { ...thread, ...byId.get(thread.id), loaded: true } : thread);
    }
    renderThreads();
  } catch { /* Preserve last confirmed indicators when offline. */ }
  finally { refreshingActivity = false; }
}, 5000);


function showPairing() {
  ++creationEpoch;
  $('new-session').hidden = true;
  $('new-session-form').reset(); newSessionChosen = false; newSessionMode = 'existing'; newSessionEditor = false; newSessionChoosing = true;
  try { localStorage.removeItem(newChatDraftKey); } catch {}
  if ($('attachment-preview').open) $('attachment-preview').close();
  readReceipts.clear(); try { localStorage.removeItem(readReceiptKey); } catch {}
  navigationThreads.clear(); backPending = false; history.replaceState(listNavigation(), '');
  authenticated = false; connected = false; ready = false; ++epoch; source?.close(); selected = undefined;
  clearTimeout(timer); timer = undefined; threads = []; items.clear(); drafts.clear(); submissions.clear();
  try { localStorage.removeItem(draftStorageKey); } catch {}
  try { sessionStorage.removeItem(draftStorageKey); } catch {}
  clearTimeout(pickerTimer); ++pickerGeneration; ++openIntent; pickerLoading = false; $('filter').value = '';
  attachments.clear(); canAttachImages = false; canBrowseHistory = false; pickerScope = 'loaded'; pickerCursor = null; pickerQuery = ''; opening.clear(); preparationEpoch++;
  pendingCreation = undefined; persistPendingCreation();
  $('draft').value = ''; $('threads').replaceChildren(); $('transcript').replaceChildren(); $('scope-all').hidden = true; $('scope-loaded').setAttribute('aria-pressed', 'true'); $('scope-all').setAttribute('aria-pressed', 'false');
  $('attachments').replaceChildren(); $('attachments').hidden = true;
  $('title').textContent = ''; $('project').textContent = ''; $('submission-status').textContent = '';
  $('conversation').hidden = true; $('picker').hidden = true; $('pairing').hidden = false; $('logout').hidden = true;
  setConnection('unpaired'); setView('pairing'); $('settings').open = false; updateComposer();
}
async function bootstrap() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) { showPairing(); return; }
    authenticated = true; $('pairing').hidden = true; $('logout').hidden = false;
    $('access-note').textContent = 'Paired device';
    for (const record of await api('/api/submissions')) {
      const previous = submissions.get(record.threadId);
      if (!previous || previous.id === record.id) {
        submissions.set(record.threadId, { ...previous, ...record });
        applySubmission(record.threadId, record);
      }
      void checkSubmission(record.threadId);
    }
    await status();
    if (!authenticated) return;
    await reconcileNewSession();
    if (!authenticated) return;
    if ($('app').dataset.view === 'new-session') { await openNewSession(false); await list(); }
    else if (selected) select(selected); else { $('picker').hidden = false; setView('list'); await list(); }
  } catch (err) { error(err); }
}
$('pair-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: JSON.stringify({ code: $('pair-code').value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.message);
    $('pair-code').value = ''; $('error').textContent = ''; await bootstrap();
  } catch (err) { error(err); } finally { button.disabled = false; }
};
$('reload').onclick = () => { persistDrafts(); window.location.reload(); };
$('logout').onclick = async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: '{}' });
    if (!response.ok) throw new Error('Could not unpair. Check your connection and try again.');
    showPairing();
  } catch (err) { error(err); }
};

void bootstrap();

let viewportFrame, appliedViewportHeight, appliedViewportTop, rootScrollRecovery;
let fullViewportHeight = Math.max(innerHeight, window.visualViewport?.height ?? 0), viewportWidth = window.visualViewport?.width ?? innerWidth;
function fitViewport() {
  const viewport = window.visualViewport;
  // Follow keyboard/browser panning at normal scale, without cancelling pinch zoom.
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) return;
  const textFocused = document.activeElement?.matches('textarea,input[type="search"],input[type="text"],input:not([type])');
  if (Math.abs(viewport.width - viewportWidth) > 50) fullViewportHeight = Math.max(innerHeight, viewport.height);
  else if (!textFocused) fullViewportHeight = Math.max(fullViewportHeight, innerHeight, viewport.height);
  viewportWidth = viewport.width;
  const keyboardOpen = textFocused && fullViewportHeight - viewport.height > 120;
  document.documentElement.dataset.keyboard = keyboardOpen ? 'open' : 'closed';
  // Rotation can leave the locked document scrolled by the status-bar inset.
  // Recover the document itself, not just its painted shell. Never interfere with
  // keyboard panning, pinch zoom, or scrolling inside the transcript.
  const fullViewport = Math.abs(viewport.height - document.documentElement.clientHeight) <= 1;
  if (matchMedia('(max-width:800px)').matches && !textFocused && fullViewport && (scrollX > 1 || scrollY > 1)) {
    const recovery = `${viewport.width}/${viewport.height}/${scrollX}/${scrollY}`;
    if (rootScrollRecovery !== recovery) {
      rootScrollRecovery = recovery;
      window.scrollTo(0, 0);
      scheduleViewport();
      return;
    }
  } else rootScrollRecovery = undefined;
  const follow = followLatest;
  if (selected && follow && (viewport.height !== appliedViewportHeight || viewport.offsetTop !== appliedViewportTop)) viewportFollowLock = true;
  appliedViewportHeight = viewport.height; appliedViewportTop = viewport.offsetTop;
  document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
  document.documentElement.style.setProperty('--app-top', `${Math.max(0, viewport.offsetTop)}px`);
  if (follow) settleBottom();
}
function scheduleViewport() {
  if (viewportFrame !== undefined) return;
  viewportFrame = requestAnimationFrame(() => { viewportFrame = undefined; fitViewport(); });
}
window.visualViewport?.addEventListener('resize', scheduleViewport);
window.visualViewport?.addEventListener('scroll', scheduleViewport);
window.addEventListener('resize', scheduleViewport);
window.addEventListener('scroll', scheduleViewport, { passive: true });
document.addEventListener('focusin', event => { if (event.target === $('draft') && followLatest) viewportFollowLock = true; scheduleViewport(); });
$('draft').addEventListener('pointerdown', () => { if (followLatest) viewportFollowLock = true; });
document.addEventListener('focusout', scheduleViewport);
fitViewport();
scroller.addEventListener('scroll', () => {
  const delta = scroller.scrollTop - previousScrollTop;
  if (Math.abs(delta) > 1) { historyScrollAt = Date.now(); readerAnchor = undefined; }
  // Layout/image changes can emit scroll events without a reader moving the view.
  if (!viewportFollowLock && Math.abs(scroller.scrollTop - previousScrollTop) > 1) followLatest = atBottom();
  if (viewportFollowLock && followLatest && !atBottom()) settleBottom();
  previousScrollTop = scroller.scrollTop;
  $('new-content').hidden = viewportFollowLock && followLatest ? true : atBottom();
  if (atBottom()) markCurrentViewed();
  if (scroller.scrollTop > 160) historyAutoArmed = true;
  else if (historyAutoArmed) scheduleEarlierHistory();
});
// Only real reading gestures cancel a viewport-follow lock, not keyboard auto-scroll.
function readingGesture() {
  viewportFollowLock = false;
  readerAnchor = undefined;
  historyAutoArmed = true;
  scheduleEarlierHistory();
}
for (const type of ['pointerdown', 'touchstart', 'touchmove', 'wheel']) scroller.addEventListener(type, readingGesture, { passive: true });
scroller.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) readingGesture(); });
// Images, composer controls and viewport changes can settle after initial hydration.
const transcriptObserver = new ResizeObserver(() => { restoreReaderAnchor(); settleBottom(); });
transcriptObserver.observe($('transcript'));
transcriptObserver.observe(scroller);
scroller.addEventListener('load', () => { restoreReaderAnchor(); settleBottom(); }, true);
// An outside tap dismisses the menu before underlying controls can act.
document.addEventListener('pointerdown', event => {
  if ($('settings').open && !$('settings').contains(event.target)) event.preventDefault();
}, true);
document.addEventListener('click', event => {
  if (!$('settings').open || $('settings').contains(event.target)) return;
  $('settings').open = false;
  event.preventDefault(); event.stopImmediatePropagation();
}, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('settings').open = false; });

$('home').onclick = event => { if (!authenticated) return; event.preventDefault(); $('back').click(); };
const composerObserver = new ResizeObserver(() => { const height = document.querySelector('.composer').getBoundingClientRect().height; $('conversation').style.setProperty('--composer-height', `${height}px`); });
composerObserver.observe(document.querySelector('.composer'));
