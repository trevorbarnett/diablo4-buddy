import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadBuild, getCurrentBuild, markCriticalItemFound, activateEndgameBuild, loadFarmingBuild, getFarmingBuild, clearFarmingBuild } from './build-loader';
import { analyzeItem, scanEquipment, evaluateBuild, getTokenStats } from './item-analyzer';
import { compressImageIfNeeded } from './image-utils';
import { getLoadout, setSlot, clearSlot, clearAll } from './equipment-store';
import { captureScreen } from './screenshot';
import { searchWowhead, fetchWowheadPage } from './wowhead-client';
import { ScreenshotWatcher, normalizePath } from './screenshot-watcher';
import { loadHistory, appendHistory } from './history-store';
import type { EquippedItem, ItemAnalysis, LoadBuildRequest, AnalyzeRequest, MarkFoundRequest } from './types';

const PORT = 4002;
const SETTINGS_JSON = join(import.meta.dir, 'config', 'settings.json');
mkdirSync(join(import.meta.dir, 'config'),      { recursive: true });
mkdirSync(join(import.meta.dir, 'screenshots'), { recursive: true });

// ── Settings ─────────────────────────────────────────────────────────────────
interface Settings { screenshotsPath: string; deleteAfterAnalysis: boolean; }

async function getSettings(): Promise<Settings> {
  try {
    const f = Bun.file(SETTINGS_JSON);
    if (await f.exists()) return await f.json() as Settings;
  } catch {}
  return { screenshotsPath: '', deleteAfterAnalysis: false };
}
async function saveSettings(s: Settings) {
  await Bun.write(SETTINGS_JSON, JSON.stringify(s, null, 2));
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────
const sseClients = new Set<ReadableStreamDefaultController>();

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(msg); } catch { sseClients.delete(ctrl); }
  }
}

// ── History ───────────────────────────────────────────────────────────────────
let history: ItemAnalysis[] = [];
loadHistory().then(h => { history = h; console.log(`[History] Loaded ${h.length} past analyses`); });

async function addToHistory(analysis: ItemAnalysis) {
  history = await appendHistory(analysis, history);
  broadcast('analysis', analysis);
}

// ── Screenshot watcher ────────────────────────────────────────────────────────
const watcher = new ScreenshotWatcher(async (imageBase64, filename, filepath) => {
  console.log(`[Watcher] Auto-analyzing ${filename}`);
  try {
    const build        = await getCurrentBuild();
    const farmingBuild = await getFarmingBuild();
    const loadout      = await getLoadout();
    const analysis = await analyzeItem(imageBase64, build, farmingBuild);
    const stored   = analysis.item_slot ? loadout[analysis.item_slot] ?? null : null;
    const final    = (!analysis.comparison_mode && stored)
      ? await analyzeItem(imageBase64, build, farmingBuild, stored)
      : analysis;
    await addToHistory(final);
    console.log(`[Watcher] Done: ${final.item_name} → ${final.verdict}`);

    const settings = await getSettings();
    if (settings.deleteAfterAnalysis && filepath) {
      try { unlinkSync(filepath); }
      catch { /* best effort */ }
    }
  } catch (err) {
    console.error('[Watcher] Analysis error:', err instanceof Error ? err.message : err);
  }
});

// Start watcher if path already configured
getSettings().then(s => { if (s.screenshotsPath) watcher.start(s.screenshotsPath); });

// ── Server ────────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,

  async fetch(req) {
    const url = new URL(req.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    function json(data: unknown, status = 200) {
      return Response.json(data, { status, headers: corsHeaders });
    }

    // ── SSE event stream ─────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/events') {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) { ctrl = c; sseClients.add(ctrl); },
        cancel()  { sseClients.delete(ctrl); },
      });
      return new Response(stream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // ── Settings ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/settings') {
      return json(await getSettings());
    }

    if (req.method === 'POST' && url.pathname === '/settings') {
      let body: Partial<Settings>;
      try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const current = await getSettings();
      const updated = { ...current, ...body };
      await saveSettings(updated);
      if (updated.screenshotsPath) {
        watcher.start(updated.screenshotsPath);
      } else {
        watcher.stop();
      }
      return json({ ok: true, settings: updated });
    }

    // ── Load a Maxroll build ─────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/build') {
      let body: LoadBuildRequest;
      try { body = await req.json() as LoadBuildRequest; }
      catch { return json({ error: 'Invalid JSON' }, 400); }

      if (!body.url?.startsWith('http')) {
        return json({ error: 'url is required and must be a full URL' }, 400);
      }

      try {
        const build = await loadBuild(body.url);
        return json({ ok: true, name: build.name, class: build.class, slotsFound: build.slots.length, keyStats: build.keyStats, slots: build.slots });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Server] Build load failed:', msg);
        return json({ error: `Build load failed: ${msg}` }, 500);
      }
    }

    if (req.method === 'GET' && url.pathname === '/build') {
      const build = await getCurrentBuild();
      if (!build) return json({ error: 'No build loaded' }, 404);
      return json(build);
    }

    if (req.method === 'POST' && url.pathname === '/build/found') {
      let body: MarkFoundRequest;
      try { body = await req.json() as MarkFoundRequest; }
      catch { return json({ error: 'Invalid JSON' }, 400); }
      const updated = await markCriticalItemFound(body.name, body.found);
      if (!updated) return json({ error: `Item "${body.name}" not found in current build` }, 404);
      return json({ ok: true, criticalItems: updated.criticalItems });
    }

    // ── Farming build ────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/build/farming') {
      let body: LoadBuildRequest;
      try { body = await req.json() as LoadBuildRequest; }
      catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body.url?.startsWith('http')) return json({ error: 'url is required and must be a full URL' }, 400);
      try {
        const build = await loadFarmingBuild(body.url);
        return json({ ok: true, name: build.name, class: build.class, slotsFound: build.slots.length });
      } catch (err) {
        return json({ error: `Farming build load failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
      }
    }

    if (req.method === 'GET' && url.pathname === '/build/farming') {
      const build = await getFarmingBuild();
      if (!build) return json({ error: 'No farming build loaded' }, 404);
      return json(build);
    }

    if (req.method === 'DELETE' && url.pathname === '/build/farming') {
      await clearFarmingBuild();
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/build/activate-endgame') {
      const build = await activateEndgameBuild();
      if (!build) return json({ error: 'No build loaded' }, 400);
      return json(build);
    }

    if (req.method === 'POST' && url.pathname === '/build/evaluate') {
      const build = await getCurrentBuild();
      if (!build) return json({ error: 'No build loaded' }, 400);
      const farmingBuild = await getFarmingBuild();
      const equipped     = await getLoadout();
      if (Object.keys(equipped).length === 0) return json({ error: 'No equipped items saved — scan your character sheet or save items from analysis cards first.' }, 400);
      try {
        const evaluation = await evaluateBuild(equipped, build, farmingBuild);
        return json({ ...evaluation, tokenStats: getTokenStats() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Evaluation failed: ${msg}` }, 500);
      }
    }

    // ── Screenshot ───────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/screenshot') {
      const result = await captureScreen();
      if ('error' in result) return json({ error: result.error }, 500);
      return json(result);
    }

    // ── Analyze ──────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/analyze') {
      let body: AnalyzeRequest = {};
      try { body = await req.json() as AnalyzeRequest; } catch {}

      let imageBase64: string;
      if (body.imageBase64) {
        imageBase64 = body.imageBase64;
      } else {
        const shot = await captureScreen();
        if ('error' in shot) return json({ error: shot.error }, 500);
        imageBase64 = shot.imageBase64;
      }
      imageBase64 = await compressImageIfNeeded(imageBase64);

      try {
        const build        = await getCurrentBuild();
        const farmingBuild = await getFarmingBuild();
        const loadout      = await getLoadout();
        const analysis = await analyzeItem(imageBase64, build, farmingBuild);
        const stored   = analysis.item_slot ? loadout[analysis.item_slot] ?? null : null;
        const final    = (!analysis.comparison_mode && stored)
          ? await analyzeItem(imageBase64, build, farmingBuild, stored)
          : analysis;

        // Auto-update equipped record when re-analyzing the same item (e.g. after tempering)
        let equippedUpdated = false;
        if (final.item_found && stored && final.item_name === stored.item_name) {
          const updated = {
            ...stored,
            affixes: [...(final.affixes_good ?? []), ...(final.affixes_bad ?? [])],
            scannedAt: Date.now(),
          };
          await setSlot(final.item_slot, updated);
          equippedUpdated = true;
        }

        addToHistory(final);
        return json({ ...final, equippedUpdated, tokenStats: getTokenStats() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Server] Analysis failed:', msg);
        return json({ error: `Analysis failed: ${msg}` }, 500);
      }
    }

    // ── Equipment ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/equipment') {
      return json(await getLoadout());
    }

    if (req.method === 'POST' && url.pathname === '/equipment/scan') {
      let body: AnalyzeRequest = {};
      try { body = await req.json() as AnalyzeRequest; } catch {}

      let imageBase64: string;
      if (body.imageBase64) {
        imageBase64 = body.imageBase64;
      } else {
        const shot = await captureScreen();
        if ('error' in shot) return json({ error: shot.error }, 500);
        imageBase64 = shot.imageBase64;
      }
      imageBase64 = await compressImageIfNeeded(imageBase64);

      try {
        const items   = await scanEquipment(imageBase64);
        const loadout = await getLoadout();
        for (const item of items) { loadout[item.item_slot] = item; await setSlot(item.item_slot, item); }
        return json({ scanned: items.length, items, loadout, tokenStats: getTokenStats() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ error: `Scan failed: ${msg}` }, 500);
      }
    }

    if (req.method === 'POST' && url.pathname === '/equipment/slot') {
      let body: { slot: string; item: EquippedItem };
      try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body.slot || !body.item) return json({ error: 'slot and item required' }, 400);
      const loadout = await setSlot(body.slot, { ...body.item, scannedAt: Date.now() });
      return json({ ok: true, loadout });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/equipment/')) {
      const slot    = decodeURIComponent(url.pathname.replace('/equipment/', ''));
      const loadout = await clearSlot(slot);
      return json({ ok: true, loadout });
    }

    if (req.method === 'DELETE' && url.pathname === '/equipment') {
      return json({ ok: true, loadout: await clearAll() });
    }

    // ── Wowhead ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/wowhead') {
      const q    = url.searchParams.get('q')?.trim();
      const page = url.searchParams.get('page');
      if (!q) return json({ error: 'q param required' }, 400);
      try {
        if (page) return json({ results: await fetchWowheadPage(page, q), source: 'page' });
        const { results, source } = await searchWowhead(q);
        return json({ results, source });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // ── History / Stats / Static ─────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/history') return json(history);
    if (req.method === 'GET' && url.pathname === '/stats')   return json(getTokenStats());
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(Bun.file('./public/index.html'));
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`
╔══════════════════════════════════════╗
║   Diablo 4 Item Advisor              ║
║   Overlay  → http://localhost:${PORT}    ║
║   Screenshot Folder → POST /settings ║
╚══════════════════════════════════════╝
`);
