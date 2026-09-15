import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const missingRemote = error => /550|not found|does not exist|no such file/i.test(String(error?.message ?? error));
const badJson = error => /Unexpected end of JSON|JSON|position \d+/i.test(String(error?.message ?? ''));

/**
 * File-based UE4SS bridge client.
 *
 * The server-side Lua mod writes heartbeat/player/world/event snapshots and
 * accepts one serialized command at a time. PalControl transfers the files by
 * FTP, which keeps the game server side completely outbound-network free.
 */
export class Ue4ssBridge extends EventEmitter {
  constructor({
    remoteStore,
    remoteDir = '',
    cacheDir = './data/remote-cache/ue4ss-bridge',
    poller = null,
    intervalMs = 3000,
    worldIntervalMs = 15000,
    commandTimeoutMs = 12000,
    spawnEnabled = false,
    logger = console
  } = {}) {
    super();
    this.remoteStore = remoteStore;
    this.remoteDir = String(remoteDir || '').replace(/\/$/, '');
    this.cacheDir = path.resolve(cacheDir);
    this.poller = poller;
    this.intervalMs = Math.max(1000, Number(intervalMs) || 3000);
    this.worldIntervalMs = Math.max(5000, Number(worldIntervalMs) || 15000);
    this.commandTimeoutMs = Math.max(3000, Number(commandTimeoutMs) || 12000);
    this.spawnEnabled = spawnEnabled === true;
    this.logger = logger;
    this.timer = null;
    this.worldTimer = null;
    this.running = false;
    this.worldRunning = false;
    this.eventsOffset = null;
    this.commandChain = Promise.resolve();
    this.lastActors = [];
    this.lastWorldActors = [];
    this.lastHeartbeat = null;
    this.lastState = null;
    this.lastError = '';
  }

  get enabled() {
    return Boolean(
      this.remoteDir &&
      this.remoteStore?.enabled &&
      typeof this.remoteStore.downloadFile === 'function' &&
      typeof this.remoteStore.uploadFile === 'function'
    );
  }

  remote(name) { return `${this.remoteDir}/${name}`; }
  local(name) { return path.join(this.cacheDir, name); }

  async downloadFileAtomic(name, localPath = this.local(name)) {
    const tempPath = `${localPath}.download-${process.pid}-${Date.now()}-${randomUUID()}.tmp`;
    try {
      await this.remoteStore.downloadFile(this.remote(name), tempPath);
      const content = await fs.readFile(tempPath);
      if (!content.length) throw new Error(`Empty remote bridge file: ${name}`);
      await fs.rename(tempPath, localPath);
      return content;
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  start() {
    if (!this.enabled || this.timer) return;
    fs.mkdir(this.cacheDir, { recursive: true }).catch(() => {});
    this.tick();
    this.worldTick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.worldTimer = setInterval(() => this.worldTick(), this.worldIntervalMs);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.worldTimer);
    this.timer = null;
    this.worldTimer = null;
  }

  async tick() {
    if (this.running || !this.enabled) return;
    this.running = true;
    try {
      await this.pollHeartbeat();
      await this.pollState();
      await this.pollActors();
      await this.pollEvents();
      this.lastError = '';
      this.emit('tick', { ok: true, heartbeat: this.lastHeartbeat, state: this.lastState });
    } catch (error) {
      this.noteError(error);
      this.emit('tick', { ok: false, error: error.message, heartbeat: this.lastHeartbeat, state: this.lastState });
    } finally {
      this.running = false;
    }
  }

  async worldTick() {
    if (this.worldRunning || !this.enabled) return;
    this.worldRunning = true;
    try {
      await this.pollWorld();
    } catch (error) {
      // world.json is deliberately best-effort. Missing on first boot is fine.
      if (!missingRemote(error)) this.noteError(error, '[ue4ss-world]');
    } finally {
      this.worldRunning = false;
    }
  }

  noteError(error, prefix = '[ue4ss-bridge]') {
    const message = String(error?.message ?? error);
    if (message !== this.lastError) this.logger.warn?.(prefix, message);
    this.lastError = message;
  }

  async downloadJson(name, { optional = false } = {}) {
    const local = this.local(name);
    try {
      const content = await this.downloadFileAtomic(name, local);
      return JSON.parse(content.toString('utf8'));
    } catch (error) {
      if (optional && missingRemote(error)) return null;
      throw error;
    }
  }

  async pollHeartbeat() {
    const doc = await this.downloadJson('heartbeat.json', { optional: true });
    if (doc) this.lastHeartbeat = doc;
  }

  async pollState() {
    const doc = await this.downloadJson('state.json', { optional: true });
    if (doc) this.lastState = doc;
  }

  livePlayerByName(name) {
    const q = String(name ?? '').trim().toLowerCase();
    if (!q || !this.poller) return null;
    const players = this.poller.snapshot()?.players ?? [];
    return players.find(p => String(p?.name ?? '').trim().toLowerCase() === q) ?? null;
  }

  normalizeActors(actors) {
    if (!Array.isArray(actors)) return [];
    return actors.map(raw => {
      const a = {
        type: String(raw?.type ?? raw?.Type ?? 'Character'),
        unitType: String(raw?.unitType ?? raw?.UnitType ?? 'Unknown'),
        nickName: raw?.nickName ?? raw?.NickName ?? null,
        trainerNickName: raw?.trainerNickName ?? raw?.TrainerNickName ?? null,
        userId: raw?.userId ?? raw?.userid ?? raw?.UserId ?? null,
        playerId: raw?.playerId ?? raw?.PlayerId ?? null,
        instanceId: raw?.instanceId ?? raw?.InstanceId ?? null,
        level: Number.isFinite(Number(raw?.level ?? raw?.Level)) ? Number(raw?.level ?? raw?.Level) : null,
        guildId: raw?.guildId ?? raw?.GuildID ?? null,
        guildName: raw?.guildName ?? raw?.GuildName ?? null,
        class: raw?.class ?? raw?.Class ?? null,
        fullName: raw?.fullName ?? raw?.FullName ?? null,
        controller: raw?.controller ?? raw?.Controller ?? null,
        range: Number.isFinite(Number(raw?.range ?? raw?.Range)) ? Number(raw?.range ?? raw?.Range) : null,
        x: Number(raw?.x ?? raw?.LocationX),
        y: Number(raw?.y ?? raw?.LocationY),
        z: Number(raw?.z ?? raw?.LocationZ),
        isActive: raw?.isActive ?? raw?.IsActive ?? true
      };
      if (a.unitType.toLowerCase() === 'player' && a.nickName) {
        const live = this.livePlayerByName(a.nickName);
        if (live) {
          a.bridgeUserId = a.userId;
          a.userId = live.userId ?? a.userId;
          a.playerId = live.playerId ?? a.playerId;
          a.level = Number.isFinite(Number(live.level)) ? Number(live.level) : a.level;
        }
      }
      return a;
    }).filter(a => Number.isFinite(a.x) && Number.isFinite(a.y));
  }

  ingestCombined() {
    if (!this.poller) return;
    this.poller.ingestExternalActors([...this.lastActors, ...this.lastWorldActors]);
  }

  async pollActors() {
    const doc = await this.downloadJson('actors.json', { optional: true });
    if (!doc) return;
    this.lastActors = this.normalizeActors(doc?.actors ?? doc?.players ?? []);
    this.ingestCombined();
  }

  async pollWorld() {
    const doc = await this.downloadJson('world.json', { optional: true });
    if (!doc) return;
    this.lastWorldActors = this.normalizeActors(doc?.actors ?? []);
    this.ingestCombined();
  }

  async pollEvents() {
    const local = this.local('events.jsonl');
    try {
      await this.remoteStore.downloadFile(this.remote('events.jsonl'), local);
    } catch (error) {
      if (missingRemote(error)) return;
      throw error;
    }
    const buf = await fs.readFile(local);
    if (this.eventsOffset == null) {
      // Bootstrap from the recent tail instead of blindly jumping to EOF. A bridge
      // may create events.jsonl only after the first player joins; jumping to EOF
      // can otherwise discard the first !kit/!link command before our first FTP poll.
      const tailStart = Math.max(0, buf.length - 128 * 1024);
      const text = buf.subarray(tailStart).toString('utf8');
      const cutoff = Date.now() - 120_000;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          const ts = Date.parse(event?.timestamp ?? '');
          if (Number.isFinite(ts) && ts >= cutoff) {
            this.emit('event', event);
            this.emit(String(event.type || 'unknown'), event);
          }
        } catch (error) {
          this.logger.warn?.('[ue4ss-events]', `Bad bootstrap JSONL event: ${error.message}`);
        }
      }
      this.eventsOffset = buf.length;
      return;
    }
    if (buf.length < this.eventsOffset) this.eventsOffset = 0; // rotation/truncation
    if (buf.length === this.eventsOffset) return;

    const chunk = buf.subarray(this.eventsOffset);
    const lastNewline = chunk.lastIndexOf(0x0A);
    if (lastNewline < 0) return; // writer may still be appending the final JSON line
    const complete = chunk.subarray(0, lastNewline + 1);
    this.eventsOffset += lastNewline + 1;

    for (const line of complete.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        this.emit('event', event);
        this.emit(String(event.type || 'unknown'), event);
      } catch (error) {
        this.logger.warn?.('[ue4ss-events]', `Bad JSONL event: ${error.message}`);
      }
    }
  }

  async probe() {
    if (!this.enabled) return { ready: false, reason: 'UE4SS bridge is not configured', transport: null };
    try {
      const hb = await this.downloadJson('heartbeat.json');
      this.lastHeartbeat = hb;
      const ts = Date.parse(hb?.timestamp ?? '');
      const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : Infinity;
      if (!hb?.loaded) return { ready: false, reason: 'heartbeat says loaded=false', transport: 'ue4ss-ftp' };
      if (ageMs > 30_000) return { ready: false, reason: `stale heartbeat (${Math.round(ageMs / 1000)}s old)`, transport: 'ue4ss-ftp', version: hb?.version };
      return {
        ready: true,
        transport: 'ue4ss-ftp',
        version: hb?.version ?? 'unknown',
        ageMs,
        features: hb?.features ?? {},
        players: this.lastActors.filter(a => a.unitType.toLowerCase() === 'player').length,
        worldActors: this.lastWorldActors.length,
        state: this.lastState
      };
    } catch (error) {
      return { ready: false, reason: error.message, transport: 'ue4ss-ftp' };
    }
  }

  async uploadCommandAtomic(localCommand, remoteCommand) {
    if (typeof this.remoteStore.uploadFileAtomic === 'function') {
      return this.remoteStore.uploadFileAtomic(localCommand, remoteCommand);
    }
    return this.remoteStore.uploadFile(localCommand, remoteCommand);
  }

  async send(action, params = {}, timeoutMs = this.commandTimeoutMs) {
    const task = async () => {
      if (!this.enabled) throw new Error('UE4SS bridge is not configured.');
      const id = randomUUID();
      const localCommand = this.local(`command-${id}.json`);
      const localResponse = this.local(`response-${id}.json`);
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(localCommand, JSON.stringify({ id, action, ...params }), 'utf8');
      await this.uploadCommandAtomic(localCommand, this.remote('command.json'));

      const deadline = Date.now() + timeoutMs;
      let lastDownloadError = null;
      while (Date.now() < deadline) {
        await sleep(500);
        try {
          const content = await this.downloadFileAtomic('response.json', localResponse);
          const response = JSON.parse(content.toString('utf8'));
          if (response?.id !== id) continue;
          if (!response.success) throw new Error(response.message || `${action} failed`);
          return response;
        } catch (error) {
          if (missingRemote(error) || badJson(error)) {
            lastDownloadError = error;
            continue;
          }
          throw error;
        }
      }
      throw new Error(`UE4SS bridge command timed out after ${timeoutMs}ms${lastDownloadError ? `: ${lastDownloadError.message}` : ''}`);
    };

    // One shared command.json means commands must be serialized end-to-end.
    const pending = this.commandChain.then(task, task);
    this.commandChain = pending.catch(() => {});
    return pending;
  }

  ping() { return this.send('ping'); }
  listPlayers() { return this.send('list_players'); }
  getPosition({ playerName = '', userId = '' } = {}) { return this.send('get_position', { playerName, userId }); }
  teleport({ playerName = '', userId = '', x, y, z } = {}) { return this.send('teleport', { playerName, userId, x, y, z }); }
  killPlayer({ playerName = '', userId = '' } = {}) { return this.send('kill_player', { playerName, userId }); }
  setTime(hour) { return this.send('set_time', { hour: Number(hour) }); }

  async giveItems({ playerName = '', userId = '', items = [] } = {}) {
    const normalized = items.map(item => ({
      itemId: String(item?.ItemID ?? item?.itemId ?? ''),
      quantity: Number(item?.Count ?? item?.quantity ?? 0)
    }));
    const response = await this.send('give_items', { playerName, userId, items: normalized });
    return { transport: 'ue4ss-ftp', response };
  }

  async givePals({ playerName = '', userId = '', pals = [] } = {}) {
    if (!this.spawnEnabled) {
      throw new Error('Pal spawn is disabled because the live RequestSpawnMonsterForPlayer path can block the UE4SS bridge; kits/items remain available.');
    }
    const results = [];
    for (const pal of pals) {
      results.push(await this.send('spawn_pal', {
        playerName,
        userId,
        palId: String(pal?.PalID ?? pal?.palId ?? ''),
        level: Number(pal?.Level ?? pal?.level ?? 1)
      }));
    }
    return {
      transport: 'ue4ss-ftp',
      status: 'UNVERIFIED',
      message: 'Pal spawn request accepted; actual actor spawn was not verified.'
        + ' Purchase settlement is blocked until live spawn verification exists.',
      results
    };
  }

  personalMessage({ playerName = '', userId = '', message = '' } = {}) {
    return this.send('personal_message', { playerName, userId, message: String(message) });
  }

  announce(message) { return this.send('announce', { message: String(message) }); }
}
