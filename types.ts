// ── Build types ────────────────────────────────────────────────────────────

export interface SlotPriority {
  slot: string;
  affixes: string[];
  notes?: string;
}

export interface FarmTarget {
  activity: string;         // "Kill Andariel", "Helltide Chest (Pants)", "Any Torment 1+ content"
  tormentTier: string;      // "Torment 1+", "Torment 4", "Any WT4" — minimum to get drops
  characterLevel: string;   // "60+", "70+", "80+"
  pitTier?: string;         // if Pit is the recommended farm — "Pit 30+", "Pit 60+"
  notes: string;            // e.g. "Andariel drops this at ~50% rate on Torment 2+"
}

export type CriticalItemType = 'unique_item' | 'aspect';

export interface CriticalItem {
  name: string;             // e.g. "Kessime's Legacy" or "Hematolagnia"
  slot: string;             // e.g. "Ring", "Pants", "Helm", or "Aspect" for codex
  itemType: CriticalItemType; // 'unique_item' = boss drop; 'aspect' = dungeon/codex/extract
  why: string;              // one sentence — why this item enables the build
  found: boolean;           // player has obtained it
  farm: FarmTarget;         // where/how to get it
}

export interface BuildConfig {
  name: string;
  class: string;
  url: string;
  fetchedAt: string;
  slots: SlotPriority[];
  keyStats: string[];
  criticalItems: CriticalItem[];   // must-have uniques that enable the build
  rawText?: string;
}

// ── Item analysis types ────────────────────────────────────────────────────

export type Verdict = 'KEEP' | 'TEMPER' | 'SALVAGE';
export type UpgradeVerdict = 'UPGRADE' | 'SIDEGRADE' | 'DOWNGRADE';

export interface ItemAnalysis {
  // Core
  item_found: boolean;
  item_name: string;
  item_slot: string;
  verdict: Verdict;
  score: number;
  affixes_good: string[];
  affixes_bad: string[];
  tempering_fix: string | null;
  reasoning: string;
  // Critical item detection
  is_critical_item: boolean;
  critical_item_name: string | null;
  // Comparison mode (two tooltips visible)
  comparison_mode: boolean;
  equipped_item_name: string | null;
  equipped_affixes_lost: string[];     // affixes on equipped item that new item lacks
  equipped_affixes_gained: string[];   // affixes new item has that equipped lacks
  upgrade_verdict: UpgradeVerdict | null;
  // Meta
  timestamp: number;
}

// ── Equipped loadout ───────────────────────────────────────────────────────

export interface EquippedItem {
  item_name: string;
  item_slot: string;
  item_power: number | null;
  affixes: string[];   // all affixes visible on the item
  scannedAt: number;
}

export type EquippedLoadout = Partial<Record<string, EquippedItem>>;

// ── Build evaluation ───────────────────────────────────────────────────────

export type SlotVerdict = 'BiS' | 'Good' | 'Upgrade needed' | 'Replace ASAP';

export interface SlotEval {
  slot: string;
  item_name: string;
  score: number;         // 0–10
  hits: string[];        // affixes that match build priority
  misses: string[];      // affixes not useful / missing
  verdict: SlotVerdict;
  note: string;          // one sentence
}

export interface BuildEvaluation {
  overall_score: number;
  phase: 'PREPARING' | 'OPTIMIZING';
  summary: string;
  weakest_slots: string[];   // ordered worst first
  slot_evals: SlotEval[];
  next_steps: string[];      // top 3 action items
  obols_recommendation: string;  // what to gamble at Purveyor of Curiosities
  timestamp: number;
}

// ── API payloads ───────────────────────────────────────────────────────────

export interface LoadBuildRequest {
  url: string;
}

export interface AnalyzeRequest {
  imageBase64?: string;
}

export interface MarkFoundRequest {
  name: string;
  found: boolean;
}
