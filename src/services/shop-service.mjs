import fs from 'node:fs';
import path from 'node:path';

export class ShopService {
  constructor({ enabled = false, catalogPath = './config/shop.json', bridge = null, palDefender, rcon = null, db, playtimeCoinsPerHour = 0, vipPlaytimeCoinsPerHour = 200, killReward = 25, logger = console } = {}) {
    this.enabled = Boolean(enabled);
    this.catalogPath = path.resolve(catalogPath);
    this.bridge = bridge;
    this.palDefender = palDefender;
    this.rcon = rcon;
    this.db = db;
    this.playtimeCoinsPerHour = Math.max(0, Number(playtimeCoinsPerHour) || 0);
    this.vipPlaytimeCoinsPerHour = Math.max(0, Number(vipPlaytimeCoinsPerHour) || 0);
    this.killReward = Math.max(0, Number(killReward) || 0);
    if (this.db?.economySetting) {
      this.playtimeCoinsPerHour = this.db.economySetting('normal_hour', this.playtimeCoinsPerHour);
      this.vipPlaytimeCoinsPerHour = this.db.economySetting('vip_hour', this.vipPlaytimeCoinsPerHour);
      this.killReward = this.db.economySetting('kill', this.killReward);
    }
    this.logger = logger;
    this.products = [];
    this.kits = [];
    this.kitDeliveriesInFlight = new Set();
    this.lastCatalogError = null;
    this.reload();
  }

  get rconReady() { return Boolean(this.rcon?.password); }
  get bridgeReady() { return Boolean(this.bridge?.enabled); }
  get deliveryReady() { return Boolean(this.enabled && (this.bridgeReady || this.palDefender?.enabled || this.rconReady)); }
  get deliveryTransport() { return this.bridgeReady ? 'ue4ss-ftp' : (this.palDefender?.enabled ? 'paldefender-rest' : (this.rconReady ? 'paldefender-rcon' : null)); }

  async probeDelivery() {
    if (!this.enabled) return { ready:false, transport:null, reason:'shop disabled' };
    const errors = [];
    if (this.bridgeReady) {
      try {
        const ping = await this.bridge.ping();
        return { ready:true, transport:'ue4ss-ftp', detail:`PalControlBridge ${ping?.data?.version ?? this.bridge.lastHeartbeat?.version ?? 'reachable'}` };
      } catch (error) {
        errors.push(`UE4SS bridge: ${error.message}`);
      }
    }
    if (this.palDefender?.enabled) {
      try {
        const version = await this.palDefender.version();
        return { ready:true, transport:'paldefender-rest', detail:String(version?.Version ?? version?.version ?? 'reachable') };
      } catch (error) {
        errors.push(`PalDefender REST: ${error.message}`);
      }
    }
    if (this.rconReady) {
      try {
        const raw = await this.rcon.exec('/version');
        const text = String(raw ?? '').trim();
        if (/unknown\s+(command|function)|not\s+found|invalid\s+command/i.test(text)) throw new Error(text || 'PalDefender /version command unavailable');
        return { ready:true, transport:'paldefender-rcon', detail:text.slice(0,160) || 'PalDefender /version accepted' };
      } catch (error) {
        errors.push(`PalDefender RCON: ${error.message}`);
      }
    }
    return { ready:false, transport:null, reason:errors.join(' | ') || 'no delivery transport configured' };
  }

  status() {
    return {
      enabled: this.enabled,
      deliveryReady: this.deliveryReady,
      deliveryTransport: this.deliveryTransport,
      catalogPath: this.catalogPath,
      products: this.products.length,
      kits: this.kits.length,
      playtimeCoinsPerHour: this.playtimeCoinsPerHour,
      vipPlaytimeCoinsPerHour: this.vipPlaytimeCoinsPerHour,
      killReward: this.killReward,
      catalogError: this.lastCatalogError
    };
  }

  reload() {
    this.lastCatalogError = null;
    if (!this.enabled) { this.products = []; return this.products; }
    try {
      if (!fs.existsSync(this.catalogPath)) throw new Error(`Shop catalog not found: ${this.catalogPath}`);
      const parsed = JSON.parse(fs.readFileSync(this.catalogPath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.products)) throw new Error('Shop catalog must be {"version":1,"products":[]}.');
      const ids = new Set();
      this.products = parsed.products.map((product) => validateProduct(product, ids));
      const kitIds = new Set();
      this.kits = (parsed.kits ?? []).map((kit) => validateKit(kit, kitIds));
      return this.products;
    } catch (err) {
      this.products = [];
      this.lastCatalogError = err.message;
      this.logger.warn?.('[shop]', err.message);
      return this.products;
    }
  }

  catalog() { return this.products.map((x) => structuredClone(x)); }
  kitsCatalog() { return this.kits.map((x) => structuredClone(x)); }
  saveCatalog({ products = this.products, kits = this.kits } = {}) {
    const payload = { version: 1, products: structuredClone(products), kits: structuredClone(kits) };
    const temp = `${this.catalogPath}.tmp-${process.pid}`;
    const previous = fs.existsSync(this.catalogPath) ? fs.readFileSync(this.catalogPath, 'utf8') : null;
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.catalogPath);
    this.reload();
    if (this.lastCatalogError) {
      const validationError = this.lastCatalogError;
      if (previous !== null) {
        const restore = `${this.catalogPath}.restore-${process.pid}`;
        fs.writeFileSync(restore, previous, 'utf8');
        fs.renameSync(restore, this.catalogPath);
      }
      this.reload();
      throw new Error(validationError);
    }
    return { products: this.catalog(), kits: this.kitsCatalog() };
  }
  upsertProduct(product) {
    const products = this.catalog();
    const index = products.findIndex((entry) => entry.id === product.id);
    if (index >= 0) products[index] = product; else products.push(product);
    return this.saveCatalog({ products, kits: this.kitsCatalog() });
  }
  removeProduct(id) {
    return this.saveCatalog({ products: this.catalog().filter((entry) => entry.id !== String(id)), kits: this.kitsCatalog() });
  }
  upsertKit(kit) {
    const kits = this.kitsCatalog();
    const index = kits.findIndex((entry) => entry.id === kit.id);
    if (index >= 0) kits[index] = kit; else kits.push(kit);
    return this.saveCatalog({ products: this.catalog(), kits });
  }
  removeKit(id) {
    return this.saveCatalog({ products: this.catalog(), kits: this.kitsCatalog().filter((entry) => entry.id !== String(id)) });
  }
  product(id) { return this.products.find((x) => x.id === String(id)) ?? null; }
  kit(id) {
    const wanted = String(id ?? '').trim().toLowerCase();
    return this.kits.find((x) => x.id.toLowerCase() === wanted || x.aliases.some((alias) => alias.toLowerCase() === wanted)) ?? null;
  }
  wallet(discordId) { return this.db.wallet(discordId); }

  credit(discordId, amount, reason = 'admin.credit', reference = '') {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) throw new Error('Credit amount must be a positive integer.');
    return this.db.adjustWallet(discordId, n, reason, reference);
  }

  debit(discordId, amount, reason = 'admin.debit', reference = '') {
    const n = Number(amount);
    if (!Number.isInteger(n) || n <= 0) throw new Error('Debit amount must be a positive integer.');
    return this.db.adjustWallet(discordId, -n, reason, reference);
  }

  async purchase(discordId, productId, actor = '') {
    if (!this.enabled) throw new Error('Shop is disabled.');
    if (!this.deliveryReady) throw new Error('Shop delivery requires PalControlBridge, PalDefender REST, or RCON.');
    const product = this.product(productId);
    if (!product) throw new Error('Product not found.');
    const link = this.db.linkForDiscord(discordId);
    if (!link) throw new Error('Link your Discord account to a Palworld character first with /link.');
    const target = link.user_id || link.player_uid || (this.bridgeReady ? link.player_name : '');
    if (!target) throw new Error('The linked character does not yet have a usable Palworld identifier.');

    const reservation = this.db.startPurchase({ discordId, productId: product.id, price: product.price, targetId: target });
    try {
      const delivery = await this.deliver(target, product, { playerName: link.player_name || '' });
      if (delivery?.status === 'UNVERIFIED') {
        throw new Error(delivery.message || `${product.name} delivery was not verified.`);
      }
      this.db.settlePurchase(reservation.purchaseId, JSON.stringify(delivery).slice(0, 4000));
      this.db.audit(actor || `discord:${discordId}`, 'shop.purchase', product.id, `purchase=${reservation.purchaseId};target=${target};price=${product.price}`);
      if (this.bridgeReady) { try { await this.bridge.personalMessage({ playerName:link.player_name || '', userId:String(target), message:`Shop delivery: ${product.name}` }); } catch {} }
      else if (this.palDefender?.enabled) { try { await this.palDefender.sendPlayerMessage(target, `Shop delivery: ${product.name}`, 'PlayerLogImportant'); } catch {} }
      return { ok: true, purchaseId: reservation.purchaseId, product, balance: reservation.balance, delivery };
    } catch (err) {
      const refund = this.db.refundPurchase(reservation.purchaseId, err.message);
      this.db.audit(actor || `discord:${discordId}`, 'shop.refund', product.id, `purchase=${reservation.purchaseId};reason=${err.message}`);
      err.refunded = true;
      err.balance = refund.balance;
      throw err;
    }
  }

  async deliver(target, product, context = {}) {
    switch (product.type) {
      case 'items': return this.giveItems(target, product.items, context);
      case 'pals': return this.givePals(target, product.pals, context);
      default: throw new Error(`Unsupported product type: ${product.type}`);
    }
  }

  async giveItems(target, items, { playerName = '' } = {}) {
    const errors = [];
    if (this.bridgeReady) {
      try {
        return await this.bridge.giveItems({ playerName, userId: String(target ?? ''), items });
      } catch (error) {
        errors.push(`UE4SS bridge: ${error.message}`);
        this.logger.warn?.('[shop-delivery] UE4SS item delivery failed; trying fallbacks:', error.message);
      }
    }
    if (this.palDefender?.enabled) {
      try {
        const result = await this.palDefender.giveItems(target, items);
        return { transport:'paldefender-rest', result };
      } catch (error) {
        errors.push(`PalDefender REST: ${error.message}`);
        if (this.rconReady) this.logger.warn?.('[shop-delivery] REST item delivery failed; trying RCON fallback:', error.message);
      }
    }
    if (this.rconReady) {
      try {
        const player = cleanToken(target, 'player identifier');
        const grants = items.map((item) => `${cleanToken(item.ItemID, 'ItemID')}:${positiveInt(item.Count, 'item count')}`);
        const raw = await this.rcon.exec(`/giveitems ${player} ${grants.join(' ')}`);
        assertRconAccepted(raw, 'giveitems');
        return { transport:'paldefender-rcon', command:'giveitems', raw };
      } catch (error) {
        errors.push(`PalDefender RCON: ${error.message}`);
      }
    }
    throw new Error(errors.join(' | ') || 'Item delivery requires PalControlBridge, PalDefender REST, or RCON.');
  }

  async givePals(target, pals, { playerName = '' } = {}) {
    const errors = [];
    if (this.bridgeReady) {
      try {
        return await this.bridge.givePals({ playerName, userId: String(target ?? ''), pals });
      } catch (error) {
        errors.push(`UE4SS bridge: ${error.message}`);
        this.logger.warn?.('[shop-delivery] UE4SS Pal delivery failed; trying fallbacks:', error.message);
      }
    }
    if (this.palDefender?.enabled) {
      try {
        const result = await this.palDefender.givePals(target, pals);
        return { transport:'paldefender-rest', result };
      } catch (error) {
        errors.push(`PalDefender REST: ${error.message}`);
        if (this.rconReady) this.logger.warn?.('[shop-delivery] REST Pal delivery failed; trying RCON fallback:', error.message);
      }
    }
    if (this.rconReady) {
      try {
        const player = cleanToken(target, 'player identifier');
        const results = [];
        for (const pal of pals) {
          const palId = cleanToken(pal.PalID, 'PalID');
          const level = positiveInt(pal.Level, 'Pal level');
          const raw = await this.rcon.exec(`/givepal ${player} ${palId} ${level}`);
          assertRconAccepted(raw, 'givepal');
          results.push(raw);
        }
        return { transport:'paldefender-rcon', command:'givepal', results };
      } catch (error) {
        errors.push(`PalDefender RCON: ${error.message}`);
      }
    }
    throw new Error(errors.join(' | ') || 'Pal delivery requires PalControlBridge, PalDefender REST, or RCON.');
  }
  async claimKit({ playerUserId, playerName, discordId, kitId, hasRole = async () => false }) {
    if (!this.enabled) throw new Error('Shop is disabled.');
    if (!this.deliveryReady) throw new Error('Kit delivery requires PalControlBridge, PalDefender REST, or RCON.');
    const kit = this.kit(kitId);
    if (!kit) {
      const available = this.kits.map((entry) => entry.id).join(', ');
      throw new Error(`Kit not found${available ? `. Available: ${available}` : ''}.`);
    }
    if (kit.role && !(await hasRole(discordId, kit.role))) throw new Error(`Kit ${kit.id} requires the Discord role ${kit.role}.`);
    const key = `${kit.id}:${playerUserId}`;
    if (this.kitDeliveriesInFlight.has(key)) throw new Error(`Kit ${kit.id} delivery is still pending. Try again later.`);
    const remainingMs = this.db.kitCooldownRemaining?.(key) ?? (this.db.kitClaimed(key) ? kit.cooldownMs : 0);
    if (remainingMs > 0) throw new Error(`Already claimed. Next claim in ${formatCooldown(remainingMs)}.`);
    this.kitDeliveriesInFlight.add(key);
    try {
      const delivery = await this.giveItems(playerUserId, kit.items, { playerName });
      if (!this.db.claimKit(key, kit.cooldownMs)) throw new Error(`Kit ${kit.id} became unavailable before cooldown could be recorded.`);
      if (this.bridgeReady) { try { await this.bridge.personalMessage({ playerName, userId:String(playerUserId ?? ''), message:`Kit delivered: ${kit.name}` }); } catch {} }
      else if (this.palDefender?.enabled) try { await this.palDefender.sendPlayerMessage(playerUserId, `Kit delivered: ${kit.name}`, 'PlayerLogImportant'); } catch {}
      return { kit, playerName, delivery };
    } finally { this.kitDeliveriesInFlight.delete(key); }
  }

  async syncPlaytimeRewards(hasRole = async () => false) {
    if (!this.enabled || this.playtimeCoinsPerHour <= 0) return [];
    const granted = [];
    for (const link of this.db.linkedAccounts()) {
      if (!link.user_id) continue;
      const player = this.db.player(link.user_id);
      if (!player) continue;
      const totalHours = Math.floor(Number(player.playtime_ms ?? 0) / 3_600_000);
      const rewarded = this.db.playtimeRewardState(link.discord_id);
      if (totalHours <= rewarded) continue;
      const units = totalHours - rewarded;
      const vip = await hasRole(link.discord_id, 'vip');
      const rate = vip ? this.vipPlaytimeCoinsPerHour : this.playtimeCoinsPerHour;
      if (rate <= 0) continue;
      const coins = units * rate;
      this.db.adjustWallet(link.discord_id, coins, 'playtime.hour', `${rewarded + 1}-${totalHours}`);
      this.db.setPlaytimeRewardState(link.discord_id, totalHours);
      granted.push({ discordId: link.discord_id, userId: link.user_id, hours: units, coins });
    }
    return granted;
  }

  setEconomySetting(key, value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error('Economy value must be a non-negative integer.');
    if (key === 'normal_hour') this.playtimeCoinsPerHour = n;
    else if (key === 'vip_hour') this.vipPlaytimeCoinsPerHour = n;
    else if (key === 'kill') this.killReward = n;
    else throw new Error('Unknown economy setting.');
    this.db.setEconomySetting(key, n);
    return this.status();
  }

  awardKill(playerUserId) {
    if (this.killReward <= 0) return null;
    const link = this.db.linkForUser(playerUserId);
    if (!link?.discord_id) return null;
    const wallet = this.db.adjustWallet(link.discord_id, this.killReward, 'kill.reward', String(playerUserId));
    return { ...wallet, discordId: link.discord_id, userId: playerUserId, coins: this.killReward };
  }
}

function formatCooldown(ms) {
  const minutes = Math.max(1, Math.ceil(Number(ms) / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function validateProduct(raw, ids) {
  if (!raw || typeof raw !== 'object') throw new Error('Each shop product must be an object.');
  const id = String(raw.id ?? '').trim();
  const name = String(raw.name ?? '').trim();
  const description = String(raw.description ?? '').trim();
  const price = Number(raw.price);
  const type = String(raw.type ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error(`Invalid shop product id: ${id || '(empty)'}`);
  if (ids.has(id)) throw new Error(`Duplicate shop product id: ${id}`);
  ids.add(id);
  if (!name || name.length > 100) throw new Error(`Invalid product name for ${id}.`);
  if (!Number.isInteger(price) || price <= 0) throw new Error(`Invalid price for ${id}.`);
  if (!['items','pals'].includes(type)) throw new Error(`Product ${id} type must be items or pals.`);
  const category = String(raw.category ?? 'General').trim() || 'General';
  const out = { id, name, description, category, price, type };
  if (type === 'items') {
    if (!Array.isArray(raw.items) || !raw.items.length) throw new Error(`Product ${id} needs items.`);
    out.items = raw.items.map((x) => ({ ItemID: String(x?.ItemID ?? '').trim(), Count: Number(x?.Count) }));
    if (out.items.some((x) => !x.ItemID || !Number.isInteger(x.Count) || x.Count <= 0)) throw new Error(`Product ${id} has invalid items.`);
  }
  if (type === 'pals') {
    if (!Array.isArray(raw.pals) || !raw.pals.length) throw new Error(`Product ${id} needs pals.`);
    out.pals = raw.pals.map((x) => ({ PalID: String(x?.PalID ?? '').trim(), Level: Number(x?.Level) }));
    if (out.pals.some((x) => !x.PalID || !Number.isInteger(x.Level) || x.Level <= 0)) throw new Error(`Product ${id} has invalid pals.`);
  }
  return out;
}

function validateKit(raw, ids) {
  if (!raw || typeof raw !== 'object') throw new Error('Each shop kit must be an object.');
  const id = String(raw.id ?? '').trim();
  const name = String(raw.name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate kit id: ${id || '(empty)'}`);
  ids.add(id);
  const cooldownMs = Number(raw.cooldownMs);
  if (!name || !Number.isInteger(cooldownMs) || cooldownMs < 0) throw new Error(`Invalid kit ${id}.`);
  const items = Array.isArray(raw.items) ? raw.items.map((x) => ({ ItemID: String(x?.ItemID ?? '').trim(), Count: Number(x?.Count) })) : [];
  if (!items.length || items.some((x) => !x.ItemID || !Number.isInteger(x.Count) || x.Count <= 0)) throw new Error(`Kit ${id} has invalid items.`);
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  if (aliases.some((alias) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(alias))) throw new Error(`Kit ${id} has an invalid alias.`);
  return { id, aliases, name, description: String(raw.description ?? '').trim(), role: raw.role ? String(raw.role).trim() : '', cooldownMs, items };
}

function cleanToken(value, label) {
  const token = String(value ?? '').trim();
  if (!token || !/^[A-Za-z0-9_.:-]+$/.test(token) || token.length > 160) throw new Error(`Invalid ${label}.`);
  return token;
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${label}.`);
  return n;
}


function assertRconAccepted(raw, command) {
  const text = String(raw ?? '').trim();
  if (/unknown\s+(?:command|function)|command\s+not\s+found|invalid\s+command|not\s+recognized|no\s+such\s+command/i.test(text)) {
    throw new Error(`PalDefender RCON command /${command} is unavailable on this server: ${text || 'unknown command'}`);
  }
  if (/error|failed|invalid\s+(?:item|player|user)/i.test(text) && !/no\s+error/i.test(text)) {
    throw new Error(`PalDefender RCON /${command} rejected the request: ${text}`);
  }
}
