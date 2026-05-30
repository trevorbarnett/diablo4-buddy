import Anthropic from '@anthropic-ai/sdk';
import type { BuildConfig, CriticalItem, EquippedItem, ItemAnalysis } from './types';

const client = new Anthropic();

// ── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(build: BuildConfig | null, farmingBuild: BuildConfig | null = null): string {
  const mechSection = `DIABLO 4 ITEM MECHANICS:
- Items have 1 implicit stat + 3-4 explicit affixes. Legendary Aspects are separate — ignore them as affix slots.
- Tempering: adds 1–2 affixes from a class pool (2 temper slots per item). CAN fix a missing priority affix.
- Masterworking: scales affix values ~5%/rank. Does NOT add new affixes.
- Item Power: 900+ is endgame range. Matters for masterworking scaling.
- Rerolling (Occultist): replaces one affix when 3/4 are right.
- Player is in PROGRESSION — evaluate as an intermediate step toward BiS, not perfection.`;

  const comparisonSection = `COMPARISON MODE (TWO TOOLTIPS):
If two item tooltips appear side-by-side:
- The LEFT or TOP tooltip is the CURRENTLY EQUIPPED item.
- The RIGHT or BOTTOM tooltip (often brighter/highlighted) is the NEW candidate.
- Analyze the NEW item. Compare which priority affixes it gains or loses vs. the equipped item.
- Set comparison_mode: true, fill equipped_item_name and equipped_affixes_lost/gained.
- upgrade_verdict: "UPGRADE" = new item is clearly better for this build, "SIDEGRADE" = roughly equal, "DOWNGRADE" = worse.`;

  if (!build) {
    return `You are a Diablo 4 item evaluation assistant. No build is loaded — evaluate on general D4 meta value.

${mechSection}

${comparisonSection}

OUTPUT: Valid JSON only, no markdown:
{
  "item_found": true,
  "item_name": "name from tooltip",
  "item_slot": "Helm/Chest/Gloves/Pants/Boots/Amulet/Ring/Weapon/etc.",
  "verdict": "KEEP|TEMPER|SALVAGE",
  "score": 0,
  "affixes_good": [],
  "affixes_bad": [],
  "tempering_fix": null,
  "reasoning": "2-3 sentences",
  "is_critical_item": false,
  "critical_item_name": null,
  "comparison_mode": false,
  "equipped_item_name": null,
  "equipped_affixes_lost": [],
  "equipped_affixes_gained": [],
  "upgrade_verdict": null
}`;
  }

  // Phase: PREPARING (missing critical items) vs OPTIMIZING (all found)
  const missing = build.criticalItems.filter(i => !i.found);
  const found   = build.criticalItems.filter(i => i.found);
  const isPreparing = missing.length > 0;

  // What content does the player need to reach?
  const hardestTier     = missing.map(i => i.farm?.tormentTier  ?? 'Torment 1').sort().reverse()[0] ?? 'Torment 1';
  const hardestLevel    = missing.map(i => i.farm?.characterLevel ?? '60+').sort().reverse()[0] ?? '60+';
  const farmActivities  = [...new Set(missing.map(i => i.farm?.activity).filter(Boolean))];

  const criticalSection = build.criticalItems.length > 0 ? `
BUILD-ENABLING ITEMS — ALWAYS CHECK THE SCREENSHOT FOR THESE:
${missing.length > 0
  ? `STILL NEEDED:
${missing.map(i => {
    const tag = i.itemType === 'aspect' ? '[ASPECT]' : '[UNIQUE]';
    return `  - ${i.name} ${tag} [${i.slot}]: ${i.why}
      Acquire: ${i.farm?.activity ?? 'any Torment content'} | ${i.farm?.tormentTier ?? 'Torment 1+'} | Char level ${i.farm?.characterLevel ?? '60+'}
      Tip: ${i.farm?.notes ?? ''}`;
  }).join('\n')}`
  : '  ✓ All critical items obtained — now optimizing BiS affixes'}
${found.length > 0 ? `Already obtained: ${found.map(i => i.name).join(', ')}` : ''}

If the screenshot shows one of the STILL NEEDED items above:
  → Set is_critical_item: true, critical_item_name: "<name>", verdict: "KEEP"
  → Explain in reasoning why this enables the build
  → Note: items marked [ASPECT] are Legendary Aspects — look for them as affixes on Legendary items (orange text), not as standalone drops` : '';

  const farmingSlotLines = farmingBuild && farmingBuild.slots.length > 0
    ? farmingBuild.slots.map(s => `  ${s.slot}: ${s.affixes.join(', ')}${s.notes ? ` (${s.notes})` : ''}`).join('\n')
    : null;

  let phaseSection: string;
  if (!isPreparing) {
    phaseSection = `CURRENT PHASE: OPTIMIZING (all build enablers found)
Evaluate items strictly on BiS affix matching for this build. Survivability matters less now — focus on damage multipliers.`;
  } else if (farmingBuild) {
    phaseSection = `CURRENT PHASE: PREPARING — farming with "${farmingBuild.name}" toward "${build.name}"

You are evaluating this item for the ACTIVE FARMING BUILD: ${farmingBuild.name} (${farmingBuild.class})
The target build (${build.name}) will become active once the player has the required items listed above.

FARMING BUILD PRIORITY AFFIXES — judge this item against THESE, not the target build:
${farmingSlotLines ?? '  (no slot data — use general damage/survivability for this class)'}

VERDICT RULES FOR THIS PHASE:
- Evaluate fit against the farming build's affixes above
- KEEP: good affixes for the farming build OR strong survivability
- TEMPER: decent farming build fit with a fixable gap
- SALVAGE: genuinely useless for the farming build AND no survivability value
- Do NOT salvage an item just because it doesn't fit the target build (${build.name})
- In reasoning, explain how this item helps or hurts the farming build (${farmingBuild.name})`;
  } else {
    phaseSection = `CURRENT PHASE: PREPARING (missing ${missing.length} build-enabling item${missing.length > 1 ? 's' : ''})
TARGET: Reach ${hardestTier} | Character level ${hardestLevel}
FARM GOAL: ${farmActivities.join(' + ') || 'Torment 1+ content'}

EVALUATION PRIORITY IN THIS PHASE (critical — this changes your scoring):
The target build is not yet active. The player is likely running a different or transitional build to farm toward it.
Do NOT evaluate items against BiS affixes for the target build. Evaluate on how well the item helps the player CLEAR CONTENT NOW.

1. SURVIVABILITY first: Max Life, Damage Reduction, Armor, Resistances matter MORE than damage affixes right now
2. DAMAGE OUTPUT second: any affixes that increase damage for the player's current skills — even if those skills don't match the target build
3. BiS AFFIXES third: a bonus, not a requirement

KEY RULE — SALVAGE threshold is HIGH in PREPARING phase:
Only SALVAGE an item if it provides zero useful stats for any reasonable Diablo 4 character (no damage, no defense, no utility).
If an item has strong affixes for a skill the player is currently using to farm (even a different skill than the target build), that is a KEEP or TEMPER.
A good item for a transitional/farming build is valuable — the player needs it to reach the content where the target build becomes active.

When an item has strong survivability + decent damage for any skill, lean KEEP even if it doesn't match target build affixes.
Always explain in reasoning: "In PREPARING phase, this [helps/doesn't help] your current farming ability because..."`;
  }


  const slotLines = build.slots.length > 0
    ? build.slots.map(s => `  ${s.slot}: ${s.affixes.join(', ')}${s.notes ? ` (${s.notes})` : ''}`).join('\n')
    : '  (No slot data parsed — use raw guide context below)';

  const rawSection = build.rawText
    ? `\nBUILD GUIDE CONTEXT:\n${build.rawText.slice(0, 2000)}`
    : '';

  return `You are a Diablo 4 item progression advisor for this build:

BUILD: ${build.name}
CLASS: ${build.class}
${criticalSection}
${phaseSection}

ENDGAME PRIORITY AFFIXES BY SLOT (for OPTIMIZING phase reference):
${slotLines}

KEY STATS: ${build.keyStats.join(', ') || 'see slot data'}
${rawSection}

${mechSection}

${comparisonSection}

VERDICT RULES:
- In PREPARING phase: evaluate on farming utility for the player's CURRENT skills, not the target build
  - KEEP: good survivability OR strong damage for any skill the player can currently use
  - TEMPER: decent stats but fixable gap — still useful for farming
  - SALVAGE: genuinely useless (no damage, no defense, no utility for any reasonable build)
- In OPTIMIZING phase: evaluate strictly on BiS affix matching for the target build
  - KEEP: ≥3 BiS affixes OR clearly better than equipped
  - TEMPER: 2 BiS affixes and gap is fixable
  - SALVAGE: doesn't match target build and can't be fixed
- Always state which phase applies and why your verdict follows from it

OUTPUT: Valid JSON only, no markdown:
{
  "item_found": true,
  "item_name": "name from tooltip",
  "item_slot": "Helm/Chest/Gloves/Pants/Boots/Amulet/Ring/Weapon/etc.",
  "verdict": "KEEP|TEMPER|SALVAGE",
  "score": 0,
  "affixes_good": ["affixes matching build priority"],
  "affixes_bad": ["affixes not useful for this build"],
  "tempering_fix": null,
  "reasoning": "2-3 sentences — specific to this build",
  "is_critical_item": false,
  "critical_item_name": null,
  "comparison_mode": false,
  "equipped_item_name": null,
  "equipped_affixes_lost": ["affixes on equipped item this new item lacks"],
  "equipped_affixes_gained": ["affixes new item has that equipped lacks"],
  "upgrade_verdict": null
}`;
}

// ── Token tracking ─────────────────────────────────────────────────────────

export interface TokenStats {
  input: number; output: number; cacheWrite: number; cacheRead: number; calls: number;
}

let sessionTokens: TokenStats = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
export function getTokenStats(): TokenStats { return { ...sessionTokens }; }
export function resetTokenStats() { sessionTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 }; }

function trackUsage(usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) {
  sessionTokens.input      += usage.input_tokens;
  sessionTokens.output     += usage.output_tokens;
  sessionTokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  sessionTokens.cacheRead  += usage.cache_read_input_tokens ?? 0;
  sessionTokens.calls      += 1;
}

// ── Analysis ───────────────────────────────────────────────────────────────

function detectMediaType(base64: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const header = base64.slice(0, 8);
  if (header.startsWith('/9j/')) return 'image/jpeg';
  if (header.startsWith('iVBOR'))  return 'image/png';
  if (header.startsWith('UklGR'))  return 'image/webp';
  return 'image/jpeg'; // default for our captured screenshots
}

export async function analyzeItem(
  imageBase64: string,
  build: BuildConfig | null,
  farmingBuild: BuildConfig | null = null,
  equipped: EquippedItem | null = null,
): Promise<ItemAnalysis> {
  const systemPrompt = buildSystemPrompt(build, farmingBuild);
  const mediaType = detectMediaType(imageBase64);

  const equippedNote = equipped
    ? `\n\nSTORED EQUIPPED ITEM FOR THIS SLOT — use for comparison even if only one tooltip is visible:\nName: ${equipped.item_name}\nAffixes: ${equipped.affixes.join(', ')}\nItem Power: ${equipped.item_power ?? 'unknown'}\nSet comparison_mode: true, equipped_item_name: "${equipped.item_name}", and fill equipped_affixes_lost/gained relative to this stored item.`
    : '';

  const resp = await client.beta.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    betas: ['prompt-caching-2024-07-31'],
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: `Analyze the item tooltip(s) in this screenshot. If two tooltips are visible (comparison view), evaluate the NEW item and compare it to the equipped one. If no item tooltip is visible, set item_found: false.${equippedNote}` },
      ],
    }],
  });

  trackUsage(resp.usage);

  let text = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
  text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  try {
    const parsed = JSON.parse(text) as Omit<ItemAnalysis, 'timestamp'>;
    // Ensure all new fields have defaults if Claude omitted them
    return {
      is_critical_item: false,
      critical_item_name: null,
      comparison_mode: false,
      equipped_item_name: null,
      equipped_affixes_lost: [],
      equipped_affixes_gained: [],
      upgrade_verdict: null,
      ...parsed,
      timestamp: Date.now(),
    };
  } catch {
    return {
      item_found: false,
      item_name: '',
      item_slot: '',
      verdict: 'SALVAGE',
      score: 0,
      affixes_good: [],
      affixes_bad: [],
      tempering_fix: null,
      reasoning: text || 'No item tooltip found in screenshot.',
      is_critical_item: false,
      critical_item_name: null,
      comparison_mode: false,
      equipped_item_name: null,
      equipped_affixes_lost: [],
      equipped_affixes_gained: [],
      upgrade_verdict: null,
      timestamp: Date.now(),
    };
  }
}

// ── Character sheet scan ────────────────────────────────────────────────────

const SCAN_SYSTEM = `You are analyzing a Diablo 4 character screen screenshot.
The player has opened their character sheet (C key) or inventory (I key).

Extract every equipped item that is identifiable from the screenshot.
Items may appear as:
- Full tooltip (hover active) — preferred, gives all affix details
- Slot icon with item name label
- Partially visible tooltip

For each identified item return:
{
  "item_name": "exact name from tooltip or label",
  "item_slot": "Helm|Chest|Gloves|Pants|Boots|Amulet|Ring|Ring 1|Ring 2|Weapon|Offhand|Shield",
  "item_power": 925,
  "affixes": ["all affixes listed on the item, one per entry"]
}

If a slot is visible but the item name is not readable, omit that slot entirely.
Return only slots you are confident about.

OUTPUT: Valid JSON array only, no markdown. Empty array [] if nothing is readable.`;

export async function scanEquipment(imageBase64: string): Promise<EquippedItem[]> {
  const mediaType = detectMediaType(imageBase64);
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: SCAN_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: 'Extract all equipped items visible in this character/inventory screen.' },
      ],
    }],
  });

  trackUsage(resp.usage);

  let text = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '[]';
  text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  try {
    const raw = JSON.parse(text) as Array<{ item_name: string; item_slot: string; item_power?: number | null; affixes?: string[] }>;
    const now = Date.now();
    return raw.map(r => ({
      item_name: r.item_name ?? '',
      item_slot: r.item_slot ?? '',
      item_power: r.item_power ?? null,
      affixes: r.affixes ?? [],
      scannedAt: now,
    })).filter(r => r.item_name && r.item_slot);
  } catch {
    return [];
  }
}
