# PalControlBridge — UE4SS integration

PalControlBridge replaces the old single-purpose map bridge on hosts where Palworld's optional `/game-data` API is unavailable.

```text
Palworld Dedicated Server
        │
        ▼
      UE4SS
        │
        ▼
 PalControlBridge
   │    │     │
   │    │     └ command.json / response.json
   │    └ events.jsonl (chat/events)
   └ actors.json + world.json
        │
        ▼ FTP
   PalControl Node.js
        │
   ┌────┴──────────┐
   ▼               ▼
Discord         Dashboard/map
```

## Why this design

The bridge does not need an outbound HTTP connection from the game process. It writes small local files and PalControl reads/writes those files through the hosting provider's file transport. On GPORTAL that transport is FTP.

The Lua side uses UE4SS APIs such as `RegisterHook`, `NotifyOnNewObject`, `ExecuteInGameThread`, `LoopAsync` and periodic `FindAllOf` recovery scans. UE4SS documents `FindAllOf` as expensive, so the bridge caches objects instead of scanning the global object array every few seconds.

## PalControl configuration

```env
UE4SS_BRIDGE_ENABLED=true
UE4SS_BRIDGE_REMOTE_DIR=/Pal/Binaries/Win64/ue4ss/Mods/PalControlBridge/data
UE4SS_BRIDGE_POLL_MS=3000
UE4SS_BRIDGE_WORLD_POLL_MS=10000
UE4SS_BRIDGE_COMMAND_TIMEOUT_MS=12000

# Unified bridge supersedes the old actor-only path.
PALWORLD_REMOTE_ACTOR_PATH=

# These are not required when PalControlBridge is handling chat/kits.
PALDEFENDER_REMOTE_LOG_PATH=
PALDEFENDER_LOG_DIR=
PALDEFENDER_API_ENABLED=false
```

## Server files

```text
ue4ss/Mods/PalControlBridge/
├── enabled.txt
├── Scripts/
│   └── main.lua
└── data/                 # created automatically
    ├── heartbeat.json
    ├── state.json
    ├── actors.json
    ├── world.json
    ├── events.jsonl
    ├── command.json      # transient
    └── response.json
```

## Live-verification boundary

`npm test` verifies PalControl's local protocol/control logic. `npm run doctor` additionally performs a real bridge heartbeat check and a harmless `ping` command through FTP. `npm run doctor:full` is read-only and inspects heartbeat/snapshot/log files without writing commands.

## Command capabilities

The current bridge has live handlers for `ping`, `list_players`, `get_position`, `give_item`, `give_items`, `announce`, `personal_message`, `teleport`, `kill_player`, `set_time`, and `spawn_pal`.

There is currently no verified handler for player healing, respawn, or changing player level/experience. PalControl must keep those operations unavailable until a UE4SS implementation is tested on the active Palworld build and returns a confirmed response.
