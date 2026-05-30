import { join } from 'node:path';
import type { ItemAnalysis } from './types';

const HISTORY_JSON = join(import.meta.dir, 'config', 'history.json');
const MAX = 200;

export async function loadHistory(): Promise<ItemAnalysis[]> {
  try {
    const f = Bun.file(HISTORY_JSON);
    if (await f.exists()) return await f.json() as ItemAnalysis[];
  } catch {}
  return [];
}

export async function appendHistory(item: ItemAnalysis, current: ItemAnalysis[]): Promise<ItemAnalysis[]> {
  const next = [item, ...current].slice(0, MAX);
  await Bun.write(HISTORY_JSON, JSON.stringify(next, null, 2));
  return next;
}
