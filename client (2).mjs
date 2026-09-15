export class PalDefenderClient {
  constructor({ enabled = false, baseUrl = 'http://127.0.0.1:17993', token = '', timeoutMs = 8000 } = {}) {
    this.enabled = Boolean(enabled && baseUrl && token);
    this.configured = Boolean(enabled);
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    if (!this.configured) throw new Error('PalDefender REST API is disabled.');
    if (!this.token) throw new Error('PALDEFENDER_API_TOKEN is not configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); }
        catch { data = { raw: text }; }
      }
      if (!res.ok) {
        const remote = data?.Error?.Message || data?.error || data?.message || text || res.statusText;
        const err = new Error(`PalDefender ${method} ${path} -> ${res.status}: ${String(remote).slice(0, 500)}`);
        err.status = res.status;
        err.payload = data;
        throw err;
      }
      return data ?? { ok: true };
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`PalDefender request timed out after ${this.timeoutMs}ms.`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  version() { return this.request('GET', '/v1/pdapi/version'); }
  players() { return this.request('GET', '/v1/pdapi/players'); }
  player(player) { return this.request('GET', `/v1/pdapi/player/${encodeURIComponent(player)}`); }
  guilds() { return this.request('GET', '/v1/pdapi/guilds'); }
  items(player) { return this.request('GET', `/v1/pdapi/items/${encodeURIComponent(player)}`); }
  pals(player) { return this.request('GET', `/v1/pdapi/pals/${encodeURIComponent(player)}`); }
  techs(player) { return this.request('GET', `/v1/pdapi/techs/${encodeURIComponent(player)}`); }
  progression(player) { return this.request('GET', `/v1/pdapi/progression/${encodeURIComponent(player)}`); }
  banlist() { return this.request('GET', '/v1/pdapi/banlist'); }

  giveItems(player, items) {
    const normalized = items.map((item) => ({ ItemID: String(item.ItemID), Count: Number(item.Count) }));
    if (!normalized.length || normalized.some((x) => !x.ItemID || !Number.isInteger(x.Count) || x.Count <= 0)) throw new Error('Invalid PalDefender item grant.');
    return this.request('POST', `/v1/pdapi/give/items/${encodeURIComponent(player)}`, { Items: normalized });
  }

  givePals(player, pals) {
    const normalized = pals.map((pal) => ({ PalID: String(pal.PalID), Level: Number(pal.Level) }));
    if (!normalized.length || normalized.some((x) => !x.PalID || !Number.isInteger(x.Level) || x.Level <= 0)) throw new Error('Invalid PalDefender Pal grant.');
    return this.request('POST', `/v1/pdapi/give/pals/${encodeURIComponent(player)}`, { Pals: normalized });
  }

  broadcast(message) {
    if (!String(message).trim()) throw new Error('Message is required.');
    return this.request('POST', '/v1/pdapi/Broadcast', { Message: String(message).slice(0, 1000) });
  }

  sendPlayerMessage(player, message, sendType = 'PlayerChat') {
    if (!player || !String(message).trim()) throw new Error('Player and message are required.');
    return this.request('POST', '/v1/pdapi/SendPlayerMessage', {
      SendType: sendType,
      UserID: String(player),
      Message: String(message).slice(0, 1000)
    });
  }

  kick(player) { return this.request('POST', `/v1/pdapi/kick/${encodeURIComponent(player)}`, {}); }
  ban(player) { return this.request('POST', `/v1/pdapi/ban/${encodeURIComponent(player)}`, {}); }
  unban(player) { return this.request('POST', `/v1/pdapi/unban/${encodeURIComponent(player)}`, {}); }
}
