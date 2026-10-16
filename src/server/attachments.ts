import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import sharp from 'sharp';
import { PocketError } from '../daemon/types.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const imageName = /^[a-f0-9]{64}\.(png|jpeg)$/;
/** Private, bounded image storage. Browser input can never select a filesystem path. */
export class AttachmentStore {
  readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  private processing = 0;
  constructor(directory: string, readonly capacity = 512 * 1024 * 1024) { this.directory = resolve(directory); }
  async prepare(thread: string, submission: unknown, images: unknown): Promise<string[]> {
    if (this.processing >= 2) throw new PocketError('capacity', 'Images are being processed; try again shortly');
    this.processing++;
    try { return await this.process(thread, submission, images); } finally { this.processing--; }
  }
  private async process(thread: string, submission: unknown, images: unknown): Promise<string[]> {
    if (images === undefined) return [];
    if (!Array.isArray(images) || images.length > 4 || typeof submission !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submission)) throw new PocketError('input', 'Invalid image attachments');
    if (!images.length) return [];
    let total = 0;
    const normalized = await Promise.all(images.map(async value => {
      const match = typeof value?.dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataUrl);
      if (!match) throw new PocketError('input', 'Attach a PNG, JPEG, or WebP image');
      const bytes = Buffer.from(match[2], 'base64');
      total += bytes.length;
      if (!bytes.length || bytes.length > 8 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new PocketError('size', 'Images exceed the attachment size limit');
      try {
        const image = sharp(bytes, { limitInputPixels: 32_000_000, animated: false, failOn: 'warning' });
        const metadata = await image.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || metadata.format !== match[1] || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
        const format = metadata.format === 'png' ? 'png' : 'jpeg';
        // Decode fully, apply orientation and remove EXIF/location metadata.
        const output = image.rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
        const data = await (format === 'png' ? output.png() : output.jpeg({ quality: 90 })).toBuffer();
        if (data.length > 8 * 1024 * 1024) throw new PocketError('size', 'Image is too large; choose a smaller image');
        return { data, format };
      } catch (err) { if (err instanceof PocketError) throw err; throw new PocketError('input', 'This image could not be decoded. Try a PNG or JPEG screenshot.'); }
    }));
    if (normalized.reduce((sum, value) => sum + value.data.length, 0) > 20 * 1024 * 1024) throw new PocketError('size', 'Images exceed 20 MiB after preparation');
    const work = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const names = normalized.map(({ data, format }, i) => `${digest(JSON.stringify([thread, submission, i, digest(data)]))}.${format}`);
      const manifest = resolve(this.directory, `${digest(JSON.stringify([thread, submission]))}.json`);
      try { if (JSON.stringify(JSON.parse(await readFile(manifest, 'utf8'))) !== JSON.stringify(names)) throw new PocketError('conflict', 'Submission ID already belongs to different images'); }
      catch (err: any) { if (err.code !== 'ENOENT') throw err; }
      const files = await readdir(this.directory);
      const used = (await Promise.all(files.map(async name => (await stat(resolve(this.directory, name))).size))).reduce((a, b) => a + b, 0);
      const extra = normalized.reduce((sum, value, i) => sum + (files.includes(names[i]) ? 0 : value.data.length), 0);
      if (used + extra > this.capacity) throw new PocketError('capacity', 'Image storage is full');
      for (let i = 0; i < names.length; i++) await writeFile(resolve(this.directory, names[i]), normalized[i].data, { mode: 0o600 });
      await writeFile(manifest, JSON.stringify(names), { mode: 0o600 });
      return names.map(name => resolve(this.directory, name));
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async get(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new PocketError('not-found', 'Image unavailable');
    for (const ext of ['png', 'jpeg']) {
      try { return { data: await readFile(resolve(this.directory, `${id}.${ext}`)), mime: `image/${ext}` }; }
      catch (err: any) { if (err.code !== 'ENOENT') throw err; }
    }
    throw new PocketError('not-found', 'Image unavailable');
  }
  async history(thread: string, page: any) {
    return { ...page, data: await Promise.all(page.data.map(async (entry: any) => {
      if (entry.item.type !== 'userMessage') return entry;
      let names: string[] = [];
      if (typeof entry.item.clientId === 'string') {
        try { names = JSON.parse(await readFile(resolve(this.directory, `${digest(JSON.stringify([thread, entry.item.clientId]))}.json`), 'utf8')); } catch { /* Desktop images may not belong to Pocket. */ }
      }
      let index = 0;
      const content = (entry.item.content ?? []).map((part: any) => {
        if (!['image', 'localImage'].includes(part.type)) return part;
        const ownPath = typeof part.path === 'string' && resolve(part.path) === resolve(this.directory, basename(part.path)) && imageName.test(basename(part.path)) ? basename(part.path) : undefined;
        const name = names[index++] ?? ownPath;
        return { type: 'image', ...(name && imageName.test(name) ? { url: `/api/attachments/${name.split('.')[0]}` } : {}) };
      });
      return { ...entry, item: { ...entry.item, content } };
    })) };
  }
}
