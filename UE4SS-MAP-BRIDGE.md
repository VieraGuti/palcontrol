# Legacy map bridge note

The actor-only `PalControlMapBridge` is obsolete as of PalControl v0.6.0.

Use [`UE4SS-BRIDGE.md`](UE4SS-BRIDGE.md) and the unified `mods/PalControlBridge` instead. It provides player XYZ, world actors, chat/events and command IPC in one mod.

Leave `PALWORLD_REMOTE_ACTOR_PATH=` blank when `UE4SS_BRIDGE_ENABLED=true`.
