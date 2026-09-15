import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class PalDatabase {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY,
        player_id TEXT,
        name TEXT NOT NULL,
        account_name TEXT,
        level INTEGER,
        ping REAL,
        building_count INTEGER,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        online INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        left_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES players(user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, joined_at DESC);
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL,
        guild_id TEXT,
        guild_name TEXT,
        level INTEGER,
        FOREIGN KEY(user_id) REFERENCES players(user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_positions_ts ON positions(ts);
      CREATE INDEX IF NOT EXISTS idx_positions_user_ts ON positions(user_id, ts DESC);
      CREATE TABLE IF NOT EXISTS link_codes (
        code TEXT PRIMARY KEY,
        discord_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        discord_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        player_name TEXT,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_links (
        discord_id TEXT PRIMARY KEY,
        player_uid TEXT UNIQUE,
        user_id TEXT UNIQUE,
        player_name TEXT,
        platform TEXT,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_challenges (
        discord_id TEXT PRIMARY KEY,
        player_uid TEXT NOT NULL,
        player_name TEXT,
        answer TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS server_samples (
        ts INTEGER PRIMARY KEY,
        server_fps INTEGER,
        frame_time REAL,
        current_players INTEGER,
        max_players INTEGER,
        uptime INTEGER,
        base_camps INTEGER,
        days INTEGER
      );
      CREATE TABLE IF NOT EXISTS wallets (
        discord_id TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS economy_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        discord_id TEXT NOT NULL,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        reference TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_economy_ledger_discord ON economy_ledger(discord_id, id DESC);
      CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        discord_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        price INTEGER NOT NULL,
        target_id TEXT,
        status TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS playtime_rewards (
        discord_id TEXT PRIMARY KEY,
        rewarded_units INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kit_claims (
        claim_key TEXT PRIMARY KEY,
        claimed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS economy_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enabled INTEGER NOT NULL DEFAULT 1,
        message TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 15,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  syncPlayers(players, now = Date.now()) {
    const current = new Set(players.map(p => p.userId));
    const oldOnline = new Set(this.db.prepare('SELECT user_id FROM players WHERE online=1').all().map(r => r.user_id));
    const upsert = this.db.prepare(`INSERT INTO players(user_id,player_id,name,account_name,level,ping,building_count,first_seen,last_seen,online)
      VALUES(?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(user_id) DO UPDATE SET player_id=excluded.player_id,name=excluded.name,account_name=excluded.account_name,level=excluded.level,ping=excluded.ping,building_count=excluded.building_count,last_seen=excluded.last_seen,online=1`);
    for (const p of players) {
      upsert.run(p.userId, p.playerId ?? '', p.name ?? 'Unknown', p.accountName ?? '', p.level ?? null, p.ping ?? null, p.building_count ?? null, now, now);
      if (!oldOnline.has(p.userId)) this.db.prepare('INSERT INTO sessions(user_id,joined_at) VALUES(?,?)').run(p.userId, now);
    }
    for (const userId of oldOnline) {
      if (!current.has(userId)) {
        this.db.prepare('UPDATE players SET online=0,last_seen=? WHERE user_id=?').run(now, userId);
        this.db.prepare('UPDATE sessions SET left_at=? WHERE id=(SELECT id FROM sessions WHERE user_id=? AND left_at IS NULL ORDER BY joined_at DESC LIMIT 1)').run(now, userId);
      }
    }
    this.reconcileLinks(players);
    return {
      joined: [...current].filter(id => !oldOnline.has(id)),
      left: [...oldOnline].filter(id => !current.has(id))
    };
  }

  recordPositions(actors, now = Date.now()) {
    const stmt = this.db.prepare('INSERT INTO positions(user_id,ts,x,y,z,guild_id,guild_name,level) VALUES(?,?,?,?,?,?,?,?)');
    for (const a of actors) stmt.run(a.userId, now, a.x, a.y, a.z ?? null, a.guildId ?? null, a.guildName ?? null, a.level ?? null);
  }

  recordMetrics(m, now = Date.now()) {
    this.db.prepare(`INSERT OR REPLACE INTO server_samples(ts,server_fps,frame_time,current_players,max_players,uptime,base_camps,days) VALUES(?,?,?,?,?,?,?,?)`)
      .run(now, m.serverfps ?? null, m.serverframetime ?? null, m.currentplayernum ?? null, m.maxplayernum ?? null, m.uptime ?? null, m.basecampnum ?? null, m.days ?? null);
  }
  serverSamples(limit = 100) {
    return this.db.prepare('SELECT * FROM server_samples ORDER BY ts DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  }
  serverMetricsSummary() {
    const row = this.db.prepare(`SELECT COUNT(*) AS samples, MAX(current_players) AS peak_players,
      AVG(server_fps) AS average_fps, MIN(server_fps) AS minimum_fps,
      MAX(ts) AS last_sample FROM server_samples`).get();
    return { samples: Number(row?.samples ?? 0), peakPlayers: Number(row?.peak_players ?? 0), averageFps: Number(row?.average_fps ?? 0), minimumFps: Number(row?.minimum_fps ?? 0), lastSample: Number(row?.last_sample ?? 0) };
  }

  listPlayers() {
    return this.db.prepare(`SELECT p.*, COALESCE((SELECT SUM(COALESCE(left_at, strftime('%s','now')*1000)-joined_at) FROM sessions s WHERE s.user_id=p.user_id),0) AS playtime_ms FROM players p ORDER BY online DESC, last_seen DESC`).all();
  }

  player(userId) {
    return this.db.prepare(`SELECT p.*, COALESCE((SELECT SUM(COALESCE(left_at, strftime('%s','now')*1000)-joined_at) FROM sessions s WHERE s.user_id=p.user_id),0) AS playtime_ms FROM players p WHERE user_id=?`).get(userId);
  }

  recentPositions(sinceMs) {
    return this.db.prepare('SELECT user_id,ts,x,y,z,guild_id,guild_name,level FROM positions WHERE ts>=? ORDER BY ts ASC').all(sinceMs);
  }

  createLinkCode(discordId, code, expiresAt) {
    this.db.prepare('DELETE FROM link_codes WHERE discord_id=? OR expires_at<?').run(discordId, Date.now());
    this.db.prepare('INSERT INTO link_codes(code,discord_id,expires_at) VALUES(?,?,?)').run(code, discordId, expiresAt);
  }

  consumeLinkCode(code, userId, playerName, playerUid = null) {
    const row = this.db.prepare('SELECT * FROM link_codes WHERE code=? AND expires_at>=?').get(code.toUpperCase(), Date.now());
    if (!row) return null;
    this.linkAccount({ discordId: row.discord_id, userId, playerUid, playerName });
    this.db.prepare('DELETE FROM link_codes WHERE code=?').run(code.toUpperCase());
    return row.discord_id;
  }

  linkAccount({ discordId, userId = null, playerUid = null, playerName = '', platform = '' }) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO account_links(discord_id,player_uid,user_id,player_name,platform,linked_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(discord_id) DO UPDATE SET
        player_uid=COALESCE(excluded.player_uid,account_links.player_uid),
        user_id=COALESCE(excluded.user_id,account_links.user_id),
        player_name=excluded.player_name,
        platform=CASE WHEN excluded.platform='' THEN account_links.platform ELSE excluded.platform END,
        linked_at=excluded.linked_at`)
      .run(String(discordId), playerUid ? String(playerUid) : null, userId ? String(userId) : null, playerName ?? '', platform ?? '', now);
    return this.linkForDiscord(discordId);
  }

  linkByPlayerUid(discordId, playerUid, playerName = '') {
    const target = normalizeId(playerUid);
    const live = this.db.prepare('SELECT * FROM players').all().find(p => normalizeId(p.player_id) === target);
    return this.linkAccount({
      discordId,
      playerUid,
      userId: live?.user_id ?? null,
      playerName: playerName || live?.name || '',
      platform: inferPlatform(live?.user_id)
    });
  }

  createClaimChallenge({ discordId, playerUid, playerName, answer, questions, expiresAt }) {
    this.db.prepare('DELETE FROM claim_challenges WHERE discord_id=? OR expires_at<?').run(String(discordId), Date.now());
    this.db.prepare('INSERT INTO claim_challenges(discord_id,player_uid,player_name,answer,questions_json,expires_at) VALUES(?,?,?,?,?,?)')
      .run(String(discordId), String(playerUid), playerName ?? '', normalizeClaimAnswer(answer), JSON.stringify(questions), expiresAt);
  }

  verifyClaimChallenge(discordId, answer) {
    const row = this.db.prepare('SELECT * FROM claim_challenges WHERE discord_id=? AND expires_at>=?').get(String(discordId), Date.now());
    if (!row) return null;
    if (normalizeClaimAnswer(answer) !== row.answer) return null;
    this.db.prepare('DELETE FROM claim_challenges WHERE discord_id=?').run(String(discordId));
    return { playerUid: row.player_uid, playerName: row.player_name, questions: JSON.parse(row.questions_json) };
  }

  linkForDiscord(discordId) {
    return this.db.prepare('SELECT * FROM account_links WHERE discord_id=?').get(String(discordId))
      ?? this.db.prepare('SELECT discord_id,NULL AS player_uid,user_id,player_name,NULL AS platform,linked_at FROM links WHERE discord_id=?').get(String(discordId));
  }
  linkForUser(userId) {
    return this.db.prepare('SELECT * FROM account_links WHERE user_id=?').get(String(userId))
      ?? this.db.prepare('SELECT discord_id,NULL AS player_uid,user_id,player_name,NULL AS platform,linked_at FROM links WHERE user_id=?').get(String(userId));
  }
  unlinkDiscord(discordId) {
    const id = String(discordId);
    const changes = this.db.prepare('DELETE FROM account_links WHERE discord_id=?').run(id).changes;
    const legacy = this.db.prepare('DELETE FROM links WHERE discord_id=?').run(id).changes;
    return changes + legacy;
  }

  appSetting(key, fallback = '') {
    const row = this.db.prepare('SELECT setting_value FROM app_settings WHERE setting_key=?').get(String(key));
    return row ? String(row.setting_value) : fallback;
  }
  setAppSetting(key, value) {
    this.db.prepare(`INSERT INTO app_settings(setting_key,setting_value,updated_at) VALUES(?,?,?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at`)
      .run(String(key), String(value ?? ''), Date.now());
    return String(value ?? '');
  }

  reconcileLinks(players) {
    const links = this.db.prepare('SELECT discord_id,player_uid,user_id FROM account_links WHERE player_uid IS NOT NULL').all();
    for (const link of links) {
      const live = players.find(p => normalizeId(p.playerId) === normalizeId(link.player_uid));
      if (live && live.userId && live.userId !== link.user_id) {
        this.db.prepare('UPDATE account_links SET user_id=?,platform=? WHERE discord_id=?')
          .run(String(live.userId), inferPlatform(live.userId), link.discord_id);
      }
    }
  }

  wallet(discordId) {
    const id = String(discordId);
    const row = this.db.prepare('SELECT balance,updated_at FROM wallets WHERE discord_id=?').get(id);
    return { discordId: id, balance: Number(row?.balance ?? 0), updatedAt: Number(row?.updated_at ?? 0) };
  }

  adjustWallet(discordId, delta, reason, reference = '') {
    const id = String(discordId);
    const amount = Number(delta);
    if (!Number.isInteger(amount) || amount === 0) throw new Error('Wallet delta must be a non-zero integer.');
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = Number(this.db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(id)?.balance ?? 0);
      const next = current + amount;
      if (next < 0) throw new Error('Insufficient balance.');
      this.db.prepare(`INSERT INTO wallets(discord_id,balance,updated_at) VALUES(?,?,?)
        ON CONFLICT(discord_id) DO UPDATE SET balance=excluded.balance,updated_at=excluded.updated_at`).run(id, next, now);
      this.db.prepare('INSERT INTO economy_ledger(ts,discord_id,delta,balance_after,reason,reference) VALUES(?,?,?,?,?,?)')
        .run(now, id, amount, next, String(reason), String(reference || ''));
      this.db.exec('COMMIT');
      return { discordId: id, balance: next, delta: amount };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  economyLedger(discordId, limit = 50) {
    return this.db.prepare('SELECT * FROM economy_ledger WHERE discord_id=? ORDER BY id DESC LIMIT ?')
      .all(String(discordId), Math.min(Math.max(Number(limit)||50,1),200));
  }

  startPurchase({ discordId, productId, price, targetId = '' }) {
    const id = String(discordId);
    const cost = Number(price);
    if (!Number.isInteger(cost) || cost <= 0) throw new Error('Invalid purchase price.');
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = Number(this.db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(id)?.balance ?? 0);
      if (current < cost) throw new Error('Insufficient balance.');
      const next = current - cost;
      this.db.prepare(`INSERT INTO wallets(discord_id,balance,updated_at) VALUES(?,?,?)
        ON CONFLICT(discord_id) DO UPDATE SET balance=excluded.balance,updated_at=excluded.updated_at`).run(id, next, now);
      this.db.prepare('INSERT INTO economy_ledger(ts,discord_id,delta,balance_after,reason,reference) VALUES(?,?,?,?,?,?)')
        .run(now, id, -cost, next, 'shop.reserve', String(productId));
      const out = this.db.prepare('INSERT INTO purchases(ts,discord_id,product_id,price,target_id,status,detail) VALUES(?,?,?,?,?,?,?) RETURNING id')
        .get(now, id, String(productId), cost, String(targetId || ''), 'pending', '');
      this.db.exec('COMMIT');
      return { purchaseId: Number(out.id), balance: next };
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  settlePurchase(purchaseId, detail = '') {
    this.db.prepare('UPDATE purchases SET status=?,detail=? WHERE id=?').run('delivered', String(detail).slice(0,4000), Number(purchaseId));
  }

  refundPurchase(purchaseId, detail = '') {
    const row = this.db.prepare('SELECT * FROM purchases WHERE id=?').get(Number(purchaseId));
    if (!row) throw new Error('Purchase not found.');
    if (row.status === 'refunded') return this.wallet(row.discord_id);
    if (row.status === 'delivered') throw new Error('Delivered purchases are not automatically refundable.');
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = Number(this.db.prepare('SELECT balance FROM wallets WHERE discord_id=?').get(row.discord_id)?.balance ?? 0);
      const next = current + Number(row.price);
      this.db.prepare(`INSERT INTO wallets(discord_id,balance,updated_at) VALUES(?,?,?)
        ON CONFLICT(discord_id) DO UPDATE SET balance=excluded.balance,updated_at=excluded.updated_at`).run(row.discord_id, next, now);
      this.db.prepare('INSERT INTO economy_ledger(ts,discord_id,delta,balance_after,reason,reference) VALUES(?,?,?,?,?,?)')
        .run(now, row.discord_id, Number(row.price), next, 'shop.refund', String(row.product_id));
      this.db.prepare('UPDATE purchases SET status=?,detail=? WHERE id=?').run('refunded', String(detail).slice(0,4000), Number(purchaseId));
      this.db.exec('COMMIT');
      return { balance: next };
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  purchases(discordId = null, limit = 100) {
    const n = Math.min(Math.max(Number(limit)||100,1),500);
    return discordId
      ? this.db.prepare('SELECT * FROM purchases WHERE discord_id=? ORDER BY id DESC LIMIT ?').all(String(discordId), n)
      : this.db.prepare('SELECT * FROM purchases ORDER BY id DESC LIMIT ?').all(n);
  }

  linkedAccounts() { return this.db.prepare('SELECT * FROM account_links').all(); }

  playtimeRewardState(discordId) { return Number(this.db.prepare('SELECT rewarded_units FROM playtime_rewards WHERE discord_id=?').get(String(discordId))?.rewarded_units ?? 0); }
  setPlaytimeRewardState(discordId, units) {
    this.db.prepare(`INSERT INTO playtime_rewards(discord_id,rewarded_units,updated_at) VALUES(?,?,?)
      ON CONFLICT(discord_id) DO UPDATE SET rewarded_units=excluded.rewarded_units,updated_at=excluded.updated_at`)
      .run(String(discordId), Number(units), Date.now());
  }

  economySetting(key, fallback) {
    const row = this.db.prepare('SELECT setting_value FROM economy_settings WHERE setting_key=?').get(String(key));
    return row ? Number(row.setting_value) : fallback;
  }

  setEconomySetting(key, value) {
    this.db.prepare(`INSERT INTO economy_settings(setting_key,setting_value,updated_at) VALUES(?,?,?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at`)
      .run(String(key), Number(value), Date.now());
    return Number(value);
  }

  kitClaimed(claimKey, now = Date.now()) {
    const row = this.db.prepare('SELECT claimed_at,expires_at FROM kit_claims WHERE claim_key=?').get(String(claimKey));
    return Boolean(row && Number(row.expires_at) > now);
  }
  kitCooldownRemaining(claimKey, now = Date.now()) {
    const row = this.db.prepare('SELECT expires_at FROM kit_claims WHERE claim_key=?').get(String(claimKey));
    return Math.max(0, Number(row?.expires_at ?? 0) - now);
  }

  claimKit(claimKey, cooldownMs, now = Date.now()) {
    const key = String(claimKey);
    if (this.kitClaimed(key, now)) return false;
    this.db.prepare(`INSERT INTO kit_claims(claim_key,claimed_at,expires_at) VALUES(?,?,?)
      ON CONFLICT(claim_key) DO UPDATE SET claimed_at=excluded.claimed_at,expires_at=excluded.expires_at`)
      .run(key, now, now + Math.max(0, Number(cooldownMs) || 0));
    return true;
  }

  releaseKitClaim(claimKey) {
    this.db.prepare('DELETE FROM kit_claims WHERE claim_key=?').run(String(claimKey));
  }

  clearKitClaimsByKit(kitId) {
    const prefix = `${String(kitId)}:%`;
    return this.db.prepare('DELETE FROM kit_claims WHERE claim_key LIKE ?').run(prefix).changes;
  }

  audit(actor, action, target = '', detail = '') {
    this.db.prepare('INSERT INTO audit_log(ts,actor,action,target,detail) VALUES(?,?,?,?,?)').run(Date.now(), actor, action, target, detail);
  }

  scheduledMessages() { return this.db.prepare('SELECT * FROM scheduled_messages ORDER BY next_run_at ASC').all(); }
  addScheduledMessage({ message, intervalMinutes = 15, enabled = true, createdAt = Date.now(), nextRunAt = Date.now() + (intervalMinutes * 60 * 1000) }) {
    const now = Date.now();
    return this.db.prepare('INSERT INTO scheduled_messages(enabled,message,interval_minutes,next_run_at,last_run_at,created_at,updated_at,error) VALUES(?,?,?,?,?,?,?,?)').run(enabled ? 1 : 0, String(message), Math.max(5, Number(intervalMinutes) || 15), Number(nextRunAt || now), null, Number(createdAt || now), now, null).lastInsertRowid;
  }
  updateScheduledMessage(id, patch = {}) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      const col = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
      if (col === 'id') continue;
      sets.push(`${col} = ?`);
      values.push(value);
    }
    if (!sets.length) return 0;
    values.push(Number(id));
    return this.db.prepare(`UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes;
  }
  deleteScheduledMessage(id) {
    return this.db.prepare('DELETE FROM scheduled_messages WHERE id=?').run(Number(id)).changes;
  }
  nextScheduledMessages(now = Date.now()) {
    return this.db.prepare('SELECT * FROM scheduled_messages WHERE enabled=1 AND next_run_at <= ? ORDER BY next_run_at ASC').all(now);
  }
  markScheduledRun(id, { nextRunAt, lastRunAt = Date.now(), error = null }) {
    this.db.prepare('UPDATE scheduled_messages SET next_run_at=?, last_run_at=?, updated_at=?, error=? WHERE id=?')
      .run(Number(nextRunAt), Number(lastRunAt), Date.now(), error ? String(error) : null, Number(id));
  }

  auditLog(limit = 100) { return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)); }
  close() { this.db.close(); }
}

function normalizeId(value) { return String(value ?? '').replace(/-/g, '').toLowerCase(); }
function normalizeClaimAnswer(value) { return String(value ?? '').trim().replace(/\s+/g, '').replace(/[,_/]/g, '-'); }
function inferPlatform(userId) {
  const value = String(userId ?? '').toLowerCase();
  if (value.startsWith('steam_')) return 'steam';
  if (value.startsWith('xbox_')) return 'xbox';
  if (value.startsWith('ps') || value.includes('psn')) return 'ps5';
  return '';
}
