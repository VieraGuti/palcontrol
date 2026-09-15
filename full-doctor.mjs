import { PALCONTROL_VERSION } from '../src/version.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { PalworldRestClient } from '../src/palworld/rest-client.mjs';
import { FtpFileStore } from '../src/services/remote-files.mjs';
import { SaveReaderService } from '../src/services/save-reader.mjs';

const pass = (name, detail = '') => console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
const fail = (name, detail) => console.log(`FAIL ${name} - ${detail}`);
const warn = (name, detail) => console.log(`WARN ${name} - ${detail}`);
const skip = (name, detail) => console.log(`SKIP ${name} - ${detail}`);

console.log(`PalControl full doctor v${PALCONTROL_VERSION}\n`);

const rest = new PalworldRestClient({
  baseUrl: config.palworld.restUrl,
  username: config.palworld.username,
  password: config.palworld.password,
  timeoutMs: config.palworld.timeoutMs
});

for (const [name, call] of [
  ['REST /info', () => rest.info()],
  ['REST /players', () => rest.players()],
  ['REST /metrics', () => rest.metrics()],
  ['REST /settings', () => rest.settings()]
]) {
  try { pass(name, JSON.stringify(await call()).slice(0, 180)); }
  catch (error) { fail(name, error.message); }
}

if (config.palworld.gameDataEnabled) {
  try {
    const data = await rest.gameData();
    pass('REST /game-data', `${data.ActorData?.length ?? 0} actors`);
  } catch (error) {
    fail('REST /game-data', error.status === 404 ? '404: server is missing -enable-gamedata-api' : error.message);
  }
} else skip('REST /game-data', 'disabled; PalControlBridge is the actor source');

const root = path.resolve(config.remoteFiles.cacheDir, 'full-doctor');
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true });

if (!config.remoteFiles.ftp.host || !config.remoteFiles.ftp.user || !config.remoteFiles.ftp.password) {
  skip('FTP', 'credentials incomplete');
} else {
  const ftp = new FtpFileStore(config.remoteFiles.ftp);
  try {
    await ftp.list('/');
    pass('FTP connection', `${config.remoteFiles.ftp.host}:${config.remoteFiles.ftp.port}`);

    if (config.ue4ssBridge.enabled) {
      const bridgeDir = config.ue4ssBridge.remoteDir;
      const readBridgeJson = async (name, required = true) => {
        try {
          const local = path.join(root, name);
          await ftp.downloadFile(`${bridgeDir}/${name}`, local);
          return JSON.parse(await fs.readFile(local, 'utf8'));
        } catch (error) {
          if (required) fail(`PalControlBridge ${name}`, error.message);
          else warn(`PalControlBridge ${name}`, error.message);
          return null;
        }
      };

      const hb = await readBridgeJson('heartbeat.json');
      if (hb) {
        const age = Date.now() - Date.parse(hb.timestamp || '');
        if (hb.loaded && Number.isFinite(age) && age < 30_000) pass('PalControlBridge heartbeat', `v${hb.version} · ${Math.max(0, Math.round(age / 1000))}s old`);
        else fail('PalControlBridge heartbeat', `stale/invalid heartbeat: ${JSON.stringify(hb).slice(0,180)}`);
      }

      const actors = await readBridgeJson('actors.json');
      if (actors) pass('PalControlBridge actors.json', `${(actors.actors ?? actors.players ?? []).length} live player actor(s)`);

      const world = await readBridgeJson('world.json', false);
      if (world) pass('PalControlBridge world.json', `${world.actors?.length ?? 0} loaded world actor(s)`);

      const state = await readBridgeJson('state.json', false);
      if (state) pass('PalControlBridge state.json', `${state.status ?? 'unknown'} · ready=${state.ready}`);

      try {
        await ftp.downloadFile('/Pal/Binaries/Win64/ue4ss/UE4SS.log', path.join(root, 'UE4SS.log'));
        const log = await fs.readFile(path.join(root, 'UE4SS.log'), 'utf8');
        const currentErrors = log.match(/\[PalControlBridge\][^\n]*(?:error|fatal|LUA_ERRRUN)[^\n]*/gi) ?? [];
        if (currentErrors.length) warn('UE4SS log', `${currentErrors.length} PalControlBridge error/fatal line(s); inspect UE4SS.log`);
        else if (log.includes('[PalControlBridge] READY')) pass('UE4SS log', 'PalControlBridge READY marker found');
        else warn('UE4SS log', 'PalControlBridge READY marker not found');
        if (log.includes('[PalControlMapBridge]')) warn('Legacy PalControlMapBridge', 'old bridge still appears in UE4SS.log; disable/remove it');
      } catch (error) { warn('UE4SS log', error.message); }
    } else skip('PalControlBridge', 'UE4SS_BRIDGE_ENABLED=false');

    if (config.remoteFiles.savePath) {
      try {
        const saveDir = path.join(root, 'save');
        await ftp.downloadTree(config.remoteFiles.savePath, saveDir);
        const entries = await fs.readdir(saveDir);
        if (entries.includes('Level.sav') && entries.includes('Players')) pass('Remote save', config.remoteFiles.savePath);
        else fail('Remote save', 'Level.sav or Players missing');
      } catch (error) { fail('Remote save', error.message); }
    } else skip('Remote save', 'PALWORLD_REMOTE_SAVE_PATH is blank');
  } catch (error) { fail('FTP connection', error.message); }
}

const localSave = path.join(root, 'save');
const reader = new SaveReaderService({ enabled: config.saveReader.enabled, bin: config.saveReader.bin, savesPath: localSave, timeoutMs: config.saveReader.timeoutMs });
if (!config.saveReader.enabled) skip('save-reader', 'SAVE_READER_ENABLED=false');
else if (!fsSync.existsSync(localSave)) skip('save-reader', 'remote save cache unavailable');
else {
  const probe = await reader.probe();
  if (!probe.ready) fail('save-reader', probe.reason);
  else {
    pass('save-reader', probe.version);
    for (const kind of ['roster', 'guilds', 'world']) {
      try { const result = await reader.resolve(kind); pass(`save-reader ${kind}`, JSON.stringify(result).slice(0, 180)); }
      catch (error) { fail(`save-reader ${kind}`, error.message); }
    }
  }
}

console.log('\nFull doctor complete. This command is read-only: it does not write a bridge command or mutate the game server.');
