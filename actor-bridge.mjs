import fs from 'node:fs/promises';
import path from 'node:path';

export class ActorBridge {
  constructor({ remoteStore, remotePath = '', localPath = './data/remote-cache/actors.json', poller, intervalMs = 10_000, logger = console } = {}) {
    this.remoteStore = remoteStore; this.remotePath = remotePath; this.localPath = path.resolve(localPath);
    this.poller = poller; this.intervalMs = intervalMs; this.logger = logger; this.timer = null; this.running = false; this.lastError = '';
  }
  get enabled() { return Boolean(this.remoteStore?.enabled && this.remotePath); }
  start() { if (this.timer || !this.enabled) return; this.tick(); this.timer = setInterval(() => this.tick(), this.intervalMs); }
  stop() { clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (this.running || !this.enabled) return;
    this.running = true;
    try {
      await this.remoteStore.downloadFile(this.remotePath, this.localPath);
      const snapshot = JSON.parse(await fs.readFile(this.localPath, 'utf8'));
      if (!Array.isArray(snapshot.actors)) throw new Error('Actor snapshot has no actors array.');
      this.lastError = '';
      this.poller.ingestExternalActors(snapshot.actors);
    } catch (error) {
      if (error.message !== this.lastError) this.logger.warn?.('[actor-bridge]', error.message);
      this.lastError = error.message;
    }
    finally { this.running = false; }
  }
}