import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ue4ssBridge } from '../src/services/ue4ss-bridge.mjs';

class FakeStore {
  constructor(files = {}) { this.enabled = true; this.files = new Map(Object.entries(files)); this.uploads = []; }
  async downloadFile(remote, local) {
    if (!this.files.has(remote)) { const e = new Error(`550 ${remote} does not exist`); throw e; }
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, this.files.get(remote));
  }
  async uploadFileAtomic(local, remote) {
    const text = await fs.readFile(local, 'utf8');
    this.uploads.push({ remote, text });
    this.files.set(remote, text);
    const cmd = JSON.parse(text);
    this.files.set('/bridge/response.json', JSON.stringify({ id: cmd.id, success: true, message: 'pong', data: { version: '1.0.0' } }));
  }
  async uploadFile(local, remote) { return this.uploadFileAtomic(local, remote); }
}

test('UE4SS bridge enriches live player actor with official REST UserId', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-ue4ss-'));
  let ingested = null;
  const poller = {
    snapshot: () => ({ players: [{ name: 'VieraGuti', userId: 'gdk_123', playerId: 'player-1', level: 42 }] }),
    ingestExternalActors: actors => { ingested = actors; }
  };
  const store = new FakeStore({
    '/bridge/actors.json': JSON.stringify({ actors: [{ unitType:'Player', nickName:'VieraGuti', userId:'DEAD-BEEF', x:1, y:2, z:3 }] })
  });
  const bridge = new Ue4ssBridge({ remoteStore: store, remoteDir:'/bridge', cacheDir:dir, poller });
  await bridge.pollActors();
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].userId, 'gdk_123');
  assert.equal(ingested[0].bridgeUserId, 'DEAD-BEEF');
  assert.equal(ingested[0].z, 3);
});

test('UE4SS bridge probe validates fresh heartbeat and command IPC uses atomic upload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-ue4ss-probe-'));
  const store = new FakeStore({
    '/bridge/heartbeat.json': JSON.stringify({ loaded:true, version:'1.0.0', timestamp:new Date().toISOString(), features:{chat:true,giveItems:true} })
  });
  const bridge = new Ue4ssBridge({ remoteStore:store, remoteDir:'/bridge', cacheDir:dir, commandTimeoutMs:3000 });
  const probe = await bridge.probe();
  assert.equal(probe.ready, true);
  assert.equal(probe.version, '1.0.0');
  const pong = await bridge.ping();
  assert.equal(pong.message, 'pong');
  assert.equal(store.uploads.length, 1);
  assert.equal(store.uploads[0].remote, '/bridge/command.json');
});

test('UE4SS event tail waits for complete JSONL lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-ue4ss-events-'));
  const store = new FakeStore({ '/bridge/events.jsonl': '' });
  const bridge = new Ue4ssBridge({ remoteStore:store, remoteDir:'/bridge', cacheDir:dir });
  const seen = [];
  bridge.on('chat', e => seen.push(e));
  await bridge.pollEvents(); // establish offset
  store.files.set('/bridge/events.jsonl', '{"type":"chat","message":"hel');
  await bridge.pollEvents();
  assert.equal(seen.length, 0);
  store.files.set('/bridge/events.jsonl', '{"type":"chat","message":"hello"}\n');
  await bridge.pollEvents();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'hello');
});


test('UE4SS event bootstrap processes recent chat commands instead of skipping the first event file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-ue4ss-bootstrap-'));
  const recent = new Date(Date.now() - 1000).toISOString();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const store = new FakeStore({
    '/bridge/events.jsonl': [
      JSON.stringify({ type:'chat', message:'old command', timestamp:old }),
      JSON.stringify({ type:'chat', message:'!kit start', playerName:'VieraGuti', timestamp:recent }),
      ''
    ].join('\n')
  });
  const bridge = new Ue4ssBridge({ remoteStore:store, remoteDir:'/bridge', cacheDir:dir });
  const seen = [];
  bridge.on('chat', e => seen.push(e));
  await bridge.pollEvents();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, '!kit start');
});


test('external bridge actors do not violate player position foreign keys before REST identity sync', async () => {
  const { PalDatabase } = await import('../src/db.mjs');
  const { ServerPoller } = await import('../src/services/poller.mjs');
  const fsSync = await import('node:fs');
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'palcontrol-fk-'));
  const db = new PalDatabase(path.join(dir, 'test.sqlite'));
  const poller = new ServerPoller({ client:{}, db });

  assert.doesNotThrow(() => poller.ingestExternalActors([
    { unitType:'Player', userId:'00000000-00000000-00000000-00000000', x:10, y:20, z:30 }
  ], 1000));
  assert.equal(db.recentPositions(0).length, 0);

  db.syncPlayers([{ userId:'gdk_123', playerId:'p1', name:'VieraGuti' }], 2000);
  poller.ingestExternalActors([{ unitType:'Player', userId:'gdk_123', x:11, y:21, z:31 }], 3000);
  const rows = db.recentPositions(0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 'gdk_123');

  db.close();
  fsSync.rmSync(dir, { recursive:true, force:true });
});
