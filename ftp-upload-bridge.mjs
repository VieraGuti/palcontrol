import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../src/config.mjs';
import { FtpFileStore } from '../src/services/remote-files.mjs';
import { ServerDiscoveryService } from '../src/services/server-discovery.mjs';

const localDir = path.resolve('mods/PalControlBridge');
const remoteDir = '/Pal/Binaries/Win64/ue4ss/Mods/PalControlBridge';
const ftp = new FtpFileStore(config.remoteFiles.ftp);
const discovery = new ServerDiscoveryService({ bridgeRoot: localDir, logger: console });
const bundledMain = path.join(localDir, 'Scripts', 'main.lua');
const bundledHash = createHash('sha256').update(await fs.readFile(bundledMain)).digest('hex').toUpperCase();
const bundledVersion = await discovery.readBundledVersion(localDir);

console.log(`[bridge] bundled root: ${localDir}`);
console.log(`[bridge] bundled main.lua: ${bundledMain}`);
console.log(`[bridge] bundled version: ${bundledVersion || 'unknown'}`);
console.log(`[bridge] bundled SHA256: ${bundledHash}`);

if (!ftp.enabled) throw new Error('FTP is not configured. Set FTP_HOST, FTP_PORT, FTP_USER and FTP_PASSWORD.');
const result = await discovery.syncBridge({ remoteStore: ftp, bridgePath: remoteDir, localBridgeRoot: localDir });
if (result.status === 'PROTECTED') throw new Error(`Remote PalControlBridge ${result.remoteVersion} is newer than bundled ${result.bundledVersion}; upload refused.`);

console.log(`Bridge sync ${result.status}: ${localDir} -> ${remoteDir}`);
console.log('Ensure Mods/mods.txt contains: PalControlBridge : 1');
console.log('Disable/remove the legacy PalControlMapBridge mod to avoid duplicate work and log spam.');
console.log('Restart Palworld, then run: npm run doctor');
