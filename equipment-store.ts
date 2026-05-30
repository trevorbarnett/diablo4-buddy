import { join } from 'node:path';
import type { EquippedItem, EquippedLoadout } from './types';

const EQUIPMENT_JSON = join(import.meta.dir, 'config', 'equipment.json');

export async function getLoadout(): Promise<EquippedLoadout> {
  try {
    const file = Bun.file(EQUIPMENT_JSON);
    if (!await file.exists()) return {};
    return await file.json() as EquippedLoadout;
  } catch {
    return {};
  }
}

export async function setSlot(slot: string, item: EquippedItem): Promise<EquippedLoadout> {
  const loadout = await getLoadout();
  loadout[slot] = item;
  await Bun.write(EQUIPMENT_JSON, JSON.stringify(loadout, null, 2));
  return loadout;
}

export async function clearSlot(slot: string): Promise<EquippedLoadout> {
  const loadout = await getLoadout();
  delete loadout[slot];
  await Bun.write(EQUIPMENT_JSON, JSON.stringify(loadout, null, 2));
  return loadout;
}

export async function clearAll(): Promise<EquippedLoadout> {
  await Bun.write(EQUIPMENT_JSON, '{}');
  return {};
}
