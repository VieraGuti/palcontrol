import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { ServerDiscoveryService, compareVersions } from '../src/services/server-discovery.mjs';
import { DiscordClient } from '../src/discord/client.mjs';

test('candidate discovery prefers common Palworld roots', () => {
  const service = new ServerDiscoveryService();
  assert.deepEqual(service.candidatePaths(), [
    '/Pal',
    '/palworld/Pal',
    '/Pal/Binaries/Win64',
    '/palworld/Pal/Binaries/Win64',
    '/Pal/Binaries/Win64/ue4ss',
    '/palworld/Pal/Binaries/Win64/ue4ss',
    '/Pal/Binaries/Win64/ue4ss/Mods',
    '/palworld/Pal/Binaries/Win64/ue4ss/Mods'
  ]);
});

test('mods.txt preserves third-party mods while enabling PalControlBridge', () => {
  const service = new ServerDiscoveryService();
  const original = 'OtherMod : 1\nAnotherMod : 0\n';
  const updated = service.ensureModsTxtEntry(original, 'PalControlBridge');
  assert.match(updated, /OtherMod : 1/);
  assert.match(updated, /AnotherMod : 0/);
  assert.match(updated, /PalControlBridge : 1/);
  assert.doesNotMatch(updated, /PalControlBridge\s*:\s*1\nPalControlBridge\s*:\s*1/);
});

test('bridge versions compare as semver', () => {
  assert.equal(compareVersions('1.0.3', '1.0.5'), -1);
  assert.equal(compareVersions('1.0.5', '1.0.5'), 0);
  assert.equal(compareVersions('1.0.6', '1.0.5'), 1);
  assert.equal(compareVersions('unknown', '1.0.5'), null);
});

test('newer remote bridge is protected from overwrite', async () => {
  const service = new ServerDiscoveryService({ bridgeRoot: './mods/PalControlBridge', logger: { log() {}, warn() {} } });
  let uploads = 0;
  const remoteStore = {
    enabled: true,
    async downloadFile(remotePath, localPath) {
      if (remotePath.endsWith('/heartbeat.json')) {
        await fs.writeFile(localPath, JSON.stringify({ version: '1.0.6', loaded: true }));
        return;
      }
      if (remotePath.endsWith('/main.lua')) {
        await fs.writeFile(localPath, '-- remote bridge');
        return;
      }
      throw new Error('missing');
    },
    async uploadTree() { uploads += 1; }
  };
  const result = await service.syncBridge({ remoteStore, bridgePath: '/Mods/PalControlBridge', waitMs: 0 });
  assert.equal(result.status, 'PROTECTED');
  assert.equal(uploads, 0);
});

test('server command is registered for Discord admins', () => {
  const client = new DiscordClient({ config: {}, services: {}, db: {} });
  const command = client.commands().find((c) => c.name === 'server');
  assert.ok(command);
  assert.equal(command.description, 'Palworld server control and status');
});
