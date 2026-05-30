import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compressImageIfNeeded } from './image-utils';

export type WatchCallback = (imageBase64: string, filename: string, filepath: string) => Promise<void>;

function windowsToWslPath(p: string): string {
  // Convert C:\foo\bar → /mnt/c/foo/bar
  return p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

export function normalizePath(p: string): string {
  if (p.match(/^[A-Za-z]:\\/)) return windowsToWslPath(p);
  return p;
}

export class ScreenshotWatcher {
  private path   = '';
  private cb: WatchCallback;
  private seen   = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  active = false;

  constructor(cb: WatchCallback) { this.cb = cb; }

  start(rawPath: string) {
    this.path = normalizePath(rawPath);
    this.seen.clear();
    this.active = true;

    // Seed with existing files so we don't analyze stale screenshots
    try {
      for (const f of readdirSync(this.path)) this.seen.add(f);
      console.log(`[Watcher] Watching ${this.path} (${this.seen.size} existing files seeded)`);
    } catch {
      console.warn(`[Watcher] Path not found: ${this.path} — will retry`);
    }

    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), 2000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer  = null;
    this.active = false;
    console.log('[Watcher] Stopped');
  }

  private async poll() {
    let files: string[];
    try { files = readdirSync(this.path); }
    catch { return; }

    for (const filename of files) {
      if (this.seen.has(filename)) continue;
      this.seen.add(filename);
      if (!filename.match(/\.(png|jpg|jpeg)$/i)) continue;
      // Fire and forget — analyses run concurrently, results arrive as each finishes
      this.processFile(filename);
    }
  }

  private async processFile(filename: string) {
    const filepath = join(this.path, filename);
    try {
      await Bun.sleep(600); // let D4 finish writing the file
      const buf = await Bun.file(filepath).arrayBuffer();

      const mb = buf.byteLength / 1024 / 1024;
      let base64 = Buffer.from(buf).toString('base64');
      base64 = await compressImageIfNeeded(base64);
      console.log(`[Watcher] Analyzing ${filename} (${mb.toFixed(1)}MB)`);
      await this.cb(base64, filename, filepath);
    } catch (err) {
      console.error(`[Watcher] Failed to process ${filename}:`, err instanceof Error ? err.message : err);
    }
  }
}
