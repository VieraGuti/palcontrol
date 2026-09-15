# PalControlBridge v1.0.5

Unified server-side UE4SS bridge for PalControl.

## Install

Copy this whole folder to:

```text
Pal/Binaries/Win64/ue4ss/Mods/PalControlBridge
```

Enable it in `Pal/Binaries/Win64/ue4ss/Mods/mods.txt`:

```text
PalControlBridge : 1
```

`enabled.txt` is also included. Restart the Palworld server after replacing `Scripts/main.lua`.

**Disable/remove the old `PalControlMapBridge` mod.** It is obsolete and can create duplicate scans/log spam.

## Data/IPC files

The mod creates `data/` automatically:

- `heartbeat.json` — liveness, bridge version and feature flags.
- `state.json` — boot/ready state.
- `actors.json` — exact live player names and XYZ coordinates.
- `world.json` — best-effort loaded Pals/NPCs/base-camp actors and coordinates.
- `events.jsonl` — chat, join/leave, death and delivery/admin events; rotates at 5 MB.
- `command.json` — one serialized command written by PalControl.
- `response.json` — result of the most recent command.

## Commands

Implemented file-IPC actions:

```text
ping
list_players
get_position
give_item
give_items
announce
personal_message
teleport
kill_player
set_time
spawn_pal
```

Item delivery uses `PalPlayerState:GetInventoryData()` and server-side `AddItem_ServerInternal()`. The bridge uses the five-argument server signature verified by the live Palworld v1.0.5 / UE4SS reflection:
`AddItem_ServerInternal(FName, Count, IsAssignPassive, LogDelay, bNotifyLog)`.

Chat capture hooks `/Script/Pal.PalPlayerController:EnterChat_Receive`.

## Performance

`FindAllOf` is deliberately not used on every map refresh. The bridge caches objects, uses `NotifyOnNewObject` where possible, refreshes player positions every 2 seconds, and only performs recovery rescans periodically. This follows UE4SS guidance that `FindAllOf` is expensive because it traverses the global object array.

## Verification status

Already live-proven on the target GPORTAL test server:

- UE4SS loads this custom Lua mod.
- The mod can create/write files under its own `data` directory.
- `PalPlayerState` -> pawn -> `K2_GetActorLocation()` returns the connected player's real name and XYZ.

Still requires live verification after this v1.0.5 upload:

- chat event capture into `events.jsonl`;
- item grant execution through `AddItem_ServerInternal` (UNVERIFIED until a real delivery succeeds);
- personal/system announcements;
- loaded-world classification for Pals/NPCs/bases;
- `RequestSpawnMonsterForPlayer` targeting on multi-player servers (UNVERIFIED until tested against the live server).
