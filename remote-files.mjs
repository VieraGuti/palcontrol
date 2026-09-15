import fs from 'node:fs/promises';
import path from 'node:path';

export class FtpFileStore {
  constructor({ host, port = 21, user, password, secure = false, logger = console } = {}) {
    this.host = host; this.port = port; this.user = user; this.password = password; this.secure = secure; this.logger = logger;
    this.type = 'ftp';
  }
  get enabled() { return Boolean(this.host && this.user && this.password); }
  async withClient(fn) {
    if (!this.enabled) throw new Error('FTP is not configured.');
    const { Client } = await import('basic-ftp');
    const client = new Client(30_000);
    client.ftp.verbose = false;
    try {
      await client.access({ host: this.host, port: this.port, user: this.user, password: this.password, secure: this.secure });
      return await fn(client);
    } finally { client.close(); }
  }
  async list(remotePath) {
    return this.withClient(client => client.list(remotePath));
  }
  async downloadTree(remoteDir, localDir) {
    const tempDir = `${localDir}.sync-${process.pid}-${Date.now()}`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    try {
      await this.withClient(client => client.downloadToDir(tempDir, remoteDir));
      await fs.rm(localDir, { recursive: true, force: true });
      await fs.rename(tempDir, localDir);
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { localDir, remoteDir };
  }
  async downloadFile(remotePath, localPath) {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await this.withClient(client => client.downloadTo(localPath, remotePath));
    return { localPath, remotePath };
  }
  async uploadFile(localPath, remotePath) {
    await this.withClient(async client => {
      const normalized = String(remotePath).replace(/\\/g, '/');
      const slash = normalized.lastIndexOf('/');
      if (slash > 0) await client.ensureDir(normalized.slice(0, slash));
      await client.uploadFrom(localPath, normalized);
    });
    return { localPath, remotePath };
  }
  async uploadFileAtomic(localPath, remotePath) {
    const normalized = String(remotePath).replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const dir = slash > 0 ? normalized.slice(0, slash) : '';
    const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const temp = `${dir ? `${dir}/` : ''}.${name}.upload-${process.pid}-${Date.now()}.tmp`;
    await this.withClient(async client => {
      if (dir) await client.ensureDir(dir);
      await client.uploadFrom(localPath, temp);
      try { await client.remove(normalized, true); } catch {}
      await client.rename(temp, normalized);
    });
    return { localPath, remotePath };
  }
  async removeFile(remotePath, ignoreMissing = true) {
    await this.withClient(async client => {
      try { await client.remove(remotePath, ignoreMissing); } catch (error) { if (!ignoreMissing) throw error; }
    });
    return { remotePath };
  }
  async uploadTree(localDir, remoteDir) {
    await this.withClient(async client => {
      await client.ensureDir(remoteDir);
      await client.uploadFromDir(localDir, remoteDir);
    });
    return { localDir, remoteDir };
  }
}

export class SaveSource {
  constructor({ localPath = '', remoteStore = null, remoteSavePath = '', remoteLogPath = '', cacheDir, logger = console } = {}) {
    this.directLocalPath = localPath;
    this.remoteStore = remoteStore;
    this.remoteSavePath = remoteSavePath;
    this.remoteLogPath = remoteLogPath;
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.saveCache = path.join(cacheDir, 'save');
    this.logCache = path.join(cacheDir, 'logs');
    this.syncPromise = null;
    this.logSyncPromise = null;
  }
  get remote() { return Boolean(this.remoteStore && this.remoteSavePath); }
  get enabled() { return Boolean(this.directLocalPath || this.remote); }
  get localSavePath() { return this.directLocalPath || this.saveCache; }
  get localLogPath() { return this.remoteStore && this.remoteLogPath ? this.logCache : ''; }
  async syncSaves() {
    if (this.directLocalPath) { await fs.access(this.directLocalPath); return { mode: 'local', path: this.directLocalPath }; }
    if (!this.remote) throw new Error('No local or remote Palworld save source is configured.');
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = (async () => {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const result = await this.remoteStore.downloadTree(this.remoteSavePath, this.saveCache);
      return { mode: 'remote', path: this.saveCache, ...result };
    })();
    try { return await this.syncPromise; } finally { this.syncPromise = null; }
  }
  async syncLogs() {
    if (!this.remoteStore || !this.remoteLogPath) return null;
    if (this.logSyncPromise) return this.logSyncPromise;
    this.logSyncPromise = (async () => {
      await fs.mkdir(this.logCache, { recursive: true });
      if (typeof this.remoteStore.list !== 'function' || typeof this.remoteStore.downloadFile !== 'function') {
        return this.remoteStore.downloadTree(this.remoteLogPath, this.logCache);
      }
      const entries = await this.remoteStore.list(this.remoteLogPath);
      const files = entries
        .filter((entry) => entry.type !== 2 && /\.(log|txt)$/i.test(entry.name))
        .sort((a, b) => (b.modifiedAt?.getTime?.() ?? 0) - (a.modifiedAt?.getTime?.() ?? 0) || (b.size ?? 0) - (a.size ?? 0));
      const latest = files[0];
      if (!latest) return { mode: 'remote-log', path: this.logCache, file: null };
      const remoteFile = `${this.remoteLogPath.replace(/\/$/, '')}/${latest.name}`;
      const localFile = path.join(this.logCache, latest.name);
      await this.remoteStore.downloadFile(remoteFile, localFile);
      return { mode: 'remote-log', path: this.logCache, file: latest.name };
    })();
    try { return await this.logSyncPromise; } finally { this.logSyncPromise = null; }
  }
  async restoreFrom(localDir) {
    if (this.directLocalPath) {
      await fs.rm(this.directLocalPath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(this.directLocalPath), { recursive: true });
      await fs.cp(localDir, this.directLocalPath, { recursive: true, preserveTimestamps: true });
      return { mode: 'local', target: this.directLocalPath };
    }
    if (!this.remote) throw new Error('Remote save target is not configured.');
    return this.remoteStore.uploadTree(localDir, this.remoteSavePath);
  }
}
