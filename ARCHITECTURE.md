# PalControl architecture — v0.6.0

```text
                         Discord Gateway/API
                                │
                                ▼
                          DiscordClient
                                │
      ┌─────────────────────────┴─────────────────────────┐
      │                  PALCONTROL CORE                 │
      │                                                  │
      │ Official REST ─ Poller ─ SQLite ─ HTTP/SSE      │
      │      │                    │                       │
      │      │                    ├ sessions/playtime     │
      │      │                    ├ positions/heatmap     │
      │      │                    └ wallets/purchases     │
      │      │                                            │
      │      └ info/players/metrics/settings/admin REST   │
      │                                                   │
      │ Ue4ssBridge ─ Shop/Kits/Chat/Map/Admin actions   │
      │      │                                            │
      │      ├ heartbeat / player XYZ / world actors      │
      │      ├ chat + join/leave/death events             │
      │      └ item delivery / messages / commands        │
      └───────────────┬──────────────────┬────────────────┘
                      │                  │
                      ▼                  ▼
               Provider adapter      SaveSource
                                      │
                            hosted FTP / local saves
                                      │
                                      ▼
                              palworld-save-reader
```

## Source-of-truth rules

- Online account identifiers, ping and basic player info: official Palworld `/players`.
- FPS/player count/uptime/settings: official Palworld REST.
- Exact live player XYZ on GPORTAL: PalControlBridge `actors.json`.
- Loaded Pal/NPC/base map actors: PalControlBridge `world.json` (best-effort classification).
- Game -> Discord chat: PalControlBridge `EnterChat_Receive` event hook.
- Discord -> game message: PalControlBridge announcement first; PalDefender/official REST are fallbacks.
- Shop/kit items: PalControlBridge server-side inventory call first; PalDefender REST/RCON are fallbacks.
- Offline save/guild/player data: `palworld-save-reader` when enabled.
- Historical analytics/economy/audit: PalControl SQLite.
- Hosting process restart/stop: provider adapter only; no fake GPORTAL restart API.

## UE4SS performance boundary

Player/world UObject references are cached. `NotifyOnNewObject` fills caches between recovery scans. `FindAllOf` is used periodically for self-healing, not every render/poll tick, because UE4SS documents full-array scans as slow.

## Command boundary

PalControl serializes bridge commands because the server-side mod exposes one `command.json` inbox. FTP upload uses a temporary remote file followed by rename, so the Lua parser does not consume a partially uploaded JSON file. The mod writes `response.json` with the same UUID; PalControl ignores stale responses with other IDs.

## Delivery transaction boundary

A shop purchase reserves wallet funds, attempts game delivery, settles on success, and refunds on error. A failed kit delivery also releases its cooldown claim. This prevents transport failures from silently consuming coins/cooldowns.
