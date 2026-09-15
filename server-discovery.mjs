import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(left, right) {
  const a = String(left ?? '').match(SEMVER);
  const b = String(right ?? '').match(SEMVER);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i += 1) {
    const delta = Number(a[i]) - Number(b[i]);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export class ServerDiscoveryService {
  constructor({ ftpStore = null, restClient = null, bridgeRoot = './mods/PalControlBridge', logger = console } = {}) {
    this.ftpStore = ftpStore;
    this.restClient = restClient;
    this.bridgeRoot = path.resolve(bridgeRoot);
    this.logger = logger;
  }

  candidatePaths() {
    return [
      '/Pal',
      '/palworld/Pal',
      '/Pal/Binaries/Win64',
      '/palworld/Pal/Binaries/Win64',
      '/Pal/Binaries/Win64/ue4ss',
      '/palworld/Pal/Binaries/Win64/ue4ss',
      '/Pal/Binaries/Win64/ue4ss/Mods',
      '/palworld/Pal/Binaries/Win64/ue4ss/Mods'
    ];
  }

  async discover({ ftpStore = this.ftpStore, restClient = this.restClient, candidates = this.candidatePaths() } = {}) {
    const summary = {
      discovered: false,
      palRoot: '',
      palBinariesPath: '',
      ue4ssPath: '',
      ue4ssModsPath: '',
      bridgePath: '',
      bridgeDataPath: '',
      saveGamesPath: '',
      worldGuid: '',
      candidates: [],
      notes: []
    };

    if (ftpStore && typeof ftpStore.list === 'function') {
      for (const candidate of candidates) {
        summary.candidates.push(candidate);
        try {
          const listing = await ftpStore.list(candidate);
          if (!Array.isArray(listing) || !listing.length) continue;
          const names = listing.map((entry) => String(entry?.name ?? '')).filter(Boolean).map((name) => name.toLowerCase());
          const rootLooksValid = names.includes('binaries') && names.includes('saved');
          const ue4ssLooksValid = names.includes('ue4ss') || names.includes('mods');
          if (rootLooksValid || ue4ssLooksValid) {
            summary.discovered = true;
            summary.palRoot = candidate.replace(/\/+(?:binaries|saved|win64|ue4ss|mods)$/i, '') || candidate;
            summary.palBinariesPath = candidate.includes('/Binaries') ? candidate : `${summary.palRoot}/Binaries/Win64`;
            summary.ue4ssPath = `${summary.palBinariesPath}/ue4ss`;
            summary.ue4ssModsPath = `${summary.ue4ssPath}/Mods`;
            summary.bridgePath = `${summary.ue4ssModsPath}/PalControlBridge`;
            summary.bridgeDataPath = `${summary.bridgePath}/data`;
            summary.saveGamesPath = `${summary.palRoot}/Saved/SaveGames`;
            break;
          }
        } catch (error) {
          this.logger.warn?.('[server-discovery]', error.message);
        }
      }
    }

    if (restClient && typeof restClient.info === 'function') {
      try {
        const info = await restClient.info();
        summary.worldGuid = String(info?.worldguid ?? info?.worldGuid ?? info?.world_guid ?? '').trim();
      } catch (error) {
        summary.notes.push(error.message);
      }
    }

    if (summary.saveGamesPath && summary.worldGuid) {
      summary.saveGamesPath = `${summary.saveGamesPath}/0/${summary.worldGuid}`;
    }

    return summary;
  }

  ensureModsTxtEntry(modsTxt = '', modName = 'PalControlBridge') {
    const lines = String(modsTxt || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('#'));

    const seen = new Set();
    const kept = [];
    for (const line of lines) {
      const key = line.split(':', 1)[0].trim();
      if (!key) continue;
      if (key.toLowerCase() === modName.toLowerCase()) continue;
      if (seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      kept.push(line);
    }

    const target = `${modName} : 1`;
    if (!kept.some((line) => line.split(':', 1)[0].trim().toLowerCase() === modName.toLowerCase())) kept.push(target);
    return `${kept.join('\n')}\n`;
  }

  async readVersionFile(rootDir) {
    try {
      const versionFile = path.join(rootDir, 'VERSION');
      const content = await fs.readFile(versionFile, 'utf8');
      return String(content).trim();
    } catch {
      return '';
    }
  }

  async readBundledVersion(rootDir = this.bridgeRoot) {
    const versionFile = await this.readVersionFile(rootDir);
    if (versionFile) return versionFile;
    try {
      const source = await fs.readFile(path.join(rootDir, 'Scripts', 'main.lua'), 'utf8');
      return source.match(/local VERSION\s*=\s*["']([^"']+)["']/)?.[1] ?? '';
    } catch {
      return '';
    }
  }

  async fileSha256(filePath) {
    return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex').toUpperCase();
  }

  async downloadRemoteJson(remoteStore, remotePath) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-bridge-'));
    const localPath = path.join(tempDir, path.basename(remotePath));
    try {
      await remoteStore.downloadFile(remotePath, localPath);
      return JSON.parse(await fs.readFile(localPath, 'utf8'));
    } catch {
      return null;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async remoteFileExists(remoteStore, remotePath) {
    if (!remoteStore || typeof remoteStore.downloadFile !== 'function') return false;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-bridge-'));
    try {
      await remoteStore.downloadFile(remotePath, path.join(tempDir, path.basename(remotePath)));
      return true;
    } catch {
      return false;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async remoteFileSha256(remoteStore, remotePath) {
    if (!remoteStore || typeof remoteStore.downloadFile !== 'function') return '';
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-bridge-'));
    const localPath = path.join(tempDir, path.basename(remotePath));
    try {
      await remoteStore.downloadFile(remotePath, localPath);
      return await this.fileSha256(localPath);
    } catch {
      return '';
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async inspectBridge({ remoteStore, bridgePath, localBridgeRoot = this.bridgeRoot } = {}) {
    const bundledVersion = await this.readBundledVersion(localBridgeRoot);
    const bundledHash = await this.fileSha256(path.join(localBridgeRoot, 'Scripts', 'main.lua')).catch(() => '');
    const heartbeat = remoteStore && bridgePath
      ? await this.downloadRemoteJson(remoteStore, `${bridgePath}/data/heartbeat.json`)
      : null;
    const remoteFiles = remoteStore && bridgePath
      ? await this.remoteFileExists(remoteStore, `${bridgePath}/Scripts/main.lua`)
      : false;
    const remoteHash = remoteStore && bridgePath
      ? await this.remoteFileSha256(remoteStore, `${bridgePath}/Scripts/main.lua`)
      : '';
    const remoteVersion = String(heartbeat?.version ?? '').trim();
    const comparison = remoteVersion ? compareVersions(remoteVersion, bundledVersion) : null;
    this.logger.log?.(`[bridge] bundled version: ${bundledVersion || 'unknown'}`);
    this.logger.log?.(`[bridge] bundled SHA256: ${bundledHash || 'unknown'}`);
    this.logger.log?.(`[bridge] remote heartbeat version: ${remoteVersion || 'missing'}`);
    if (comparison === 1) {
      this.logger.warn?.(`[bridge] refusing overwrite: remote ${remoteVersion} is newer than bundled ${bundledVersion}`);
      return { action: 'PROTECTED', bundledVersion, remoteVersion, heartbeat, remoteFiles };
    }
    if (comparison === -1) this.logger.log?.(`[bridge] update required: ${remoteVersion} -> ${bundledVersion}`);
    if (comparison === 0 && bundledHash && remoteHash && bundledHash !== remoteHash) {
      this.logger.log?.(`[bridge] content update required: ${remoteHash} -> ${bundledHash}`);
      return { action: 'UPDATE', bundledVersion, bundledHash, remoteVersion, remoteHash, heartbeat, remoteFiles };
    }
    if (comparison === 0) return { action: 'NOOP', bundledVersion, bundledHash, remoteVersion, remoteHash, heartbeat, remoteFiles };
    if (!heartbeat && !remoteFiles) return { action: 'INSTALL', bundledVersion, remoteVersion: '', heartbeat: null, remoteFiles: false };
    if (comparison === -1) return { action: 'UPDATE', bundledVersion, bundledHash, remoteVersion, remoteHash, heartbeat, remoteFiles };
    return { action: 'UNKNOWN', bundledVersion, bundledHash, remoteVersion, remoteHash, heartbeat, remoteFiles };
  }

  async syncBridge({ remoteStore, bridgePath, localBridgeRoot = this.bridgeRoot, waitMs = 20000, pollMs = 1000 } = {}) {
    if (!remoteStore?.enabled || !bridgePath) throw new Error('Bridge upload requires an enabled remote store and bridge path.');
    const inspection = await this.inspectBridge({ remoteStore, bridgePath, localBridgeRoot });
    if (inspection.action === 'PROTECTED') return { ...inspection, status: 'PROTECTED' };
    if (inspection.action === 'NOOP') return { ...inspection, status: 'UP_TO_DATE', restartRequired: false };
    if (inspection.action === 'UNKNOWN') throw new Error('Remote bridge files exist without a readable heartbeat; refusing automatic overwrite.');

    await remoteStore.uploadTree(localBridgeRoot, bridgePath);
    const deadline = Date.now() + Math.max(0, waitMs);
    let runningVersion = '';
    while (Date.now() <= deadline) {
      const heartbeat = await this.downloadRemoteJson(remoteStore, `${bridgePath}/data/heartbeat.json`);
      runningVersion = String(heartbeat?.version ?? '').trim();
      if (runningVersion === inspection.bundledVersion) {
        this.logger.log?.(`[bridge] files installed: ${inspection.bundledVersion}`);
        return { ...inspection, status: 'READY', runningVersion, heartbeat, restartRequired: false };
      }
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
    }
    this.logger.log?.(`[bridge] files installed: ${inspection.bundledVersion}`);
    this.logger.log?.(`[bridge] running version: ${runningVersion || 'unknown'}`);
    this.logger.log?.('[bridge] status: RESTART_REQUIRED');
    return { ...inspection, status: 'RESTART_REQUIRED', runningVersion, restartRequired: true };
  }

  async installBridgeIfNeeded({ modsPath, localBridgeRoot = this.bridgeRoot } = {}) {
    if (!modsPath) {
      return { installed: false, reason: 'No UE4SS mods path was discovered.' };
    }

    const bridgePath = path.join(modsPath, 'PalControlBridge');
    const localVersion = await this.readBundledVersion(localBridgeRoot);
    const remoteVersion = await this.readBundledVersion(bridgePath);

    try {
      await fs.access(bridgePath);
      const comparison = compareVersions(remoteVersion, localVersion);
      if (comparison === 1) {
        this.logger.warn?.(`[bridge] refusing local overwrite: remote ${remoteVersion} is newer than bundled ${localVersion}`);
        return { installed: true, updated: false, path: bridgePath, previousVersion: remoteVersion, version: localVersion, status: 'protected' };
      }
      if (comparison === 0) {
        return { installed: true, updated: false, path: bridgePath, version: remoteVersion, status: 'up-to-date' };
      }
      const backupDir = `${bridgePath}.backup`;
      await fs.rm(backupDir, { recursive: true, force: true });
      await fs.cp(bridgePath, backupDir, { recursive: true, force: true });
      await fs.rm(bridgePath, { recursive: true, force: true });
      await fs.cp(localBridgeRoot, bridgePath, { recursive: true, force: true });
      return { installed: true, updated: true, path: bridgePath, previousVersion: remoteVersion || 'unknown', version: localVersion || 'unknown', status: 'updated' };
    } catch {
      await fs.cp(localBridgeRoot, bridgePath, { recursive: true, force: true });
      return { installed: true, updated: true, path: bridgePath, version: localVersion || 'unknown', status: 'installed' };
    }
  }
}
