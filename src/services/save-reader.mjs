import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export class SaveReaderService {
  constructor({ enabled = false, bin = 'palworld-save-reader', savesPath = '', timeoutMs = 30_000, beforeRead = null, logger = console, execFileFn = execFileAsync } = {}) {
    this.enabled = Boolean(enabled && savesPath);
    this.bin = bin; this.savesPath = savesPath; this.timeoutMs = timeoutMs; this.beforeRead = beforeRead; this.logger = logger;
    this.version = null; this.lastError = null; this.lastSyncAt = 0; this.execFileFn = execFileFn;
  }
  async prepare() {
    if (!this.enabled) return;
    if (this.beforeRead) { await this.beforeRead(); this.lastSyncAt = Date.now(); }
  }
  async probe() {
    if (!this.enabled) return { enabled:false, ready:false, reason:'disabled' };
    try {
      await this.prepare();
      if (!fs.existsSync(this.savesPath)) return { enabled:true, ready:false, reason:`save path not found: ${this.savesPath}` };
      const { stdout } = await this.execFileFn(this.bin, ['--version'], { timeout: Math.min(this.timeoutMs, 5000), windowsHide:true });
      this.version = String(stdout || '').trim() || 'unknown'; this.lastError = null;
      return { enabled:true, ready:true, version:this.version };
    } catch (err) { this.lastError = err.message; return { enabled:true, ready:false, reason:err.message }; }
  }
  async resolve(kind, id = '') {
    if (!this.enabled) throw new Error('Save reader is disabled. Configure SAVE_READER_ENABLED and a save source.');
    await this.prepare();
    const args = ['--resolve', kind]; if (id) args.push('--id', id); args.push('--saves', this.savesPath);
    try {
      const { stdout } = await this.execFileFn(this.bin, args, { timeout:this.timeoutMs, maxBuffer:128*1024*1024, windowsHide:true });
      const doc = JSON.parse(stdout);
      if (!doc || doc.kind !== kind || !Number.isInteger(doc.resolveVersion)) throw new Error(`Unexpected save-reader envelope for ${kind}`);
      this.lastError = null; return doc;
    } catch (err) {
      this.lastError = [err.message, err.stderr].filter(Boolean).join(' | ').slice(0,2000);
      throw new Error(`save-reader ${kind} failed: ${this.lastError}`);
    }
  }
  roster(){ return this.resolve('roster'); }
  players(){ return this.resolve('players'); }
  player(id){ return this.resolve('player',id); }
  guilds(){ return this.resolve('guilds'); }
  guild(id){ return this.resolve('guild',id); }
  world(){ return this.resolve('world'); }
}
