# Diablo 4 Item Advisor

A local web app that captures D4 item screenshots and uses Claude's vision API to evaluate items against a loaded Maxroll build guide.

## Running

```bash
bun start          # production
bun run dev        # watch mode (auto-restarts on file changes)
```

Server starts at `http://localhost:4002`. The UI is served from `public/index.html`.

**Required:** `ANTHROPIC_API_KEY` in environment or `.env` file.

## Architecture

```
server.ts           — Bun HTTP server, all API routes, SSE broadcast, screenshot watcher
item-analyzer.ts    — Claude vision calls (item analysis + character sheet scan)
build-loader.ts     — Fetches Maxroll guide, extracts slot priorities + critical items via Claude
equipment-store.ts  — Read/write config/equipment.json (equipped loadout)
history-store.ts    — Read/write config/history.json (last 200 analyses)
screenshot.ts       — PowerShell screen capture (Windows/WSL only)
screenshot-watcher.ts — Polls D4 screenshots folder, fires analysis on new PNG/JPG
image-utils.ts      — Compresses oversized images to fit Claude API 5MB limit (uses sharp)
wowhead-client.ts   — Wowhead item lookup with Claude fallback
types.ts            — All shared TypeScript interfaces
public/index.html   — Single-file frontend (vanilla JS, no build step)
```

## Config files (config/)

| File | Purpose |
|------|---------|
| `settings.json` | Screenshots folder path, delete-after-analysis flag |
| `build.json` | Currently loaded build (slots, criticalItems, rawText) |
| `equipment.json` | Equipped loadout keyed by slot name |
| `history.json` | Array of up to 200 past ItemAnalysis results |

## API routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/build` | Load a Maxroll build URL |
| GET | `/build` | Get current build |
| POST | `/build/found` | Toggle critical item found status |
| POST | `/build/activate-endgame` | Mark all critical items found + clear farming build (switches AI to OPTIMIZING mode) |
| POST | `/build/farming` | Load a farming build URL |
| GET | `/build/farming` | Get current farming build |
| DELETE | `/build/farming` | Clear farming build |
| POST | `/analyze` | Analyze screenshot (body: `{imageBase64?}`) |
| GET | `/equipment` | Get equipped loadout |
| POST | `/equipment/scan` | Scan character sheet screenshot |
| POST | `/equipment/slot` | Manually set a slot |
| DELETE | `/equipment/:slot` | Clear a slot |
| DELETE | `/equipment` | Clear all slots |
| GET | `/events` | SSE stream (analysis events) |
| GET | `/wowhead?q=` | Item lookup |
| GET | `/history` | All past analyses |
| GET | `/stats` | Token usage stats |
| POST | `/settings` | Update settings |

## Models used

| Task | Model | Why |
|------|-------|-----|
| Item analysis | `claude-sonnet-4-6` | Needs vision + reasoning; prompt-cached for cost |
| Character sheet scan | `claude-sonnet-4-6` | Vision required |
| Critical item extraction | `claude-haiku-4-5-20251001` | Build-load only, text-only, cheap |
| Wowhead parsing | `claude-haiku-4-5-20251001` | Simple extraction |

## Item slot key convention

Equipment is keyed by the exact slot string: `Helm`, `Chest`, `Gloves`, `Pants`, `Boots`, `Amulet`, `Ring 1`, `Ring 2`, `Weapon`, `Offhand`. Claude returns `Ring` for ring items — the frontend resolves to `Ring 1`/`Ring 2` explicitly on save.

## Screenshot modes

- **Watcher (auto):** D4 `PrintScreen` saves to the configured folder; watcher picks it up and auto-analyzes.
- **Hotkey listener (`hotkey-listener.ps1`):** Windows PowerShell script that captures the screen and POSTs to `/analyze` on a keypress — useful when Windows Defender blocks the inline PS script.
- **Paste/upload:** Drag an image onto the drop zone or paste from clipboard.

Screenshots are automatically compressed before being sent to Claude if they exceed the 5MB API limit. `image-utils.ts` resizes to max 1920px wide and re-encodes as JPEG, stepping down quality until the image fits. This applies to all three input paths.

## Build phases

The AI evaluates items differently depending on phase, determined by critical item status:

- **PREPARING + farming build loaded:** Items evaluated against the farming build's affixes. Farming build routes (`/build/farming`) manage this.
- **PREPARING + no farming build:** Items evaluated on general farming utility for current skills.
- **OPTIMIZING:** All critical items marked found. Items evaluated strictly against target build BiS affixes.

Transition: when the Transition Plan panel shows "Ready to switch!", clicking **Activate [Build Name]** calls `POST /build/activate-endgame`, which marks all critical items found and clears the farming build in one shot.

## Extending

- To add a new build guide source: implement a fetcher in `build-loader.ts` that returns the same `BuildConfig` shape.
- To change the analysis model or prompt: edit `buildSystemPrompt()` in `item-analyzer.ts`.
- The frontend is a single HTML file — no bundler needed.
