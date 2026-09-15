import fs from 'node:fs/promises';
import path from 'node:path';

export class NitradoClient {
  constructor({ token, serviceId, baseUrl = 'https://api.nitrado.net', fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    this.token = token;
    this.serviceId = String(serviceId || '');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.type = 'nitrado';
  }
  get enabled() { return Boolean(this.token && this.serviceId); }
  capabilities() { return { restart: this.enabled, stop: this.enabled, start: false, remoteFiles: this.enabled }; }
  async request(method, endpoint, { query, form, body, headers = {} } = {}) {
    if (!this.enabled) throw new Error('Nitrado is not configured. Set NITRADO_TOKEN and NITRADO_SERVICE_ID.');
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let payload = body;
      const h = { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...headers };
      if (form) { payload = new URLSearchParams(form); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
      const res = await this.fetch(url, { method, headers: h, body: payload, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`Nitrado ${method} ${url.pathname} -> ${res.status}: ${text.slice(0, 800)}`);
      if (!text) return {};
      try { return JSON.parse(text); } catch { return { raw: text }; }
    } finally { clearTimeout(timer); }
  }
  basePath(suffix = '') { return `/services/${this.serviceId}/gameservers${suffix}`; }
  async status() {
    const doc = await this.request('GET', this.basePath());
    return { provider: this.type, capabilities: this.capabilities(), gameserver: doc?.data?.gameserver ?? null };
  }
  async restart(message = 'Restart requested by PalControl') {
    const doc = await this.request('POST', this.basePath('/restart'), { query: { message, restart_message: message } });
    return { ok: true, action: 'restart', response: doc };
  }
  async stop(message = 'Stop requested by PalControl') {
    const doc = await this.request('POST', this.basePath('/stop'), { query: { message } });
    return { ok: true, action: 'stop', response: doc };
  }
  async listFiles(dir) {
    const doc = await this.request('GET', this.basePath('/file_server/list'), { query: { dir } });
    return doc?.data?.entries ?? [];
  }
  async downloadToken(file) {
    const doc = await this.request('GET', this.basePath('/file_server/download'), { query: { file } });
    const token = doc?.data?.token;
    if (!token?.url) throw new Error(`Nitrado did not return a download token for ${file}`);
    return token;
  }
  async downloadFile(remoteFile, localFile) {
    const token = await this.downloadToken(remoteFile);
    const url = new URL(token.url);
    if (token.token && !url.searchParams.has('token')) url.searchParams.set('token', token.token);
    const res = await this.fetch(url, { headers: token.token ? { token: token.token } : {} });
    if (!res.ok) throw new Error(`Nitrado download ${remoteFile} -> ${res.status}`);
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    const data = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(localFile, data);
    return { path: localFile, bytes: data.length };
  }
  async uploadToken(remoteDir, fileName) {
    const doc = await this.request('POST', this.basePath('/file_server/upload'), { form: { path: remoteDir, file: fileName } });
    const token = doc?.data?.token;
    if (!token?.url || !token?.token) throw new Error(`Nitrado did not return an upload token for ${fileName}`);
    return token;
  }
  async uploadFile(localFile, remoteFile) {
    const remoteDir = remoteFile.replace(/\\/g, '/').replace(/\/[^/]+$/, '') || '/';
    const fileName = path.posix.basename(remoteFile.replace(/\\/g, '/'));
    const token = await this.uploadToken(remoteDir, fileName);
    const url = new URL(token.url);
    if (!url.searchParams.has('token')) url.searchParams.set('token', token.token);
    const data = await fs.readFile(localFile);
    const res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/binary', token: token.token }, body: data });
    const text = await res.text();
    if (!res.ok) throw new Error(`Nitrado upload ${remoteFile} -> ${res.status}: ${text.slice(0, 500)}`);
    return { ok: true, bytes: data.length };
  }
  async downloadTree(remoteDir, localDir) {
    await fs.rm(localDir, { recursive: true, force: true });
    await fs.mkdir(localDir, { recursive: true });
    let files = 0, bytes = 0;
    const walk = async (rdir, ldir) => {
      const entries = await this.listFiles(rdir);
      for (const entry of entries) {
        const name = entry.name || path.posix.basename(entry.path || '');
        if (!name || name === '.' || name === '..') continue;
        const remote = entry.path || `${rdir.replace(/\/$/, '')}/${name}`;
        const local = path.join(ldir, name);
        if (String(entry.type).toLowerCase() === 'dir' || String(entry.type).toLowerCase() === 'directory') {
          await fs.mkdir(local, { recursive: true });
          await walk(remote, local);
        } else {
          const out = await this.downloadFile(remote, local);
          files++; bytes += out.bytes || 0;
        }
      }
    };
    await walk(remoteDir, localDir);
    return { files, bytes, localDir, remoteDir };
  }
  async uploadTree(localDir, remoteDir) {
    let files = 0, bytes = 0;
    const walk = async (ldir, rdir) => {
      for (const entry of await fs.readdir(ldir, { withFileTypes: true })) {
        const local = path.join(ldir, entry.name);
        const remote = `${rdir.replace(/\/$/, '')}/${entry.name}`;
        if (entry.isDirectory()) await walk(local, remote);
        else { const st = await fs.stat(local); await this.uploadFile(local, remote); files++; bytes += st.size; }
      }
    };
    await walk(localDir, remoteDir);
    return { files, bytes, localDir, remoteDir };
  }
}
