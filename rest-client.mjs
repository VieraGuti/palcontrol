export class PalworldRestError extends Error {
  constructor(message, { status = 0, endpoint = '', body = '' } = {}) {
    super(message);
    this.name = 'PalworldRestError';
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

export class PalworldRestClient {
  constructor({ baseUrl, username = 'admin', password, timeoutMs = 5000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '') + '/v1/api';
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(method, endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    try {
      const res = await this.fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${auth}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) throw new PalworldRestError(`Palworld REST ${method} ${endpoint} returned HTTP ${res.status}`, { status: res.status, endpoint, body: text.slice(0, 1000) });
      if (!text) return { ok: true };
      try { return JSON.parse(text); } catch { return { ok: true, text }; }
    } catch (err) {
      if (err?.name === 'AbortError') throw new PalworldRestError(`Palworld REST ${method} ${endpoint} timed out after ${this.timeoutMs}ms`, { endpoint });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  info() { return this.request('GET', '/info'); }
  players() { return this.request('GET', '/players'); }
  settings() { return this.request('GET', '/settings'); }
  metrics() { return this.request('GET', '/metrics'); }
  gameData() { return this.request('GET', '/game-data'); }
  announce(message) { return this.request('POST', '/announce', { message }); }
  kick(userid, message = 'Kicked by an administrator.') { return this.request('POST', '/kick', { userid, message }); }
  ban(userid, message = 'Banned by an administrator.') { return this.request('POST', '/ban', { userid, message }); }
  unban(userid) { return this.request('POST', '/unban', { userid }); }
  save() { return this.request('POST', '/save'); }
  shutdown(waittime = 30, message = 'Server is shutting down.') { return this.request('POST', '/shutdown', { waittime, message }); }
  stop() { return this.request('POST', '/stop'); }
}
