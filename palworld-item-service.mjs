import fs from 'node:fs';
import path from 'node:path';

export class PalworldItemService {
  constructor({
    bridge = null,
    db = null,
    itemCatalog = {},
    logger = console,
    clock = () => Date.now(),
    kits = []
  } = {}) {
    this.bridge = bridge;
    this.db = db;
    this.itemCatalog = Object.freeze({
      ...itemCatalog,
      PalSphere: { id: 'PalSphere', name: 'Pal Sphere' },
      Wood: { id: 'Wood', name: 'Wood' },
      Stone: { id: 'Stone', name: 'Stone' },
      Berries: { id: 'Berries', name: 'Berries' }
    });
    this.logger = logger;
    this.clock = clock;
    this.kits = Array.isArray(kits) && kits.length ? kits : [{
      id: 'starter',
      name: 'Starter Kit',
      aliases: ['starter'],
      cooldownMs: 24 * 60 * 60 * 1000,
      items: [
        { ItemID: 'PalSphere', Count: 10 },
        { ItemID: 'Wood', Count: 100 },
        { ItemID: 'Stone', Count: 100 },
        { ItemID: 'Berries', Count: 20 }
      ]
    }];
    this.deliveryHistory = [];
  }

  validateItemId(itemId) {
    const id = String(itemId ?? '').trim();
    if (!id) return false;
    return Boolean(this.itemCatalog[id]);
  }

  normalizeItem(item) {
    const itemId = String(item?.itemId ?? item?.ItemID ?? '').trim();
    const quantity = Number(item?.quantity ?? item?.Count ?? 0);
    if (!this.validateItemId(itemId)) throw new Error(`Unknown item ID: ${itemId || '(empty)'}`);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`Invalid quantity for ${itemId}: ${quantity}`);
    return { itemId, quantity };
  }

  buildKit(id) {
    const kitId = String(id ?? '').trim().toLowerCase();
    const found = this.kits.find((kit) => String(kit.id ?? '').trim().toLowerCase() === kitId || (Array.isArray(kit.aliases) && kit.aliases.some((alias) => String(alias ?? '').trim().toLowerCase() === kitId)));
    if (!found) throw new Error(`Kit not found: ${id}`);
    return found;
  }

  isOnCooldown(kitId, player) {
    const key = `${String(kitId ?? '').trim()}:${String(player ?? '').trim()}`;
    if (!this.db?.kitClaimed) return false;
    return this.db.kitClaimed(key, this.clock());
  }

  markCooldown(kitId, player) {
    const key = `${String(kitId ?? '').trim()}:${String(player ?? '').trim()}`;
    if (!this.db?.claimKit) return false;
    const cooldownMs = this.buildKit(kitId).cooldownMs ?? 0;
    return this.db.claimKit(key, cooldownMs, this.clock());
  }

  async deliverBridgeCommand({ player, itemList = [], action = 'giveItems', context = {} } = {}) {
    if (!this.bridge || !this.bridge.enabled) {
      throw new Error('Item delivery requires an active PalControlBridge transport.');
    }
    if (typeof this.bridge.giveItems !== 'function') {
      throw new Error('Bridge does not expose giveItems().');
    }

    const normalized = Array.isArray(itemList) ? itemList.map((item) => this.normalizeItem(item)) : [];
    if (!normalized.length) {
      throw new Error('No valid items to deliver.');
    }

    const response = await this.bridge.giveItems({ playerName: context.playerName ?? player, userId: String(player ?? ''), items: normalized });
    if (!response || response.ok === false) {
      const message = response?.message || response?.error || 'Bridge reported failure.';
      throw new Error(`Delivery failed: ${message}`);
    }
    return response;
  }

  async giveItem(player, itemId, quantity) {
    const playerName = String(player ?? '').trim();
    if (!playerName) throw new Error('Player is required.');
    const normalized = this.normalizeItem({ itemId, quantity });
    const result = await this.deliverBridgeCommand({ player: playerName, itemList: [normalized], action: 'giveItems', context: { playerName } });
    return { ok: true, player: playerName, item: normalized, result };
  }

  async giveItems(player, items = []) {
    const playerName = String(player ?? '').trim();
    if (!playerName) throw new Error('Player is required.');
    if (!Array.isArray(items) || !items.length) throw new Error('Item list is required.');

    const normalized = items.map((item) => this.normalizeItem(item));
    const response = await this.deliverBridgeCommand({ player: playerName, itemList: normalized, action: 'giveItems', context: { playerName } });
    return { ok: true, player: playerName, items: normalized, result: response };
  }

  async giveKit(player, kitId) {
    const playerName = String(player ?? '').trim();
    if (!playerName) throw new Error('Player is required.');
    const kit = this.buildKit(kitId);
    if (this.db?.kitClaimed && this.isOnCooldown(kit.id, playerName)) {
      throw new Error(`Kit ${kit.id} is on cooldown for ${playerName}.`);
    }

    const normalized = kit.items.map((item) => this.normalizeItem({ itemId: item.ItemID, quantity: item.Count }));
    const response = await this.deliverBridgeCommand({ player: playerName, itemList: normalized, action: 'giveItems', context: { playerName } });

    if (!response || response.ok === false) {
      throw new Error(`Kit ${kit.id} failed: ${response?.message || response?.error || 'delivery failed'}`);
    }

    if (this.db?.claimKit) {
      const success = this.db.claimKit(`${kit.id}:${playerName}`, kit.cooldownMs ?? 0, this.clock());
      if (!success) throw new Error(`Cooldown could not be recorded for ${kit.id}.`);
    }

    return { ok: true, player: playerName, kit: kit.id, items: normalized, result: response };
  }
}

export function loadDefaultItemCatalog(dir = './config') {
  const preferredPath = path.resolve(dir, 'palworld-items.json');
  const legacyPath = path.resolve(dir, 'items.json');
  const catalogPath = fs.existsSync(preferredPath) ? preferredPath : legacyPath;
  if (!fs.existsSync(catalogPath)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const entries = Array.isArray(json) ? json : Array.isArray(json.items) ? json.items : [];
    return Object.fromEntries(entries.map((item) => [String(item.id ?? item.ItemID ?? '').trim(), item]));
  } catch {
    return {};
  }
}
