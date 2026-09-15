# PalControl v0.6.3

PalControl is a Palworld control plane with one Node.js process for the dashboard, Discord bot, SQLite state/economy, official Palworld REST, hosted save synchronization and the new **PalControlBridge** UE4SS server-side integration.

For the current feature truth table, read [`INTEGRATION_STATUS.md`](INTEGRATION_STATUS.md).

## Current release

On hosts such as GPORTAL where the optional official `/game-data` endpoint is unavailable, PalControl no longer needs PalDefender or RCON for the core map/chat/kit path:

```text
Palworld -> UE4SS -> PalControlBridge -> files -> FTP -> PalControl -> Discord/Dashboard
```

The bridge provides:

- exact connected player names and XYZ coordinates;
- in-game chat events;
- join/leave/death events;
- item/kit delivery through the server-side inventory API;
- server announcements and personal player messages;
- best-effort loaded Pals/NPCs/base-camp map data;
- admin command IPC (position, teleport, kill, time, Pal spawn).

## Requirements

- Node.js 22.5+.
- `npm install` for hosted FTP transport.
- Palworld official REST API enabled with a real `AdminPassword`.
- For GPORTAL PalControlBridge: working UE4SS + FTP access.
- Optional: `palworld-save-reader` for offline/save-backed data.
- Optional fallbacks: PalDefender REST and/or compatible RCON.

## Install PalControl

```bash
npm install
cp .env.example .env
# edit .env
npm run doctor
npm start
```

Open `http://localhost:8787` or your configured `PUBLIC_BASE_URL`.

## Importing a Palworld item export

PalControl accepts the localization/item export format `{ "ItemID": { "localized_name": "...", "description": "..." } }`. Save the supplied export as `config/palworld-items-source.json`, then run:

```bash
npm run items:import
```

The importer writes categorized metadata to `config/palworld-items.json`. The IDs are marked as source-derived, not live-delivery verified; test an item on the active server before publishing it in the shop.

## Install PalControlBridge on GPORTAL

Upload:

```text
mods/PalControlBridge
```

to:

```text
/Pal/Binaries/Win64/ue4ss/Mods/PalControlBridge
```

Ensure `Mods/mods.txt` contains:

```text
PalControlBridge : 1
```

Disable/remove the old `PalControlMapBridge` directory, restart Palworld, then run:

```bash
npm run doctor
```

See [`docs/UE4SS-BRIDGE.md`](docs/UE4SS-BRIDGE.md).

## Recommended GPORTAL `.env`

```env
SERVER_PROVIDER=gportal

PALWORLD_REST_URL=http://YOUR_SERVER:REST_PORT
PALWORLD_REST_USERNAME=admin
PALWORLD_ADMIN_PASSWORD=...
PALWORLD_GAME_DATA_ENABLED=false

FTP_HOST=...
FTP_PORT=...
FTP_USER=...
FTP_PASSWORD=...
FTP_SECURE=false

PALWORLD_REMOTE_SAVE_PATH=/Pal/Saved/SaveGames/0/YOUR_WORLD_ID

UE4SS_BRIDGE_ENABLED=true
UE4SS_BRIDGE_REMOTE_DIR=/Pal/Binaries/Win64/ue4ss/Mods/PalControlBridge/data
UE4SS_BRIDGE_POLL_MS=3000
UE4SS_BRIDGE_WORLD_POLL_MS=10000
UE4SS_BRIDGE_COMMAND_TIMEOUT_MS=12000
# Disabled by default until live spawn testing proves this server build safe.
UE4SS_BRIDGE_SPAWN_ENABLED=false

PALWORLD_REMOTE_ACTOR_PATH=
PALDEFENDER_REMOTE_LOG_PATH=
PALDEFENDER_LOG_DIR=
PALDEFENDER_API_ENABLED=false

SHOP_ENABLED=true
SAVE_READER_ENABLED=true
```

Do not commit `.env`. Keep the Palworld REST port and credentials private.

## Data sources

PalControl deliberately uses different sources for different jobs:

- official `/players`: live account/platform identity and ping;
- official `/metrics`: FPS, uptime and counts;
- PalControlBridge `actors.json`: exact live player XYZ;
- PalControlBridge `world.json`: loaded world actors/bases;
- PalControlBridge `events.jsonl`: chat/game events;
- `palworld-save-reader`: offline players, guild/save-backed information;
- SQLite: links, sessions, economy, purchases, audit and heatmap history.

## Discord

Main commands include `/server`, `/players`, `/map`, `/link`, `/shop`, `/kit`, `/announce`, `/kick`, `/ban`, `/unban` and optional PalDefender `/whitelist` compatibility.

With PalControlBridge enabled:

- game chat is captured directly instead of tailing PalDefender logs;
- in-game `!link CODE` or `/link CODE` can complete a Discord link;
- in-game `!kit starter` or `/kit starter` can trigger the same kit service;
- Discord announcements prefer the bridge and fall back to PalDefender/official REST.

## Shop / kits

Configure real products and kit IDs in `config/shop.json`. Delivery priority is:

```text
PalControlBridge -> PalDefender REST -> PalDefender-compatible RCON
```

Purchases reserve coins before delivery and automatically refund on a delivery exception. Failed kit deliveries release the cooldown claim.

## Save reader

Windows amd64 `palworld-save-reader v0.2.0` is bundled. On Linux/Cybrancee run:

```bash
npm run setup:save-reader
```

Then enable:

```env
SAVE_READER_ENABLED=true
```

Hosted saves are synchronized into `REMOTE_CACHE_DIR` before reading.

## Verification

Internal tests:

```bash
npm test
npm run check
```

Live configured installation:

```bash
npm run doctor
```

Read-only deep inspection:

```bash
npm run doctor:full
```

`doctor` sends only a harmless bridge `ping`; it does not grant items or alter players. `doctor:full` does not write bridge commands at all.

Pal spawning is disabled by default with `UE4SS_BRIDGE_SPAWN_ENABLED=false` because the live `RequestSpawnMonsterForPlayer` path can block the UE4SS command loop on some dedicated-server builds. Item delivery and kits remain enabled through the independent inventory path.

## Prepare a customer release

```bash
npm run package:release
```

This creates `.release/PalControl-v0.6.3` without `.env`, credentials, SQLite runtime data, backups, remote caches, `node_modules` or bridge runtime files. See [`docs/SALES-PACKAGE.md`](docs/SALES-PACKAGE.md) before distributing the package.

## What is not faked

- GPORTAL process restart without a supported management API.
- Successful item/Pal delivery until the installed game build actually accepts the call.
- Perfect Pal/NPC/base classification across future Palworld updates.
- A `SpawnMonsterForPlayer` target guarantee on multiplayer until live-tested on that server build.

See [`CHANGELOG_v0.6.0.md`](CHANGELOG_v0.6.0.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).


## v0.6.2 note

Use PalControlBridge v1.0.3 with Palworld v1.0.5. The bridge uses the five-argument `AddItem_ServerInternal(..., bNotifyLog)` signature observed by UE4SS on the live server.
