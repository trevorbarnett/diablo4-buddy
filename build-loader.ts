import Anthropic from '@anthropic-ai/sdk';
import { join } from 'node:path';
import type { BuildConfig, CriticalItem, CriticalItemType, SlotPriority } from './types';

const BUILD_JSON         = join(import.meta.dir, 'config', 'build.json');
const FARMING_BUILD_JSON = join(import.meta.dir, 'config', 'farming-build.json');
const client = new Anthropic();

const D4_SLOTS = [
  'Helm', 'Chest', 'Gloves', 'Pants', 'Boots',
  'Amulet', 'Ring', 'Ring 1', 'Ring 2',
  'Weapon', 'Offhand', 'Bludgeoning Weapon', 'Slashing Weapon',
  'Dual-Wield Weapon', 'Two-Handed Weapon', 'Shield',
];

const KNOWN_AFFIXES = [
  'Critical Strike Chance', 'Critical Strike Damage', 'Attack Speed',
  'Movement Speed', 'Cooldown Reduction', 'Lucky Hit Chance',
  'Maximum Life', 'Armor', 'Resistances', 'All Stats',
  'Damage', 'Vulnerable Damage', 'Overpower Damage',
  'Core Skill Damage', 'Ultimate Skill Damage', 'Basic Skill Damage',
  'Skill Damage', 'Ranks to', 'Resource Cost Reduction',
  'Dodge Chance', 'Damage Reduction', 'Barrier Generation',
  'Healing Received', 'Thorns', 'Block Chance', 'Essence',
];

function extractClass(html: string, url: string): string {
  const classes = ['Barbarian', 'Druid', 'Necromancer', 'Rogue', 'Sorcerer', 'Spiritborn'];

  // URL slug is the most reliable signal
  for (const cls of classes) {
    if (url.toLowerCase().includes(cls.toLowerCase())) return cls;
  }

  // Page title is next most reliable
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1];
    for (const cls of classes) {
      if (title.toLowerCase().includes(cls.toLowerCase())) return cls;
    }
  }

  // Fall back to highest frequency across the full page (nav mentions all classes once;
  // the actual build class will appear many more times)
  let best = 'Unknown';
  let bestCount = 0;
  for (const cls of classes) {
    const count = (html.toLowerCase().match(new RegExp(cls.toLowerCase(), 'g')) ?? []).length;
    if (count > bestCount) { bestCount = count; best = cls; }
  }
  return best;
}

function extractBuildName(html: string, url: string): string {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1]
      .replace(/\s*[|\-–]\s*Maxroll.*$/i, '')
      .replace(/\s*Build Guide.*$/i, '')
      .trim();
  }
  const slug = url.split('/').pop() ?? '';
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractSearchMetadata(html: string): { items: string[]; skills: string[] } {
  const match = html.match(/"search_metadata"\s*:\s*(\{[^}]+\})/);
  if (!match) return { items: [], skills: [] };
  try {
    const meta = JSON.parse(match[1]);
    return { items: meta.items ?? [], skills: meta.skills ?? [] };
  } catch {
    return { items: [], skills: [] };
  }
}

function detectPhase(buildName: string): string {
  const lower = buildName.toLowerCase();
  if (lower.includes('push'))     return 'Push';
  if (lower.includes('endgame'))  return 'Endgame';
  if (lower.includes('midgame') || lower.includes('mid-game')) return 'Midgame';
  if (lower.includes('starter') || lower.includes('leveling')) return 'Starter';
  return 'Endgame'; // default assumption for a loaded build
}

async function extractSlotPriorities(text: string, cls: string, buildName: string, knownItems: string[] = []): Promise<SlotPriority[]> {
  const phase = detectPhase(buildName);
  const itemHint = knownItems.length > 0
    ? `\nKNOWN ITEMS IN THIS BUILD: ${knownItems.join(', ')}\nUse these to identify which unique fills each slot and whether the weapon is 1H or 2H (e.g. Skullsplitter = bludgeoning 2H mace, Sword = slashing, Scythe = scythe).`
    : '';
  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: `You are a Diablo 4 build analyst extracting per-slot affix priorities from a build guide.

PHASE TARGETING (critical):
Many guides contain multiple gear phases: Starter, Midgame, Endgame, Push.
You MUST extract slot data ONLY for the "${phase}" phase.
If the text has a section labelled "${phase}" (or similar), use that section exclusively.
Do NOT mix affixes or weapons from different phases.

VALID SLOTS: Helm, Chest, Gloves, Pants, Boots, Amulet, Ring, Weapon, Offhand, Shield, Two-Handed Weapon, Bludgeoning Weapon, Slashing Weapon

WEAPON TYPE RULES:
- If the ${phase} phase uses a TWO-HANDED weapon, use "Two-Handed Weapon". Do NOT add Offhand or Shield.
- If the ${phase} phase uses ONE-HANDED + offhand, use "Weapon" + "Offhand" (or "Shield") as separate slots.
- If a specific unique weapon is named, include it in the "notes" field and use the correct slot type.
${itemHint}

For each slot list the 2–4 most important affixes in priority order. Use concise affix names (e.g. "Cooldown Reduction", "Critical Strike Chance", "Maximum Life").

OUTPUT: Valid JSON array only, no markdown:
[{"slot": "Helm", "affixes": ["Critical Strike Chance", "Cooldown Reduction", "Maximum Life"], "notes": "optional — e.g. BiS unique name"}]

Return [] if you cannot determine slot priorities for the ${phase} phase.`,
      messages: [{
        role: 'user',
        content: `Build: ${buildName} (${cls}) — extract ${phase} phase gear only.\n\nGuide text:\n${text.slice(0, 6000)}\n\nExtract ${phase} phase per-slot affix priorities.`,
      }],
    });

    let raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '[]';
    raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw) as SlotPriority[];
    console.log(`[BuildLoader] ${phase} phase slots: ${parsed.map(s => s.slot).join(', ')}`);
    return parsed;
  } catch (err) {
    console.error('[BuildLoader] Slot extraction failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function extractKeyStats(text: string): string[] {
  return KNOWN_AFFIXES.filter(a => {
    const count = (text.toLowerCase().match(new RegExp(a.toLowerCase(), 'g')) ?? []).length;
    return count >= 2;
  });
}

// Ask Claude to identify build-enabling unique items AND their farming targets.
// Single call at build-load time — not per-item-analysis.
async function identifyCriticalItems(rawText: string, cls: string, buildName: string): Promise<CriticalItem[]> {
  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `You are a Diablo 4 build analyst with deep knowledge of the game's item system, boss drop tables, Codex of Power, and progression path in the Lord of Hatred expansion.

Extract the REQUIRED items AND aspects from a build guide. For each, provide accurate farming/acquisition information.

CRITICAL DISTINCTION — get itemType right:
- "unique_item": A specific named Unique (orange) item that drops from enemies/bosses. Has a unique 3D model. Examples: "Kessime's Legacy", "Bloodless Scream", "Howl from Below". Farmed by killing specific bosses or general Torment content.
- "aspect": A Legendary Aspect (e.g. "Hematolagnia", "Aspect of the Umbral"). IMPORTANT: In Lord of Hatred, dungeons NO LONGER unlock aspects. Aspects drop exclusively on Legendary items from any content. Salvage Legendaries at the Blacksmith to add the aspect to your Codex of Power. Do NOT reference dungeon completion as a source.

INCLUDE as critical:
- Unique items without which the build's primary skill/mechanic cannot function
- Legendary Aspects that are described as "required", "necessary", "core", "essential" and cannot be substituted
- Items/aspects described as "turning on" the build or unlocking key synergies

EXCLUDE:
- Optional upgrades or BiS Mythic/Uber Uniques
- Generic rare/magical items
- "Nice to have" improvements

D4 LORD OF HATRED FARMING KNOWLEDGE:
UNIQUE ITEMS:
- Most: drop from any Torment 1+ content (world drops)
- Boss-specific Lair Bosses (use Lair Keys from Helltides/War Plans/Whispers, Greater Lair Keys from The Pit):
  - Andariel → pants/boots/gloves (also fast Mythic source)
  - Duriel → chest/legs (strong loot table, good Mythic source)
  - Harbinger of Hatred → expansion-exclusive Uniques ONLY available from this boss
  - Varshan → rings/amulets
  - Grigoire → armor
  - Beast in Ice → off-hand
  - Lord Zir → head
  - Mephisto Echo → pinnacle boss, requires Crux of the False Prophet
- Mythic Uniques: ~2% per Greater Boss kill (Duriel/Andariel best)
- Helltide Mysterious Chests: target specific equipment slots
- Gambling (Obols/Purveyor of Curiosities): target a slot by item type
- Undercity with Equipment Bargain: increased Unique drop rates (stack with War Plan modifiers)

LEGENDARY ASPECTS (itemType = "aspect") — LORD OF HATRED RULES:
- Dungeons NO LONGER award aspects. Never reference a dungeon unlock.
- Farm Legendary drops from any high-density content: Helltides, Nightmare Dungeons, The Pit, Infernal Hordes, War Plans, boss kills, loot caches.
- Salvage Legendaries at the Blacksmith → aspect is added to Codex of Power at its rolled value.
- Higher-rolled salvages automatically upgrade the Codex entry.
- Imprint from Codex onto any Rare/Legendary of the correct slot (costs gold + Veiled Crystals).

Torment tiers: Torment 1 ≈ level 60+, Torment 4 ≈ level 90+ strong gear.

Return 2–5 entries. Fewer is better.

OUTPUT: Valid JSON array only, no markdown:
[{
  "name": "Item or Aspect Name",
  "slot": "Helm|Chest|Ring|etc. — use 'Any' for aspects that can go on multiple slots",
  "itemType": "unique_item|aspect",
  "why": "one sentence on how this enables the build",
  "found": false,
  "farm": {
    "activity": "e.g. 'Kill Andariel' or 'Farm Legendary drops (Helltide / Nightmare Dungeon / War Plans), salvage at Blacksmith'",
    "tormentTier": "Torment 1+",
    "characterLevel": "60+",
    "pitTier": null,
    "notes": "specific tip on fastest way to get this"
  }
}]`,
      messages: [{
        role: 'user',
        content: `Build: ${buildName}\nClass: ${cls}\n\nGuide text:\n${rawText.slice(0, 3500)}\n\nIdentify required unique items with farming details.`,
      }],
    });

    let text = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '[]';
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    if (resp.stop_reason === 'max_tokens') {
      // Trim trailing incomplete object/string then close open brackets
      text = text.replace(/,?\s*\{[^}]*$/, '').replace(/,\s*$/, '');
      const closers: string[] = [];
      for (const ch of text) {
        if (ch === '[' || ch === '{') closers.push(ch === '[' ? ']' : '}');
        else if (ch === ']' || ch === '}') closers.pop();
      }
      text += closers.reverse().join('');
    }
    const raw = JSON.parse(text) as Partial<CriticalItem>[];
    const items: CriticalItem[] = raw.map(i => ({ itemType: 'unique_item' as CriticalItemType, ...i } as CriticalItem));
    console.log(`[BuildLoader] Critical items: ${items.map(i => `${i.name} [${i.itemType}] (${i.farm?.activity})`).join(', ')}`);
    return items;
  } catch (err) {
    console.error('[BuildLoader] Critical item extraction failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// Derive overall target tier from the hardest critical item to get
export function getTargetProgression(items: CriticalItem[]): { tormentTier: string; characterLevel: string; summary: string } {
  if (!items.length) return { tormentTier: 'Torment 1', characterLevel: '60+', summary: '' };
  // Pick the highest tier required across all items
  const tiers = items.map(i => i.farm?.tormentTier ?? 'Torment 1');
  const levels = items.map(i => i.farm?.characterLevel ?? '60+');
  const hardest = tiers.sort().reverse()[0];
  const highestLevel = levels.sort().reverse()[0];
  const activities = [...new Set(items.map(i => i.farm?.activity).filter(Boolean))];
  return {
    tormentTier: hardest,
    characterLevel: highestLevel,
    summary: `Farm ${activities.join(', ')} at ${hardest}`,
  };
}

export async function loadBuild(url: string): Promise<BuildConfig> {
  console.log(`[BuildLoader] Fetching ${url}`);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; D4Advisor/1.0)' },
  });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);

  const html = await resp.text();
  const text = stripHtml(html);

  const cls = extractClass(html, url);
  const name = extractBuildName(html, url);
  const keyStats = extractKeyStats(text);
  const { items: knownItems } = extractSearchMetadata(html);

  // Preserve found-status from any previously loaded version of this build
  let existingFoundMap: Record<string, boolean> = {};
  try {
    const existing = await getCurrentBuild();
    if (existing?.url === url) {
      existingFoundMap = Object.fromEntries(
        (existing.criticalItems ?? []).map(i => [i.name, i.found])
      );
    }
  } catch { /* first load */ }

  // Run slot extraction and critical items in parallel
  const [slots, criticalItems] = await Promise.all([
    extractSlotPriorities(text, cls, name, knownItems),
    identifyCriticalItems(text, cls, name),
  ]);

  // Restore found status if re-loading same build
  for (const item of criticalItems) {
    if (existingFoundMap[item.name] !== undefined) item.found = existingFoundMap[item.name];
  }

  const build: BuildConfig = {
    name,
    class: cls,
    url,
    fetchedAt: new Date().toISOString(),
    slots,
    keyStats,
    criticalItems,
    rawText: text.slice(0, 6000),
  };

  await Bun.write(BUILD_JSON, JSON.stringify(build, null, 2));
  console.log(`[BuildLoader] Saved: ${name} (${cls}) — ${slots.length} slots, ${criticalItems.length} critical items`);
  return build;
}

export async function getCurrentBuild(): Promise<BuildConfig | null> {
  try {
    const file = Bun.file(BUILD_JSON);
    if (!await file.exists()) return null;
    return await file.json() as BuildConfig;
  } catch {
    return null;
  }
}

export async function loadFarmingBuild(url: string): Promise<BuildConfig> {
  console.log(`[BuildLoader] Fetching farming build ${url}`);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; D4Advisor/1.0)' },
  });
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);

  const html = await resp.text();
  const text = stripHtml(html);

  const cls   = extractClass(html, url);
  const name  = extractBuildName(html, url);
  const keyStats = extractKeyStats(text);
  const { items: knownItems } = extractSearchMetadata(html);
  const slots = await extractSlotPriorities(text, cls, name, knownItems);

  const build: BuildConfig = {
    name,
    class: cls,
    url,
    fetchedAt: new Date().toISOString(),
    slots,
    keyStats,
    criticalItems: [],
    rawText: text.slice(0, 6000),
  };

  await Bun.write(FARMING_BUILD_JSON, JSON.stringify(build, null, 2));
  console.log(`[BuildLoader] Farming build saved: ${name} (${cls}) — ${slots.length} slots`);
  return build;
}

export async function getFarmingBuild(): Promise<BuildConfig | null> {
  try {
    const file = Bun.file(FARMING_BUILD_JSON);
    if (!await file.exists()) return null;
    const b = await file.json() as BuildConfig;
    return b.name ? b : null;
  } catch {
    return null;
  }
}

export async function clearFarmingBuild(): Promise<void> {
  await Bun.write(FARMING_BUILD_JSON, '{}');
}

export async function activateEndgameBuild(): Promise<BuildConfig | null> {
  const build = await getCurrentBuild();
  if (!build) return null;
  for (const item of build.criticalItems) item.found = true;
  await Bun.write(BUILD_JSON, JSON.stringify(build, null, 2));
  await clearFarmingBuild();
  console.log('[BuildLoader] Endgame activated — all critical items marked found, farming build cleared');
  return build;
}

export async function markCriticalItemFound(name: string, found: boolean): Promise<BuildConfig | null> {
  const build = await getCurrentBuild();
  if (!build) return null;

  const item = build.criticalItems.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (!item) return null;

  item.found = found;
  await Bun.write(BUILD_JSON, JSON.stringify(build, null, 2));
  console.log(`[BuildLoader] ${item.name} marked as ${found ? 'found' : 'not found'}`);
  return build;
}
