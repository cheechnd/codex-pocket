import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DaemonAdapter } from '../daemon/adapter.js';
import { AttachmentStore } from './attachments.js';
import { AccessControl } from './access.js';
import { PocketError } from '../daemon/types.js';

export function createApp(adapter: DaemonAdapter, port = 4317, options: { access: AccessControl; attachments?: AttachmentStore; origin?: string; webRoot?: URL }) {
  const streams = new Set<ServerResponse>();
  const origin = options.origin ?? `http://127.0.0.1:${port}`;
  const address = new URL(origin);
  if (address.origin !== origin || (address.protocol !== 'https:' && origin !== `http://127.0.0.1:${port}`) || address.username || address.password) throw new Error('Configure an exact HTTPS PUBLIC_ORIGIN, or use numeric loopback HTTP');
  const { access } = options;
  const readJSON = async (req: import('node:http').IncomingMessage, limit = 70 * 1024) => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new PocketError('size', 'Request too large'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PocketError('input', 'Invalid JSON'); }
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return json(403, { error: 'proxy', message: 'Loopback proxy required' });
      if (req.method === 'GET' && req.url === '/healthz' && req.headers.host === `127.0.0.1:${port}`) return json(200, { ok: true });
      if (req.headers.host !== address.host) return json(403, { error: 'origin', message: 'Open Pocket at its configured address' });
      const url = new URL(req.url ?? '/', origin);
      // Public shell/assets contain no session or conversation data. Normal links and
      // restored browser tabs may arrive cross-site; API reads/writes remain protected.
      const publicAsset = req.method === 'GET' && ['/', '/app.js', '/style.css', '/apple-touch-icon.png'].includes(url.pathname);
      if (!publicAsset && ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')) return json(403, { error: 'origin', message: 'Open Pocket at its configured address' });
      if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers['x-pocket-request'] !== '1')) return json(403, { error: 'csrf', message: 'Same-origin JSON request required' });
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const input = await readJSON(req, 1024); await access.pair(req, res, origin, input?.code); return json(200, { authenticated: true });
      }
      const sessionId = url.pathname.startsWith('/api/') ? await access.authenticate(req, res, origin) : undefined;
      if (req.method === 'GET' && url.pathname === '/api/session') return json(200, { authenticated: !!sessionId, privateAccess: origin.startsWith('https:') });
      if (url.pathname.startsWith('/api/') && !sessionId) return json(401, { error: 'unauthorized', message: 'Pair this device to access Codex Pocket' });
      if (req.method === 'POST' && url.pathname === '/api/logout') { await access.logout(req, res, origin); return json(200, { authenticated: false }); }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { ...adapter.status(), canAttachImages: !!options.attachments });
      if (req.method === 'GET' && url.pathname === '/api/threads') return json(200, await adapter.list());
      if (req.method === 'GET' && url.pathname === '/api/saved-threads') {
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const search = url.searchParams.get('search') ?? undefined;
        if ((cursor?.length ?? 0) > 4096 || (search?.length ?? 0) > 200) throw new PocketError('input', 'Search or cursor too long');
        return json(200, await adapter.saved(cursor, search));
      }
      const opening = /^\/api\/threads\/([a-zA-Z0-9_-]{1,128})\/open$/.exec(url.pathname);
      if (req.method === 'POST' && opening) {
        const input = await readJSON(req, 1024);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new PocketError('input', 'Open a saved conversation by ID without configuration overrides');
        return json(200, { ...await adapter.open(opening[1]), loaded: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/submissions') return json(200, adapter.outstanding());
      const attachment = /^\/api\/attachments\/([a-f0-9]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && attachment && options.attachments) {
        const image = await options.attachments.get(attachment[1]);
        res.writeHead(200, { 'Content-Type': image.mime }); res.end(image.data); return;
      }
      const submission = /^\/api\/submissions\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
      if (req.method === 'GET' && submission) return json(200, await adapter.submission(submission[1]));
      const match = /^\/api\/threads\/([a-zA-Z0-9_-]{1,128})\/(history|events|messages)$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' && action === 'history') {
          const cursor = url.searchParams.get('cursor') ?? undefined;
          if (cursor && cursor.length > 4096) throw new PocketError('input', 'Cursor too long');
          const page = await adapter.history(id, cursor);
          return json(200, options.attachments ? await options.attachments.history(id, page) : page);
        }
        if (req.method === 'GET' && action === 'events') {
          if (streams.size >= 16) throw new PocketError('capacity', 'Too many browser streams');
          const release = await adapter.acquire(id);
          if (res.destroyed) { release(); return; }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          streams.add(res);
          const write = (event: string, data: unknown) => {
            if (res.writableLength > 128 * 1024) { res.destroy(); return; }
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          // Metadata only. Clients rehydrate authoritative bounded history on notices.
          const onEvent = (event: any) => { if (!access.isValid(sessionId)) { res.end(); return; } if (event.params.threadId === id) write('change', { sequence: event.sequence, method: event.method, needsCli: event.requestId !== undefined }); };
          const onState = () => { if (!access.isValid(sessionId)) { res.end(); return; } write('connection', adapter.status()); };
          adapter.on('event', onEvent); adapter.on('state', onState);
          write('ready', { rehydrate: true });
          const timer = setInterval(() => { if (!access.isValid(sessionId)) { res.end(); return; } res.write(': heartbeat\n\n'); }, 15_000);
          res.on('close', () => { clearInterval(timer); streams.delete(res); adapter.off('event', onEvent); adapter.off('state', onState); release(); });
          return;
        }
        if (req.method === 'POST' && action === 'messages') {
          if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || req.headers['x-pocket-request'] !== '1') return json(403, { error: 'csrf', message: 'Same-origin JSON request required' });
          const input = await readJSON(req, 28 * 1024 * 1024);
          if (!input || typeof input !== 'object') throw new PocketError('input', 'Invalid message');
          if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 64 * 1024) throw new PocketError('input', 'Invalid message text');
          if (input.images?.length && !options.attachments) throw new PocketError('unsupported', 'Image attachments unavailable');
          await adapter.assertLoaded(id);
          const images = await options.attachments?.prepare(id, input.clientSubmissionId, input.images) ?? [];
          return json(200, await adapter.send(id, input.text, input.clientSubmissionId, images, input.question, input.expectedTurnId));
        }
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/apple-touch-icon.png'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const data = await readFile(fileURLToPath(new URL(file, options.webRoot ?? new URL('../web/', import.meta.url))));
        res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); res.end(data); return;
      }
      json(404, { error: 'not-found', message: 'Endpoint unavailable' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = error instanceof PocketError ? error.code : 'unavailable';
      const message = error instanceof PocketError ? error.message : 'Daemon unavailable; start Codex normally on the computer, or verify the explicitly selected socket';
      json(({ unauthorized: 401, 'rate-limit': 429, 'not-found': 404, unloaded: 404, unsupported: 409, busy: 409, conflict: 409, input: 400, size: 413, capacity: 429, incompatible: 503 } as Record<string, number>)[code] ?? 503, { error: code, message });
    }
  });
  return { server, origin, close: async () => {
    for (const stream of streams) stream.end();
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    adapter.close();
  } };
}
