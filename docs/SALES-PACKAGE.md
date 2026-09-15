# PalControl customer package

## What the customer receives

- PalControl source and production configuration template.
- PalControlBridge v1.0.5 SAFE PAL RPC.
- GPORTAL/UE4SS upload and diagnostics scripts.
- Discord bot, dashboard, shop and kit services.
- Installation and verification documentation.

## Build the release package

From the project root:

```bash
npm run package:release
```

The generated directory is `.release/PalControl-v0.6.3` (the version comes from `package.json`). It excludes `.env`, `node_modules`, SQLite files, backups, remote caches and bridge runtime data.

Zip the generated directory for delivery through the chosen storefront. Do not upload the working directory directly.

## Customer installation

```bash
npm install --omit=dev
cp .env.example .env
# edit .env with the customer's own server and Discord credentials
npm run doctor
npm start
```

For Cybrancee/Linux, enable `SAVE_READER_ENABLED` only after installing the Linux save-reader binary. The bundled Windows executable is not used on Linux.

## GPORTAL setup

1. Configure REST and FTP values in `.env`.
2. Set `UE4SS_BRIDGE_ENABLED=true`.
3. Run `npm run ftp:upload-bridge`.
4. Ensure `PalControlBridge : 1` exists in UE4SS `Mods/mods.txt`.
5. Restart the Palworld server so UE4SS loads the bridge.
6. Run `npm run doctor` and confirm bundled and running bridge versions match.

`UE4SS_BRIDGE_SPAWN_ENABLED` is `false` by default. Keep it disabled unless spawnPal has been tested on the customer's exact Palworld/UE4SS build; enabling an unsafe spawn RPC can block kits and item delivery.

## Distribution safety

Never include `.env`, FTP passwords, REST passwords, Discord tokens, database files, backups, or `data/remote-cache` in a customer package. Every customer must generate their own `SESSION_SECRET`, `PANEL_PASSWORD`, and service credentials.

Keep the source repository private. A private GitHub repository is suitable for development and release management, not as the customer download location unless each buyer is deliberately granted repository access.

This document is an operational template, not legal advice. Add the commercial license, refund policy, support terms and third-party notices required for the storefront and jurisdiction before selling.
