export class WhitelistService {
  constructor({ rcon, enabled = false, db } = {}) {
    this.rcon = rcon;
    this.enabled = Boolean(enabled && rcon?.password);
    this.configured = Boolean(enabled);
    this.db = db;
  }

  status() {
    return {
      configured: this.configured,
      enabled: this.enabled,
      transport: this.enabled ? 'paldefender-rcon-compatibility' : null,
      note: 'PalDefender currently documents whitelist_add/remove/get as RCON-compatible commands; Pocketpair RCON is deprecated, so this module is optional.'
    };
  }

  require() {
    if (!this.configured) throw new Error('Whitelist integration is disabled.');
    if (!this.enabled) throw new Error('Whitelist integration requires PALWORLD_RCON_PASSWORD and PalDefender RCON commands.');
  }

  async list() { this.require(); return { raw: await this.rcon.exec('/whitelist_get') }; }
  async add(userId, actor = 'system') {
    this.require();
    const id = cleanId(userId);
    const raw = await this.rcon.exec(`/whitelist_add ${id}`);
    this.db?.audit(actor, 'whitelist.add', id, String(raw).slice(0, 2000));
    return { ok: true, userId: id, raw };
  }
  async remove(userId, actor = 'system') {
    this.require();
    const id = cleanId(userId);
    const raw = await this.rcon.exec(`/whitelist_remove ${id}`);
    this.db?.audit(actor, 'whitelist.remove', id, String(raw).slice(0, 2000));
    return { ok: true, userId: id, raw };
  }
}

function cleanId(value) {
  const id = String(value ?? '').trim();
  if (!id || /\s/.test(id) || id.length > 128) throw new Error('Invalid UserId.');
  return id;
}
