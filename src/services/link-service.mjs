import { randomBytes } from 'node:crypto';

const norm = value => String(value ?? '').replace(/-/g, '').toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class LinkService {
  constructor({ db, saveReader = null, rest = null }) { this.db = db; this.saveReader = saveReader; this.rest = rest; }

  create(discordId, ttlMs = 10 * 60 * 1000) {
    const code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    const expiresAt = Date.now() + ttlMs;
    this.db.createLinkCode(discordId, code, expiresAt);
    return { code, expiresAt };
  }

  consume(code, userId, playerName) {
    const live = this.db.player(userId);
    return this.db.consumeLinkCode(code, userId, playerName, live?.player_id ?? null);
  }

  status(discordId) { return this.db.linkForDiscord(discordId); }

  async createSaveClaim(discordId, playerQuery, ttlMs = 10 * 60 * 1000) {
    if (!this.saveReader?.enabled) throw new Error('Save-based linking is not enabled on this PalControl server.');

    // Flush current game state first so the private questions reflect what the player sees now.
    if (this.rest) {
      try { await this.rest.save(); await sleep(1200); } catch { /* Read the latest available save if REST save is unavailable. */ }
    }

    const rosterDoc = await this.saveReader.roster();
    const roster = Array.isArray(rosterDoc.roster) ? rosterDoc.roster : [];
    const q = String(playerQuery ?? '').trim();
    if (!q) throw new Error('Player nickname or PlayerUID is required.');
    const byUid = roster.filter(r => norm(r.playerUId) === norm(q));
    const byName = roster.filter(r => String(r.character?.nickname ?? '').toLowerCase() === q.toLowerCase());
    const matches = byUid.length ? byUid : byName;
    if (!matches.length) throw new Error(`No saved character matched “${q}”.`);
    if (matches.length > 1) throw new Error('More than one character has that nickname. Use the PlayerUID instead.');

    const selected = matches[0];
    const playerUid = String(selected.playerUId);
    const playerName = selected.character?.nickname || q;
    const playerDoc = await this.saveReader.player(playerUid);
    const player = playerDoc.player;
    if (!player) throw new Error('The save reader returned no player document.');

    const generated = buildPrivateChallenge(player);
    if (generated.questions.length < 2) {
      throw new Error('I cannot build a strong private save challenge for this character yet. Put at least two Pals in your party and/or some item stacks in your inventory, save the world, then try again.');
    }
    const expiresAt = Date.now() + ttlMs;
    this.db.createClaimChallenge({ discordId, playerUid, playerName, answer: generated.answer, questions: generated.questions, expiresAt });
    return { playerUid, playerName, questions: generated.questions, expiresAt };
  }

  verifySaveClaim(discordId, answer) {
    const result = this.db.verifyClaimChallenge(discordId, String(answer ?? '').trim());
    if (!result) return null;
    return this.db.linkByPlayerUid(discordId, result.playerUid, result.playerName);
  }
}

function buildPrivateChallenge(player) {
  const candidates = [];
  const party = (player.pals ?? []).filter(p => p.location === 'party' && Number.isInteger(p.slot));
  for (const pal of party) {
    const level = Number(pal.level);
    if (!Number.isFinite(level)) continue;
    candidates.push(numericQuestion(`What level is the Pal in your party slot ${Number(pal.slot) + 1}?`, level, 1, 65));
  }

  const inv = player.inventory ?? {};
  for (const [container, label] of [['food','Food'],['weapons','Weapons'],['armor','Armor'],['common','Inventory']]) {
    for (const stack of inv[container] ?? []) {
      const count = Number(stack.count);
      const slot = Number(stack.slot);
      if (!Number.isFinite(count) || !Number.isFinite(slot) || count < 1) continue;
      candidates.push(numericQuestion(`How many items are in your ${label} slot ${slot + 1}?`, count, 1, Math.max(9999, count + 50)));
    }
  }

  // Deterministically random enough for a one-time challenge, while keeping questions independent.
  shuffle(candidates);
  const picked = candidates.slice(0, 3);
  return {
    questions: picked.map(({ question, options }) => ({ question, options })),
    answer: picked.map(x => String(x.correct + 1)).join('-')
  };
}

function numericQuestion(question, actual, min, max) {
  const values = new Set([actual]);
  const deltas = [1, 2, 3, 5, 7, 10, 15, 20, 25, 50];
  shuffle(deltas);
  for (const d of deltas) {
    if (values.size >= 4) break;
    const sign = Math.random() < 0.5 ? -1 : 1;
    const v = Math.max(min, Math.min(max, actual + sign * d));
    if (v !== actual) values.add(v);
  }
  while (values.size < 4) values.add(Math.max(min, Math.min(max, actual + values.size + 1)));
  const options = [...values];
  shuffle(options);
  return { question, options, correct: options.indexOf(actual) };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
