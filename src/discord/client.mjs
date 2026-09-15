const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const INTENTS = { GUILDS: 1, GUILD_MESSAGES: 512, MESSAGE_CONTENT: 32768 };
const C = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 };

function embed({ title, description = '', fields = [], color = 0x56d7ea, footer }) {
  return {
    title,
    description,
    color,
    fields: fields.map((f) => ({ name: String(f.name), value: String(f.value), inline: Boolean(f.inline) })),
    footer: footer ? { text: footer } : undefined,
    timestamp: new Date().toISOString()
  };
}
function button(custom_id, label, style = C.SECONDARY, disabled = false) { return { type: 2, custom_id, label, style, disabled }; }
function row(...components) { return { type: 1, components }; }
function userId(i) { return i.member?.user?.id ?? i.user?.id ?? ''; }
function isUnknownInteraction(error) { return error?.discordCode === 10062 || /Unknown interaction/i.test(error?.message ?? ''); }

export class DiscordClient {
  constructor({ config, services, db, logger = console }) {
    this.cfg = config;
    this.services = services;
    this.db = db;
    this.logger = logger;
    this.ws = null;
    this.seq = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.lastPresence = '';
  }

  get enabled() { return Boolean(this.cfg.token && this.cfg.clientId); }
  headers() { return { Authorization: `Bot ${this.cfg.token}`, 'Content-Type': 'application/json' }; }

  async api(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord API ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  }

  async hasGuildRole(discordId, roleName, guildId = this.cfg.guildId) {
    if (!guildId || !discordId) return false;
    const member = await this.api('GET', `/guilds/${guildId}/members/${discordId}`);
    const roles = await this.api('GET', `/guilds/${guildId}/roles`);
    const wanted = normalizeRoleName(roleName);
    const roleIds = new Set(roles.filter((role) => normalizeRoleName(role.name) === wanted).map((role) => role.id));
    return (member.roles ?? []).some((roleId) => roleIds.has(roleId));
  }

  async setGuildRole(discordId, roleName, add, guildId = this.cfg.guildId) {
    if (!guildId || !discordId) throw new Error('Discord guild and user are required.');
    const roles = await this.api('GET', `/guilds/${guildId}/roles`);
    const wanted = normalizeRoleName(roleName);
    const role = roles.find((entry) => normalizeRoleName(entry.name) === wanted);
    if (!role) throw new Error(`Role "${roleName}" was not found in this Discord server.`);
    const path = `/guilds/${guildId}/members/${discordId}/roles/${role.id}`;
    await this.api(add ? 'PUT' : 'DELETE', path);
    return role;
  }

  commands() {
    const admin = '8';
    return [
      { name: 'server', description: 'Palworld server control and status', default_member_permissions: admin },
      { name: 'setup', description: 'Verify integrations and set up PalControl Discord channels', default_member_permissions: admin },
      { name: 'server-settings', description: 'View live Palworld settings and supported controls', default_member_permissions: admin },
      { name: 'players', description: 'Show connected Palworld players' },
      { name: 'map', description: 'Open the PalControl live map' },
      { name: 'link', description: 'Link Discord to your Palworld character', options: [{ type: 3, name: 'player', description: 'Character nickname or PlayerUID (optional)', required: false }] },
      { name: 'shop', description: 'Open the PalControl server shop and your wallet' },
      { name: 'kit', description: 'Claim a server kit for your linked Palworld character', options: [{ type: 3, name: 'kit', description: 'Kit id (default: starter)', required: false }] },
      { name: 'vip', description: 'Assign or remove the VIP role', default_member_permissions: admin, options: [{ type: 6, name: 'user', description: 'Discord member', required: true }, { type: 3, name: 'action', description: 'Role action', required: true, choices: [{ name: 'Add VIP', value: 'add' }, { name: 'Remove VIP', value: 'remove' }] }] },
      { name: 'admin', description: 'Administrative account linking', default_member_permissions: admin, options: [
        { type: 1, name: 'link', description: 'Link a Discord member to an in-game name', options: [{ type: 6, name: 'user', description: 'Discord member', required: true }, { type: 3, name: 'player', description: 'Exact in-game name', required: true }] },
        { type: 1, name: 'unlink', description: 'Remove a Discord account link', options: [{ type: 6, name: 'user', description: 'Discord member', required: true }] }
      ] },
      { name: 'schedule', description: 'Schedule a recurring server message', default_member_permissions: admin, options: [{ type: 3, name: 'message', description: 'Message; supports {server}, {online}, {maxPlayers}', required: true }, { type: 4, name: 'minutes', description: 'Repeat interval in minutes (minimum 5)', required: true, min_value: 5, max_value: 10080 }] },
      { name: 'welcomemsg', description: 'Configure the first-join welcome message', default_member_permissions: admin, options: [{ type: 3, name: 'message', description: 'Message; supports {player}, {server}, {online}, {maxPlayers}', required: false }] },
      { name: 'whitelist', description: 'PalDefender whitelist control', default_member_permissions: admin, options: [{ type: 3, name: 'user_id', description: 'Palworld UserId (optional)', required: false }] },
      { name: 'announce', description: 'Send a message to the Palworld server', default_member_permissions: admin, options: [{ type: 3, name: 'message', description: 'Message', required: true }] },
      { name: 'teleport', description: 'Teleport a live player', default_member_permissions: admin, options: [{ type: 3, name: 'user_id', description: 'Palworld name or UserId', required: true }, { type: 3, name: 'x', description: 'World X', required: true }, { type: 3, name: 'y', description: 'World Y', required: true }, { type: 3, name: 'z', description: 'World Z', required: true }] },
      { name: 'kill', description: 'Kill a live player with confirmation from the server bridge', default_member_permissions: admin, options: [{ type: 3, name: 'user_id', description: 'Palworld name or UserId', required: true }] },
      { name: 'message', description: 'Send a private message to a live player', default_member_permissions: admin, options: [{ type: 3, name: 'user_id', description: 'Palworld name or UserId', required: true }, { type: 3, name: 'text', description: 'Private message', required: true }] },
      { name: 'kick', description: 'Kick a Palworld player', default_member_permissions: admin, options: [{ type: 3, name: 'user_id', description: 'Palworld userId', required: true }, { type: 3, name: 'reason', description: 'Reason', required: false }] },
      { name: 'ban', description: 'Ban a Palworld player', default_member_permissions: admin, options: [{ type: 3, name: 'user_id', description: 'Palworld userId', required: true }, { type: 3, name: 'reason', description: 'Reason', required: false }] },
      { name: 'unban', description: 'Unban a Palworld player', default_member_permissions: admin, options: [{ type: 3, name: 'user_id', description: 'Palworld userId', required: true }] }
    ];
  }

  async registerCommands() {
    const p = this.cfg.guildId
      ? `/applications/${this.cfg.clientId}/guilds/${this.cfg.guildId}/commands`
      : `/applications/${this.cfg.clientId}/commands`;
    await this.api('PUT', p, this.commands());
    this.logger.log(`[discord] registered ${this.commands().length} commands (${this.cfg.guildId ? `guild ${this.cfg.guildId}` : 'global'})`);
  }

  async start() {
    if (!this.enabled) { this.logger.log('[discord] disabled'); return; }
    if (this.cfg.registerCommands) {
      try {
        await this.registerCommands();
      } catch (error) {
        this.logger.error?.('[discord] command registration failed; continuing gateway startup:', error.message);
      }
    }
    this.connect();
  }

  stop() {
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    const ws = this.ws = new WebSocket(GATEWAY);
    ws.addEventListener('message', (e) => {
      try { this.onGateway(JSON.parse(e.data)); }
      catch (error) { this.logger.error?.('[discord gateway payload]', error); }
    });
    ws.addEventListener('close', () => {
      clearInterval(this.heartbeat);
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
    ws.addEventListener('error', (e) => this.logger.warn?.('[discord gateway]', e.message ?? 'websocket error'));
  }

  sendHeartbeat() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
  }

  updatePresence(snapshot = {}) {
    const metrics = snapshot.metrics ?? {};
    const current = Number(metrics.currentplayernum ?? snapshot.players?.length ?? 0);
    const max = Number(metrics.maxplayernum ?? 0);
    const name = `Players ${current}/${max || '?'}`;
    if (name === this.lastPresence || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ op: 3, d: { since: null, activities: [{ name, type: 0 }], status: snapshot.online === false ? 'idle' : 'online', afk: false } }));
    this.lastPresence = name;
  }

  onGateway(p) {
    if (p.s != null) this.seq = p.s;
    if (p.op === 10) {
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.sendHeartbeat(), p.d.heartbeat_interval);
      this.sendHeartbeat();
      let intents = INTENTS.GUILDS;
      if (this.cfg.bridgeEnabled && this.cfg.chatChannelId) intents |= INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT;
      this.ws.send(JSON.stringify({ op: 2, d: { token: this.cfg.token, intents, properties: { os: process.platform, browser: 'PalControl', device: 'PalControl' } } }));
      this.updatePresence(this.services.poller?.snapshot?.() ?? {});
      return;
    }
    if (p.op === 1) { this.sendHeartbeat(); return; }
    if (p.op === 7 || p.op === 9) { this.ws.close(); return; }
    if (p.t === 'INTERACTION_CREATE') this.handleInteraction(p.d).catch((e) => this.logger.error('[discord interaction]', e));
    if (p.t === 'MESSAGE_CREATE') this.handleMessage(p.d).catch((e) => this.logger.error('[discord message]', e));
  }

  option(data, name) { return data?.options?.find((o) => o.name === name)?.value; }

  async callback(i, type, data) {
    const res = await fetch(`${API}/interactions/${i.id}/${i.token}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data })
    });
    if (!res.ok) {
      const text = await res.text();
      const error = new Error(`Discord interaction callback ${res.status}: ${text.slice(0, 500)}`);
      error.status = res.status;
      try { error.discordCode = JSON.parse(text)?.code; } catch {}
      throw error;
    }
    i.__acknowledged = true;
  }

  async defer(i, { ephemeral = true } = {}) {
    if (i.__acknowledged) return;
    await this.callback(i, 5, { flags: ephemeral ? 64 : 0 });
    i.__deferred = true;
  }

  async editOriginal(i, { content, embeds, components = [] }) {
    const appId = i.application_id || this.cfg.clientId;
    const res = await fetch(`${API}/webhooks/${appId}/${i.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content ?? null, embeds: embeds ?? [], components })
    });
    const text = await res.text();
    if (!res.ok) {
      const error = new Error(`Discord interaction edit ${res.status}: ${text.slice(0, 500)}`);
      error.status = res.status;
      try { error.discordCode = JSON.parse(text)?.code; } catch {}
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  respond(i, { content, embeds, components = [], ephemeral = false }) {
    if (i.__deferred) return this.editOriginal(i, { content, embeds, components });
    return this.callback(i, 4, { content, embeds, components, flags: ephemeral ? 64 : 0 });
  }

  modal(i, { customId, title, label = 'Answers', placeholder = 'Example: 2-4-1' }) {
    return this.callback(i, 9, {
      custom_id: customId,
      title,
      components: [row({ type: 4, custom_id: 'answers', style: 1, label, placeholder, required: true, min_length: 1, max_length: 32 })]
    });
  }

  modalValue(i, id) {
    for (const r of i.data?.components ?? []) for (const c of r.components ?? []) if (c.custom_id === id) return c.value;
    return '';
  }

  async handleInteraction(i) {
    const actor = `discord:${userId(i) || 'unknown'}`;
    const directModal = i.type === 3 && i.data?.custom_id === 'link:answer';
    try {
      // Discord requires the first acknowledgement within ~3 seconds. Every potentially
      // slow operation is deferred immediately; modal-open interactions are the exception.
      if (!directModal && [2, 3, 5].includes(i.type)) await this.defer(i, { ephemeral: true });

      if (i.type === 3) return this.handleComponent(i, actor);
      if (i.type === 5) return this.handleModal(i, actor);

      const name = i.data?.name;
      if (name === 'server') return this.showServer(i);
      if (name === 'setup') return this.startSetup(i, actor);
      if (name === 'server-settings') return this.showServerSettings(i);
      if (name === 'players') {
        const p = this.services.poller.snapshot().players;
        const lines = p.length ? p.slice(0, 25).map((x) => `• **${x.name}** · Lv.${x.level ?? '?'} · ${Math.round(x.ping ?? 0)}ms`).join('\n') : 'No players online.';
        return this.respond(i, { embeds: [embed({ title: `👥 Players (${p.length})`, description: lines, footer: this.services.brand.footer })], ephemeral: true });
      }
      if (name === 'map') return this.respond(i, { content: `🗺️ ${this.services.publicBaseUrl}/#map`, ephemeral: true });
      if (name === 'link') return this.startLink(i, this.option(i.data, 'player'));
      if (name === 'shop') return this.openShop(i);
      if (name === 'kit') return this.claimDiscordKit(i);
      if (name === 'vip') return this.manageVip(i, actor);
      if (name === 'admin') return this.handleAdminCommand(i, actor);
      if (name === 'schedule') return this.createSchedule(i, actor);
      if (name === 'welcomemsg') return this.configureWelcome(i, actor);
      if (name === 'whitelist') return this.openWhitelist(i, this.option(i.data, 'user_id'));
      if (name === 'announce') {
        const message = this.option(i.data, 'message');
        let transport = 'palworld-rest';
        if (this.services.bridge?.enabled) {
          try { await this.services.bridge.announce(message); transport = 'ue4ss-bridge'; }
          catch (error) {
            this.logger.warn?.('[discord announce/bridge]', error.message);
            if (this.services.palDefender?.enabled) { await this.services.palDefender.broadcast(message); transport = 'paldefender-rest'; }
            else await this.services.rest.announce(message);
          }
        } else if (this.services.palDefender?.enabled) {
          await this.services.palDefender.broadcast(message); transport = 'paldefender-rest';
        } else await this.services.rest.announce(message);
        this.db.audit(actor, 'server.announce', '', `${message};transport=${transport}`);
        return this.respond(i, { content: `✅ Announcement sent via **${transport}**.`, ephemeral: true });
      }
      if (name === 'teleport') return this.teleportPlayer(i, actor);
      if (name === 'kill') return this.killPlayer(i, actor);
      if (name === 'message') return this.messagePlayer(i, actor);
      if (name === 'kick') {
        const uid = this.option(i.data, 'user_id'), reason = this.option(i.data, 'reason') ?? 'Kicked by an administrator.';
        await this.services.rest.kick(uid, reason);
        this.db.audit(actor, 'player.kick', uid, reason);
        return this.respond(i, { content: `✅ Kicked \`${uid}\`.`, ephemeral: true });
      }
      if (name === 'ban') {
        const uid = this.option(i.data, 'user_id'), reason = this.option(i.data, 'reason') ?? 'Banned by an administrator.';
        await this.services.rest.ban(uid, reason);
        this.db.audit(actor, 'player.ban', uid, reason);
        return this.respond(i, { content: `✅ Banned \`${uid}\`.`, ephemeral: true });
      }
      if (name === 'unban') {
        const uid = this.option(i.data, 'user_id');
        await this.services.rest.unban(uid);
        this.db.audit(actor, 'player.unban', uid, '');
        return this.respond(i, { content: `✅ Unbanned \`${uid}\`.`, ephemeral: true });
      }
      return this.respond(i, { content: '❌ Unknown command.', ephemeral: true });
    } catch (err) {
      if (isUnknownInteraction(err)) {
        this.logger.warn?.(`[discord interaction] expired before acknowledgement (${i.data?.name ?? i.data?.custom_id ?? i.id})`);
        return;
      }
      this.logger.error?.('[discord interaction handler]', err);
      try { return await this.respond(i, { content: `❌ ${err.message}`, ephemeral: true }); }
      catch (replyError) {
        if (isUnknownInteraction(replyError)) {
          this.logger.warn?.('[discord interaction] error response could not be delivered because the interaction expired');
          return;
        }
        throw replyError;
      }
    }
  }

  showServer(i) {
    const s = this.services.poller.snapshot(), m = s.metrics ?? {}, caps = this.services.provider.capabilities?.() ?? {};
    const components = [row(
      button('server:refresh', 'Refresh', C.SECONDARY),
      button('server:verify', 'Verify', C.SECONDARY),
      button('server:backup', 'Backup', C.PRIMARY, !this.services.backups.enabled),
      button('server:restart', 'Restart', C.DANGER, !caps.restart)
    )];
    return this.respond(i, {
      embeds: [embed({
        title: `${s.online ? '🟢' : '🔴'} ${this.services.brand.name}`,
        description: s.online ? 'Server online' : `Offline: ${s.lastError ?? 'unreachable'}`,
        footer: this.services.brand.footer,
        fields: [
          { name: 'Players', value: `${m.currentplayernum ?? s.players.length} / ${m.maxplayernum ?? '?'}`, inline: true },
          { name: 'FPS', value: String(m.serverfps ?? '?'), inline: true },
          { name: 'Uptime', value: formatDuration((m.uptime ?? 0) * 1000), inline: true },
          { name: 'Bases', value: String(m.basecampnum ?? '?'), inline: true },
          { name: 'Day', value: String(m.days ?? '?'), inline: true },
          { name: 'Provider', value: this.services.provider.type, inline: true }
        ]
      })],
      components,
      ephemeral: true
    });
  }

  async showServerSettings(i) {
    const settings = await this.services.rest.settings();
    const fields = [
      { name: 'Server', value: String(settings.ServerName ?? this.services.brand.name), inline: true },
      { name: 'Difficulty', value: String(settings.Difficulty ?? 'Unknown'), inline: true },
      { name: 'PvP', value: settings.bIsPvP ? 'Enabled' : 'Disabled', inline: true },
      { name: 'XP rate', value: String(settings.ExpRate ?? 'Unknown'), inline: true },
      { name: 'Capture rate', value: String(settings.PalCaptureRate ?? 'Unknown'), inline: true },
      { name: 'Day / night', value: `${settings.DayTimeSpeedRate ?? '?'} / ${settings.NightTimeSpeedRate ?? '?'}`, inline: true }
    ];
    return this.respond(i, { embeds: [embed({ title: '⚙️ Live server settings', description: 'These values are read from Palworld REST. This Palworld build exposes settings as read-only through REST. Use the controls in `/server` for supported actions: save, backup and restart.', fields, footer: this.services.brand.footer })], ephemeral: true });
  }

  async runRuntimeVerification() {
    const checks = [];

    const bridgeState = this.services.bridge?.enabled
      ? await this.services.bridge.probe().catch((error) => ({ ready: false, reason: error.message, transport: 'ue4ss-ftp' }))
      : { ready: false, reason: 'bridge disabled', transport: null };
    checks.push({ name: 'Bridge', ok: bridgeState.ready, detail: bridgeState.ready ? `ok · ${bridgeState.transport ?? 'ue4ss-ftp'} · ${bridgeState.version ?? 'reachable'}` : bridgeState.reason || 'not ready' });

    const saveReaderState = this.services.saveReader?.probe
      ? await this.services.saveReader.probe().catch((error) => ({ ready: false, reason: error.message }))
      : { ready: false, reason: 'save-reader disabled' };
    checks.push({ name: 'Save Reader', ok: saveReaderState.ready, detail: saveReaderState.ready ? `ok · ${saveReaderState.version ?? 'ready'}` : saveReaderState.reason || 'not ready' });

    const shopState = this.services.shop?.enabled
      ? await this.services.shop.probeDelivery().catch((error) => ({ ready: false, reason: error.message, transport: null }))
      : { ready: false, reason: 'shop disabled', transport: null };
    checks.push({ name: 'Shop / Kits', ok: shopState.ready, detail: shopState.ready ? `ok · ${shopState.transport ?? 'delivery ready'}` : shopState.reason || 'not ready' });

    const messageProbe = this.services.serverMessageService
      ? await this.services.serverMessageService.broadcast('PalControl verification message', { server: this.services.brand?.name || 'PalControl' }).catch((error) => ({ ok: false, error: error.message }))
      : { ok: false, error: 'message service not wired' };
    checks.push({ name: 'Broadcast / Chat', ok: Boolean(messageProbe && messageProbe.ok !== false && messageProbe.transport), detail: messageProbe?.ok === false ? messageProbe.error || 'message delivery failed' : `ok · ${messageProbe.transport || 'transport-ready'}` });

    const onlinePlayers = (this.services.poller?.snapshot?.().players ?? []).length;
    return {
      ok: checks.every((check) => check.ok),
      onlinePlayers,
      checks,
      summary: checks.map((check) => `${check.name}: ${check.ok ? 'OK' : 'FAIL'} — ${check.detail}`).join('\n')
    };
  }

  async verifyServer(i) {
    const report = await this.runRuntimeVerification();
    const lines = report.checks.map((check) => `• ${check.name}: ${check.ok ? '✅' : '❌'} ${check.detail}`).join('\n');
    return this.respond(i, {
      embeds: [embed({
        title: `${report.ok ? '✅' : '⚠️'} Live verification`,
        description: `Players online: **${report.onlinePlayers}**\n\n${lines}`,
        footer: this.services.brand.footer
      })],
      ephemeral: true
    });
  }


  resolveLinkedPalUserId(link) {
    const direct = String(link?.user_id ?? '').trim();
    const playerUid = String(link?.player_uid ?? '').trim();
    const playerNameRaw = String(link?.player_name ?? '').trim();
    const playerName = playerNameRaw.toLowerCase();
    const online = this.services.poller?.snapshot?.().players ?? [];
    const match = online.find((player) => {
      const liveUid = String(player?.userId ?? '').trim();
      const livePlayerId = String(player?.playerId ?? '').trim();
      const liveName = String(player?.name ?? '').trim().toLowerCase();
      return (playerUid && (livePlayerId === playerUid || liveUid === playerUid)) || (playerName && liveName === playerName);
    });
    const liveUserId = String(match?.userId ?? '').trim();
    if (/^(?:gdk|steam)_/i.test(liveUserId)) return liveUserId;
    if (/^(?:gdk|steam)_/i.test(direct)) return direct;
    if (/^(?:gdk|steam)_/i.test(playerUid)) return playerUid;
    // PalControlBridge targets the live PalPlayerState by character name, so it
    // does not require PalDefender's gdk_/steam_ RCON identifier.
    if (this.services.bridge?.enabled) return direct || playerUid || playerNameRaw;
    throw new Error('Your Discord link has no live gdk_/steam_ UserId yet. Join the Palworld server and run /kit again, or enable PalControlBridge.');
  }

  async claimDiscordKit(i) {
    if (!this.services.shop?.enabled) return this.respond(i, { content: 'The server kits are disabled.', ephemeral: true });
    if (!this.services.shop.deliveryReady) return this.respond(i, { content: '⚠️ Kit delivery is not configured: enable PalControlBridge, PalDefender REST, or compatible RCON.', ephemeral: true });
    const did = userId(i);
    const link = this.db.linkForDiscord(did);
    if (!link) return this.respond(i, { content: '❌ Link your Discord account to a Palworld character first with `/link`.', ephemeral: true });
    let target;
    try { target = this.resolveLinkedPalUserId(link); }
    catch (error) { return this.respond(i, { content: `❌ ${error.message}`, ephemeral: true }); }
    const requestedKit = this.option(i.data, 'kit') || 'starter';
    const result = await this.services.shop.claimKit({
      playerUserId: target,
      playerName: link.player_name || target,
      discordId: did,
      kitId: requestedKit,
      hasRole: (discordId, role) => this.hasGuildRole(discordId, role, i.guild_id || this.cfg.guildId)
    });
    this.db.audit(`discord:${did}`, 'kit.claim', result.kit.id, `target=${target}`);
    return this.respond(i, {
      embeds: [embed({
        title: '🎁 Kit delivered',
        description: `**${result.kit.name}** is now in **${link.player_name || 'your linked character'}**'s inventory.`,
        fields: [{ name: 'Next claim', value: 'Available after the cooldown.', inline: true }],
        color: 0x57F287,
        footer: this.services.brand.footer
      })],
      ephemeral: true
    });
  }

  async manageVip(i, actor) {
    const target = this.option(i.data, 'user');
    const action = this.option(i.data, 'action') || 'add';
    const role = await this.setGuildRole(target, 'vip', action === 'add', i.guild_id || this.cfg.guildId);
    this.db.audit(actor, action === 'add' ? 'discord.vip.add' : 'discord.vip.remove', target, `role=${role.id}`);
    return this.respond(i, {
      embeds: [embed({
        title: action === 'add' ? '⭐ VIP enabled' : 'VIP removed',
        description: action === 'add' ? `<@${target}> can now claim the VIP Kit with \`/kit vip\`.` : `<@${target}> can no longer claim the VIP Kit.`,
        color: action === 'add' ? 0xFEE75C : 0x99AAB5,
        footer: this.services.brand.footer
      })],
      ephemeral: true
    });
  }

  async teleportPlayer(i, actor) {
    if (!this.services.bridge?.enabled) throw new Error('Teleport requires an active PalControlBridge.');
    const target = this.option(i.data, 'user_id');
    const x = Number(this.option(i.data, 'x')), y = Number(this.option(i.data, 'y')), z = Number(this.option(i.data, 'z'));
    if (![x, y, z].every(Number.isFinite)) throw new Error('Coordinates must be valid numbers.');
    const result = await this.services.bridge.teleport({ userId: target, playerName: target, x, y, z });
    this.db.audit(actor, 'player.teleport', target, JSON.stringify({ x, y, z }));
    return this.respond(i, { content: `✅ Teleported **${target}** to **${x}, ${y}, ${z}**.`, ephemeral: true });
  }

  async killPlayer(i, actor) {
    if (!this.services.bridge?.enabled) throw new Error('Controlled kill requires an active PalControlBridge.');
    const target = this.option(i.data, 'user_id');
    await this.services.bridge.killPlayer({ userId: target, playerName: target });
    this.db.audit(actor, 'player.kill', target, 'bridge');
    return this.respond(i, { content: `✅ Kill command sent to **${target}**.`, ephemeral: true });
  }

  async messagePlayer(i, actor) {
    if (!this.services.bridge?.enabled) throw new Error('Private messages require an active PalControlBridge.');
    const target = this.option(i.data, 'user_id'), text = this.option(i.data, 'text');
    await this.services.bridge.personalMessage({ userId: target, playerName: target, message: text });
    this.db.audit(actor, 'player.message', target, String(text));
    return this.respond(i, { content: `✅ Private message sent to **${target}**.`, ephemeral: true });
  }

  async handleAdminCommand(i, actor) {
    const subcommand = i.data?.options?.find((option) => option.type === 1);
    const target = subcommand?.options?.find((option) => option.name === 'user')?.value;
    if (!target) throw new Error('A Discord member is required.');
    if (subcommand.name === 'unlink') {
      const removed = this.db.unlinkDiscord(target);
      this.db.audit(actor, 'account.unlink.admin', target, `removed=${removed}`);
      return this.respond(i, { embeds: [embed({ title: '🔓 Account unlinked', description: `<@${target}> no longer has a Palworld account linked.`, color: 0x99AAB5, footer: this.services.brand.footer })], ephemeral: true });
    }
    const playerName = subcommand.options?.find((option) => option.name === 'player')?.value?.trim();
    if (!playerName) throw new Error('The in-game player name is required.');
    const live = (this.services.poller.snapshot().players ?? []).find((player) => String(player.name ?? '').toLowerCase() === playerName.toLowerCase());
    const link = this.db.linkAccount({ discordId: target, userId: live?.userId ?? null, playerUid: live?.playerId ?? null, playerName });
    this.db.audit(actor, 'account.link.admin', target, `player=${playerName};live=${Boolean(live)}`);
    return this.respond(i, { embeds: [embed({ title: '🔗 Account linked', description: `<@${target}> is linked to **${playerName}**.${live ? '' : '\n\nThe player is offline; the live UserId will be reconciled when they join.'}`, color: 0x57F287, footer: this.services.brand.footer })], ephemeral: true });
  }

  async startSetup(i, actor) {
    const check = await this.verifySetup();
    this.db.audit(actor, 'setup.verify', '', JSON.stringify(check));
    const lines = check.checks.map((item) => `${item.ok ? '✅' : '❌'} **${item.name}** · ${item.detail}`).join('\n');
    return this.respond(i, { embeds: [embed({ title: check.ok ? '🧭 PalControl setup' : '⚠️ PalControl setup needs attention', description: `Configure the server connection first.\n\n${lines}\n\n${check.ok ? 'Connection is ready. Press **Next** to upload the bridge and create the Discord channels.' : 'Press **Connection details** to enter or correct REST and FTP settings.'}`, color: check.ok ? 0x57F287 : 0xED4245, footer: this.services.brand.footer })], components: [row(button('setup:credentials', 'Connection details', C.PRIMARY), button('setup:next', 'Next', C.SUCCESS, !check.ok))], ephemeral: true });
  }

  setupModal(i) {
    return this.callback(i, 9, { custom_id: 'setup:credentials', title: 'PalControl connection', components: [
      row({ type: 4, custom_id: 'rest_url', style: 1, label: 'Palworld REST URL', value: this.services.rest.baseUrl.replace(/\/v1\/api$/, ''), required: true, max_length: 200 }),
      row({ type: 4, custom_id: 'rest_password', style: 1, label: 'Palworld admin password', value: '', placeholder: 'Leave blank to keep current', required: false, max_length: 100 }),
      row({ type: 4, custom_id: 'ftp_host', style: 1, label: 'FTP host:port', value: `${this.services.remoteStore?.host ?? ''}:${this.services.remoteStore?.port ?? 21}`, required: true, max_length: 150 }),
      row({ type: 4, custom_id: 'ftp_user', style: 1, label: 'FTP username', value: this.services.remoteStore?.user ?? '', required: true, max_length: 150 }),
      row({ type: 4, custom_id: 'ftp_password', style: 1, label: 'FTP password', value: '', placeholder: 'Leave blank to keep current', required: false, max_length: 150 })
    ]});
  }

  applySetupCredentials(values) {
    const restUrl = String(values.rest_url ?? '').trim().replace(/\/$/, '');
    const restPassword = String(values.rest_password ?? '') || this.services.rest.password;
    const ftpParts = String(values.ftp_host ?? '').trim().split(':');
    const ftpHost = ftpParts.shift();
    const ftpPort = Number(ftpParts.pop() || 21);
    const ftpPassword = String(values.ftp_password ?? '') || this.services.remoteStore?.password;
    if (!restUrl || !ftpHost || !Number.isInteger(ftpPort) || ftpPort <= 0 || !this.services.remoteStore) throw new Error('REST URL and FTP host:port are required.');
    this.services.rest.baseUrl = `${restUrl}/v1/api`;
    this.services.rest.password = restPassword;
    this.services.remoteStore.host = ftpHost;
    this.services.remoteStore.port = ftpPort;
    this.services.remoteStore.user = String(values.ftp_user ?? '').trim();
    this.services.remoteStore.password = ftpPassword;
    this.db.setAppSetting('setup.rest_url', restUrl);
    this.db.setAppSetting('setup.rest_password', restPassword);
    this.db.setAppSetting('setup.ftp_host', ftpHost);
    this.db.setAppSetting('setup.ftp_port', String(ftpPort));
    this.db.setAppSetting('setup.ftp_user', this.services.remoteStore.user);
    this.db.setAppSetting('setup.ftp_password', ftpPassword);
  }

  async verifySetup() {
    const checks = [];
    try { const info = await this.services.rest.info(); checks.push({ name: 'Palworld REST', ok: true, detail: `${info?.servername || 'server'} · ${info?.version || 'reachable'}` }); }
    catch (error) { checks.push({ name: 'Palworld REST', ok: false, detail: error.message }); }
    try {
      if (!this.services.remoteStore?.enabled) throw new Error('FTP is not configured.');
      const entries = await this.services.remoteStore.list('/Pal');
      checks.push({ name: 'FTP', ok: Array.isArray(entries), detail: `${entries?.length ?? 0} entries in /Pal` });
    } catch (error) { checks.push({ name: 'FTP', ok: false, detail: error.message }); }
    checks.push({ name: 'RCON', ok: Boolean(this.services.rcon?.password), detail: this.services.rcon?.password ? 'configured (optional)' : 'not configured (optional)' });
    return { ok: checks.filter((item) => item.name !== 'RCON').every((item) => item.ok), checks };
  }

  async completeSetup(i, actor) {
    const check = await this.verifySetup();
    if (!check.ok) return this.respond(i, { content: '❌ Setup verification failed. Run `/setup` again after fixing REST/FTP.', ephemeral: true });
    const bridgeRoot = this.services.serverDiscovery?.bridgeRoot;
    const remoteStore = this.services.remoteStore;
    const remoteData = this.services.bridge?.remoteDir;
    if (!bridgeRoot || !remoteStore?.enabled || !remoteData) throw new Error('Bridge installation requires local bridge files and configured FTP.');
    const bridgePath = remoteData.replace(/\/data\/?$/, '');
    const bridgeResult = await this.services.serverDiscovery.syncBridge({ remoteStore, bridgePath, localBridgeRoot: bridgeRoot });
    if (bridgeResult.status === 'PROTECTED') throw new Error(`Remote PalControlBridge ${bridgeResult.remoteVersion} is newer than bundled ${bridgeResult.bundledVersion}; automatic overwrite refused.`);
    const modsPath = path.posix.dirname(bridgePath);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palcontrol-setup-'));
    const localMods = path.join(tempDir, 'mods.txt');
    try {
      try { await remoteStore.downloadFile(`${modsPath}/mods.txt`, localMods); } catch { await fs.writeFile(localMods, '', 'utf8'); }
      const updated = this.services.serverDiscovery.ensureModsTxtEntry(await fs.readFile(localMods, 'utf8'));
      await fs.writeFile(localMods, updated, 'utf8');
      await remoteStore.uploadFile(localMods, `${modsPath}/mods.txt`);
    } finally { await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}); }
    const channels = await this.ensureSetupChannels(i.guild_id || this.cfg.guildId);
    const linkChannel = channels.link;
    await this.api('POST', `/channels/${linkChannel}/messages`, { embeds: [embed({ title: '🔗 Link your Palworld account', description: 'Press the button to link your Discord account to your Palworld character.', color: 0x5865F2, footer: this.services.brand.footer })], components: [row(button('setup:link', 'Link account', C.PRIMARY))] });
    this.db.audit(actor, 'setup.complete', i.guild_id || this.cfg.guildId, JSON.stringify(channels));
    const bridgeDescription = bridgeResult.status === 'RESTART_REQUIRED'
      ? `PalControlBridge files ${bridgeResult.bundledVersion} were uploaded, but the running bridge is still ${bridgeResult.runningVersion || 'unknown'}. **Restart the Palworld server now.**`
      : bridgeResult.status === 'UP_TO_DATE'
        ? `PalControlBridge ${bridgeResult.bundledVersion} is already installed and its heartbeat matches.`
        : `PalControlBridge ${bridgeResult.bundledVersion} is installed and confirmed by heartbeat.`;
    return this.respond(i, { embeds: [embed({ title: bridgeResult.status === 'RESTART_REQUIRED' ? '⚠️ Setup requires restart' : '✅ Setup complete', description: bridgeDescription, fields: Object.entries(channels).map(([name, id]) => ({ name, value: `<#${id}>`, inline: true })), color: bridgeResult.status === 'RESTART_REQUIRED' ? 0xFEE75C : 0x57F287, footer: this.services.brand.footer })], ephemeral: true });
  }

  async ensureSetupChannels(guildId) {
    const definitions = { killfeed: 'palcontrol-killfeed', playerfeed: 'palcontrol-playerfeed', chat: 'palworld-chat', admin: 'palcontrol-admin', link: 'palworld-link' };
    const channels = {};
    for (const [key, name] of Object.entries(definitions)) {
      const setting = `discord.channel.${key}`;
      const existing = this.db.appSetting(setting, '');
      if (existing) { channels[key] = existing; continue; }
      const body = { name, type: 0 };
      if (key === 'admin') body.permission_overwrites = [{ id: guildId, type: 0, deny: '1024' }];
      const channel = await this.api('POST', `/guilds/${guildId}/channels`, body);
      channels[key] = channel.id;
      this.db.setAppSetting(setting, channel.id);
    }
    return channels;
  }

  async createSchedule(i, actor) {
    const message = this.option(i.data, 'message');
    const minutes = Number(this.option(i.data, 'minutes'));
    const id = this.services.serverMessageService.scheduleMessage(message, { intervalMinutes: minutes });
    this.db.audit(actor, 'message.schedule', String(id), `minutes=${minutes}`);
    return this.respond(i, { embeds: [embed({ title: '📣 Scheduled message created', description: `The server will repeat:\n\n> ${message}`, fields: [{ name: 'Interval', value: `Every ${minutes} minutes`, inline: true }, { name: 'Schedule ID', value: String(id), inline: true }], color: 0x57F287, footer: this.services.brand.footer })], ephemeral: true });
  }

  async configureWelcome(i, actor) {
    const message = this.option(i.data, 'message');
    if (!message) return this.respond(i, { embeds: [embed({ title: '👋 Welcome message', description: this.services.serverMessageService.getWelcomeMessage(), footer: this.services.brand.footer })], ephemeral: true });
    this.services.serverMessageService.setWelcomeMessage(message);
    this.db.audit(actor, 'message.welcome.update', '', message);
    return this.respond(i, { embeds: [embed({ title: '👋 Welcome message updated', description: message, color: 0x57F287, footer: this.services.brand.footer })], ephemeral: true });
  }

  shopCategories(products = this.services.shop?.catalog?.() ?? []) {
    return [...new Set(products.map((product) => String(product.category || 'Other').trim() || 'Other'))];
  }

  async openShop(i, categoryPage = 0) {
    if (!this.services.shop?.enabled) return this.respond(i, { content: 'The server shop is disabled.', ephemeral: true });
    if (!this.services.shop.deliveryReady) return this.respond(i, { content: '⚠️ Shop delivery is not configured: enable PalControlBridge, PalDefender REST, or compatible RCON.', ephemeral: true });

    const did = userId(i);
    const wallet = this.services.shop.wallet(did);
    const products = this.services.shop.catalog();
    const kits = this.services.shop.kitsCatalog?.() ?? [];

    if (!products.length) {
      return this.respond(i, {
        embeds: [embed({
          title: '🛒 Palworld server shop',
          description: `Wallet: **${wallet.balance} coins**\n\nThe shop is enabled but the product catalog is empty.`,
          footer: this.services.brand.footer
        })],
        ephemeral: true
      });
    }

    const categories = this.shopCategories(products);
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(categories.length / pageSize));
    const page = Math.min(Math.max(0, Number(categoryPage) || 0), pageCount - 1);
    const start = page * pageSize;
    const visible = categories.slice(start, start + pageSize);

    const options = visible.map((category, offset) => {
      const count = products.filter((product) => (product.category || 'Other') === category).length;
      return {
        label: category.slice(0, 100),
        value: String(start + offset),
        description: `${count} product${count === 1 ? '' : 's'} available`.slice(0, 100)
      };
    });

    const summary = visible.map((category) => {
      const entries = products.filter((product) => (product.category || 'Other') === category);
      const prices = entries.map((product) => Number(product.price) || 0);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const range = min === max ? `${min} coins` : `${min}–${max} coins`;
      return `• **${category}** · ${entries.length} product${entries.length === 1 ? '' : 's'} · ${range}`;
    }).join('\n');

    const components = [
      row({
        type: 3,
        custom_id: 'shop:category',
        placeholder: 'Choose a shop category',
        min_values: 1,
        max_values: 1,
        options
      })
    ];

    if (pageCount > 1) {
      components.push(row(
        button(`shop:categories:${page - 1}`, '◀ Previous', C.SECONDARY, page <= 0),
        button(`shop:categories:${page + 1}`, 'Next ▶', C.SECONDARY, page >= pageCount - 1)
      ));
    }

    if (kits.length) components.push(row(button('shop:kits', `Kits (${kits.length})`, C.PRIMARY)));

    return this.respond(i, {
      embeds: [embed({
        title: '🛒 Palworld server shop',
        description: `Wallet: **${wallet.balance} coins**\n\nChoose a **category** from the dropdown, then choose the product you want.\n\n${summary}`,
        fields: [
          { name: 'Products', value: String(products.length), inline: true },
          { name: 'Categories', value: String(categories.length), inline: true },
          { name: 'Kits', value: String(kits.length), inline: true }
        ],
        color: 0xFEE75C,
        footer: this.services.brand.footer
      })],
      components,
      ephemeral: true
    });
  }

  async openShopCategory(i, categoryIndex, productPage = 0) {
    const products = this.services.shop?.catalog?.() ?? [];
    const categories = this.shopCategories(products);
    const index = Number(categoryIndex);

    if (!Number.isInteger(index) || index < 0 || index >= categories.length) {
      return this.respond(i, { content: '❌ That shop category no longer exists. Reopen `/shop`.', ephemeral: true });
    }

    const category = categories[index];
    const entries = products.filter((product) => (product.category || 'Other') === category);
    if (!entries.length) return this.openShop(i);

    const wallet = this.services.shop.wallet(userId(i));
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = Math.min(Math.max(0, Number(productPage) || 0), pageCount - 1);
    const start = page * pageSize;
    const visible = entries.slice(start, start + pageSize);

    const options = visible.map((product) => ({
      label: product.name.slice(0, 100),
      value: product.id,
      description: `${product.price} coins · ${product.description || 'Palworld item'}`.slice(0, 100)
    }));

    const lines = visible.map((product) => `• **${product.name}** · ${product.price} coins`).join('\n');
    const components = [
      row({
        type: 3,
        custom_id: `shop:product:${index}:${page}`,
        placeholder: `Choose from ${category}`.slice(0, 150),
        min_values: 1,
        max_values: 1,
        options
      })
    ];

    const nav = [];
    if (pageCount > 1) {
      nav.push(
        button(`shop:products:${index}:${page - 1}`, '◀ Previous', C.SECONDARY, page <= 0),
        button(`shop:products:${index}:${page + 1}`, 'Next ▶', C.SECONDARY, page >= pageCount - 1)
      );
    }
    nav.push(button('shop:back', 'Categories', C.SECONDARY));
    components.push(row(...nav));

    return this.respond(i, {
      embeds: [embed({
        title: `🛒 ${category}`,
        description: `Wallet: **${wallet.balance} coins**\n\n${lines}`,
        fields: [
          { name: 'Products in category', value: String(entries.length), inline: true },
          { name: 'Page', value: `${page + 1}/${pageCount}`, inline: true }
        ],
        color: 0xFEE75C,
        footer: this.services.brand.footer
      })],
      components,
      ephemeral: true
    });
  }

  async openShopProduct(i, productId, categoryIndex = null, productPage = 0) {
    const product = this.services.shop.product(productId);
    if (!product) return this.respond(i, { content: 'Product no longer exists. Reopen `/shop`.', ephemeral: true });

    const wallet = this.services.shop.wallet(userId(i));
    const products = this.services.shop.catalog();
    const categories = this.shopCategories(products);
    let index = Number(categoryIndex);

    if (!Number.isInteger(index) || index < 0 || index >= categories.length || categories[index] !== (product.category || 'Other')) {
      index = categories.indexOf(product.category || 'Other');
    }

    const contents = product.type === 'items'
      ? product.items.map((item) => `• ${item.Count} × ${item.ItemID}`).join('\n')
      : (product.pals || []).map((pal) => `• ${pal.PalID} · Lv.${pal.Level}`).join('\n');

    const backButton = index >= 0
      ? button(`shop:products:${index}:${Math.max(0, Number(productPage) || 0)}`, 'Back', C.SECONDARY)
      : button('shop:back', 'Back', C.SECONDARY);

    return this.respond(i, {
      embeds: [embed({
        title: `🛒 ${product.name}`,
        description: `${product.description || 'Palworld shop item'}\n\n**Contents**\n${contents}`,
        fields: [
          { name: 'Category', value: product.category || 'Other', inline: true },
          { name: 'Price', value: `${product.price} coins`, inline: true },
          { name: 'Wallet', value: `${wallet.balance} coins`, inline: true }
        ],
        color: 0xFEE75C,
        footer: this.services.brand.footer
      })],
      components: [row(
        button(`shop:buy:${product.id}`, `Buy · ${product.price} coins`, C.SUCCESS, wallet.balance < product.price),
        backButton,
        button('shop:back', 'Categories', C.SECONDARY)
      )],
      ephemeral: true
    });
  }

  async openShopKits(i) {
    const kits = this.services.shop?.kitsCatalog?.() ?? [];
    const wallet = this.services.shop.wallet(userId(i));
    const description = kits.length
      ? kits.map((kit) => {
          const hours = kit.cooldownMs > 0 ? Math.round(kit.cooldownMs / 3_600_000) : 0;
          const cooldown = hours ? `${hours}h cooldown` : 'No cooldown';
          return `**${kit.name}** · \`${kit.id}\` · ${cooldown}\n${kit.description || 'Server kit'}`;
        }).join('\n\n')
      : 'No kits are currently configured.';

    return this.respond(i, {
      embeds: [embed({
        title: '🎁 Server kits',
        description: `Wallet: **${wallet.balance} coins**\n\n${description}\n\nClaim a kit with \`/kit <id>\`.`,
        color: 0x5865F2,
        footer: this.services.brand.footer
      })],
      components: [row(button('shop:back', 'Back to shop', C.SECONDARY))],
      ephemeral: true
    });
  }


  async openWhitelist(i, user = '') {
    const st = this.services.whitelist?.status?.() ?? { configured: false, enabled: false };
    if (!st.configured) return this.respond(i, { content: 'Whitelist integration is disabled. Enable `PALDEFENDER_WHITELIST_ENABLED=true` only when PalDefender RCON is available.', ephemeral: true });
    if (!st.enabled) return this.respond(i, { content: 'Whitelist is configured but unavailable: PalDefender whitelist management currently needs the configured RCON compatibility transport.', ephemeral: true });
    if (!user) {
      const out = await this.services.whitelist.list();
      return this.respond(i, { embeds: [embed({ title: '🧾 PalDefender whitelist', description: `\`\`\`${String(out.raw || 'No output').slice(0, 3500)}\`\`\``, footer: this.services.brand.footer })], ephemeral: true });
    }
    const id = String(user).trim();
    return this.respond(i, { content: `Whitelist action for \`${id}\`:`, components: [row(button(`whitelist:add:${id}`, 'Add', C.SUCCESS), button(`whitelist:remove:${id}`, 'Remove', C.DANGER))], ephemeral: true });
  }

  async startLink(i, query = '') {
    const id = userId(i), linked = this.services.links.status(id);
    if (!this.services.saveReader.enabled) {
      const l = this.services.links.create(id);
      return this.respond(i, { content: `${linked ? `Currently linked to **${linked.player_name || 'a character'}**.\n\n` : ''}Save verification is unavailable because the save-reader is not installed. Use this temporary code in Palworld chat: \`!link ${l.code}\``, ephemeral: true });
    }
    if (query) {
      try { return this.presentLinkChallenge(i, await this.services.links.createSaveClaim(id, query)); }
      catch (error) {
        if (error.message.includes('strong private save challenge')) {
          return this.respond(i, { content: '⚠️ I found the character, but the save does not contain enough private data to verify ownership yet. In Palworld, add at least one Pal to your party and keep one inventory stack with a non-zero count, then save the world. Run `/link` again after the next save sync.', ephemeral: true });
        }
        throw error;
      }
    }
    const doc = await this.services.saveReader.roster(), roster = (doc.roster ?? []).slice(0, 25);
    if (!roster.length) return this.respond(i, { content: 'No saved Palworld characters were found.', ephemeral: true });
    const options = roster.map((r) => ({ label: String(r.character?.nickname || r.playerUId).slice(0, 100), value: String(r.playerUId), description: `Lv.${r.character?.level ?? '?'}${r.guild?.name ? ` · ${r.guild.name}` : ''}`.slice(0, 100) }));
    return this.respond(i, { content: linked ? `🔗 Currently linked to **${linked.player_name || 'a character'}**. Choose a character below to relink.` : 'Choose your Palworld character:', components: [row({ type: 3, custom_id: 'link:select', placeholder: 'Select your Palworld character', min_values: 1, max_values: 1, options })], ephemeral: true });
  }

  presentLinkChallenge(i, claim) {
    const lines = claim.questions.map((q, n) => `**${n + 1}. ${q.question}**\n${q.options.map((v, k) => `\`${k + 1}\` ${v}`).join('   ')}`).join('\n\n');
    return this.respond(i, { content: `🎮 **Verify ${claim.playerName}**\n\n${lines}\n\nCheck these values in Palworld, then press **Answer**.`, components: [row(button('link:answer', 'Answer', C.PRIMARY))], ephemeral: true });
  }

  async handleComponent(i, actor) {
    const id = i.data?.custom_id;
    if (id === 'setup:credentials') return this.setupModal(i);
    if (id === 'setup:next') return this.completeSetup(i, actor);
    if (id === 'setup:link') return this.startLink(i);
    if (id === 'shop:category') {
      const categoryIndex = Number(i.data.values?.[0]);
      return this.openShopCategory(i, categoryIndex, 0);
    }
    if (id?.startsWith('shop:categories:')) {
      const page = Number(id.slice('shop:categories:'.length));
      return this.openShop(i, page);
    }
    if (id?.startsWith('shop:products:')) {
      const [, , categoryIndex, page] = id.split(':');
      return this.openShopCategory(i, Number(categoryIndex), Number(page));
    }
    if (id?.startsWith('shop:product:')) {
      const [, , categoryIndex, page] = id.split(':');
      const productId = i.data.values?.[0];
      return this.openShopProduct(i, productId, Number(categoryIndex), Number(page));
    }
    if (id === 'shop:kits') return this.openShopKits(i);

    // Compatibility with shop messages created before the category UI update.
    if (id === 'shop:select') {
      const productId = i.data.values?.[0];
      return this.openShopProduct(i, productId);
    }

    if (id?.startsWith('shop:buy:')) {
      const pid = id.slice('shop:buy:'.length);
      const out = await this.services.shop.purchase(userId(i), pid, actor);
      return this.respond(i, {
        embeds: [embed({
          title: '✅ Purchase delivered',
          description: `**${out.product.name}** was delivered to your linked character.`,
          fields: [{ name: 'Remaining balance', value: `${out.balance} coins`, inline: true }],
          color: 0x57F287,
          footer: this.services.brand.footer
        })],
        components: [row(button('shop:back', 'Back to shop', C.SECONDARY))],
        ephemeral: true
      });
    }
    if (id === 'shop:back') return this.openShop(i);
    if (id?.startsWith('whitelist:add:')) {
      const uid = id.slice('whitelist:add:'.length); await this.services.whitelist.add(uid, actor);
      return this.respond(i, { content: `✅ Added \`${uid}\` to the whitelist.`, ephemeral: true });
    }
    if (id?.startsWith('whitelist:remove:')) {
      const uid = id.slice('whitelist:remove:'.length); await this.services.whitelist.remove(uid, actor);
      return this.respond(i, { content: `✅ Removed \`${uid}\` from the whitelist.`, ephemeral: true });
    }
    if (id === 'link:select') {
      const uid = i.data.values?.[0], claim = await this.services.links.createSaveClaim(userId(i), uid);
      return this.presentLinkChallenge(i, claim);
    }
    if (id === 'link:answer') return this.modal(i, { customId: 'link:verify', title: 'Verify Palworld character', label: 'Answer numbers in order', placeholder: 'Example: 2-4-1' });
    if (id === 'server:backup') {
      const b = await this.services.backups.create(actor);
      return this.respond(i, { content: `✅ Backup created: \`${b.name}\``, ephemeral: true });
    }
    if (id === 'server:verify') return this.verifyServer(i);
    if (id === 'server:restart') {
      const out = await this.services.provider.restart('Restart requested from Discord');
      this.db.audit(actor, 'provider.restart', '', JSON.stringify(out));
      return this.respond(i, { content: '✅ Restart requested.', ephemeral: true });
    }
    if (id === 'server:refresh') return this.showServer(i);
    return this.respond(i, { content: '❌ This button is no longer valid.', ephemeral: true });
  }

  async handleModal(i, actor) {
    if (i.data?.custom_id === 'setup:credentials') {
      const values = Object.fromEntries(['rest_url', 'rest_password', 'ftp_host', 'ftp_user', 'ftp_password'].map((key) => [key, this.modalValue(i, key)]));
      this.applySetupCredentials(values);
      const check = await this.verifySetup();
      this.db.audit(actor, 'setup.credentials.saved', '', JSON.stringify({ restUrl: values.rest_url, ftpHost: values.ftp_host, ftpUser: values.ftp_user }));
      const lines = check.checks.map((item) => `${item.ok ? '✅' : '❌'} **${item.name}** · ${item.detail}`).join('\n');
      return this.respond(i, { embeds: [embed({ title: check.ok ? '✅ Connection verified' : '⚠️ Connection saved but not ready', description: `${lines}\n\n${check.ok ? 'Press **Next** to upload the bridge and create the Discord channels.' : 'Correct the connection details and submit again.'}`, color: check.ok ? 0x57F287 : 0xED4245, footer: this.services.brand.footer })], components: [row(button('setup:credentials', 'Edit connection', C.SECONDARY), button('setup:next', 'Next', C.SUCCESS, !check.ok))], ephemeral: true });
    }
    if (i.data?.custom_id === 'link:verify') {
      const linked = this.services.links.verifySaveClaim(userId(i), this.modalValue(i, 'answers'));
      if (!linked) return this.respond(i, { content: '❌ Incorrect answer or expired verification. Run `/link` and try again.', ephemeral: true });
      this.db.audit(actor, 'account.link.save', linked.player_uid ?? '', linked.player_name ?? '');
      return this.respond(i, { content: `✅ Discord is now linked to **${linked.player_name || 'your Palworld character'}**${linked.platform ? ` (${linked.platform})` : ''}.`, ephemeral: true });
    }
    return this.respond(i, { content: '❌ Unknown modal submission.', ephemeral: true });
  }

  async handleMessage(msg) {
    if (!this.cfg.bridgeEnabled || !this.cfg.chatChannelId || msg.author?.bot || msg.channel_id !== this.cfg.chatChannelId || !msg.content) return;
    const content = msg.content.trim();
    if (!content || content.startsWith('/')) return;
    const text = `[Discord] ${msg.author.global_name ?? msg.author.username}: ${content.slice(0, 400)}`;
    if (this.services.bridge?.enabled) {
      try { await this.services.bridge.announce(text); return; }
      catch (error) { this.logger.warn?.('[discord->game bridge]', error.message); }
    }
    if (this.services.palDefender?.enabled) await this.services.palDefender.broadcast(text);
    else await this.services.rest.announce(text);
  }

  async sendChannel(channelId, payload) {
    if (!this.enabled || !channelId) return;
    return this.api('POST', `/channels/${channelId}/messages`, payload);
  }
  channelSetting(name, fallback = '') { return this.db?.appSetting?.(`discord.channel.${name}`, fallback) || fallback; }
  sendChat(playerName, message) { return this.sendChannel(this.channelSetting('chat', this.cfg.chatChannelId), { embeds: [embed({ title: `💬 ${playerName}`, description: message, fields: [{ name: 'Palworld chat', value: 'Live server message', inline: true }], footer: this.services.brand.footer, color: 0x5865F2 })] }); }
  sendLog(title, description, color = 0xFEE75C) { const channel = /death|kill/i.test(title) ? this.channelSetting('killfeed', this.cfg.logChannelId) : /joined|left|player/i.test(title) ? this.channelSetting('playerfeed', this.cfg.logChannelId) : this.channelSetting('admin', this.cfg.logChannelId); return this.sendChannel(channel, { embeds: [embed({ title, description, fields: [{ name: 'PalControl event', value: new Date().toLocaleTimeString(), inline: true }], footer: this.services.brand.footer, color })] }); }
  async sendDm(uid, content) { const dm = await this.api('POST', '/users/@me/channels', { recipient_id: uid }); return this.sendChannel(dm.id, { content }); }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function normalizeRoleName(value) {
  return String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
