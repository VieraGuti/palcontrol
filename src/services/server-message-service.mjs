export class ServerMessageService {
  constructor({
    rest = null,
    bridge = null,
    db = null,
    poller = null,
    serverName = 'PalControl',
    logger = console,
    now = () => Date.now()
  } = {}) {
    this.rest = rest;
    this.bridge = bridge;
    this.db = db;
    this.poller = poller;
    this.serverName = serverName;
    this.logger = logger;
    this.now = now;
    this.schedulerLocked = false;
  }

  renderTemplate(template, values = {}) {
    return String(template ?? '').replace(/\{([^}]+)\}/g, (_, key) => {
      const normalized = String(key).trim();
      if (normalized in values) return String(values[normalized] ?? '');
      return '';
    });
  }

  async broadcast(message, context = {}) {
    const text = this.renderTemplate(String(message ?? ''), context);
    if (!text.trim()) throw new Error('Message content is empty.');

    if (this.rest && typeof this.rest.announce === 'function') {
      try {
        await this.rest.announce(text);
        return { transport: 'rest', message: text };
      } catch (error) {
        this.logger.warn?.('[server-message] rest broadcast failed, trying bridge:', error.message);
      }
    }

    if (this.bridge && this.bridge.enabled && typeof this.bridge.announce === 'function') {
      const response = await this.bridge.announce(text);
      return { transport: 'bridge', message: text, response };
    }

    throw new Error('No working message transport is available.');
  }

  async sendToPlayer(player, message, context = {}) {
    const text = this.renderTemplate(String(message ?? ''), { ...context, player: player ?? context.player ?? '' });
    if (!text.trim()) throw new Error('Player message content is empty.');
    if (this.bridge && this.bridge.enabled && typeof this.bridge.personalMessage === 'function') {
      const response = await this.bridge.personalMessage({ playerName: String(player ?? ''), userId: String(player ?? ''), message: text });
      return { transport: 'bridge', message: text, response };
    }
    if (this.rest && typeof this.rest.announce === 'function') {
      await this.rest.announce(text);
      return { transport: 'rest', message: text };
    }
    throw new Error('No working personal message transport is available.');
  }

  async sendWelcome(player, options = {}) {
    const state = this.poller?.snapshot?.() ?? { players: [], metrics: {} };
    const online = Number(state.metrics?.currentplayernum ?? state.players?.length ?? 0);
    const maxPlayers = Number(state.metrics?.maxplayernum ?? 0);
    const template = options.message || this.db?.appSetting?.('welcome_message', '') || 'Welcome {player} to {server}! Use !kit starter and join {discord}.';
    const message = this.renderTemplate(template, {
      player: String(player ?? ''),
      server: this.serverName,
      online,
      maxPlayers,
      discord: options.discord || 'our Discord',
      time: new Date(this.now()).toLocaleTimeString()
    });
    return this.sendToPlayer(player, message);
  }

  setWelcomeMessage(message) {
    const text = String(message ?? '').trim();
    if (!text) throw new Error('Welcome message cannot be empty.');
    this.db?.setAppSetting?.('welcome_message', text);
    return text;
  }

  getWelcomeMessage() {
    return this.db?.appSetting?.('welcome_message', '') || 'Welcome {player} to {server}! Use !kit starter and join {discord}.';
  }

  scheduleMessage(message, { intervalMinutes = 15, enabled = true } = {}) {
    if (!this.db || !this.db.addScheduledMessage) throw new Error('Scheduled messages require a database.');
    const now = this.now();
    const id = this.db.addScheduledMessage({
      message: String(message ?? '').trim(),
      intervalMinutes: Math.max(5, Number(intervalMinutes) || 15),
      enabled: Boolean(enabled),
      createdAt: now,
      nextRunAt: now + (Math.max(5, Number(intervalMinutes) || 15) * 60_000)
    });
    return Number(id);
  }

  async processScheduled() {
    if (!this.db || !this.db.nextScheduledMessages || this.schedulerLocked) return [];
    this.schedulerLocked = true;
    try {
      const due = this.db.nextScheduledMessages(this.now());
      const results = [];
      for (const msg of due) {
        try {
          await this.broadcast(msg.message, {
            player: '',
            server: this.serverName,
            online: this.poller?.snapshot?.().metrics?.currentplayernum ?? 0,
            maxPlayers: this.poller?.snapshot?.().metrics?.maxplayernum ?? 0,
            discord: 'our Discord'
          });
          const nextRunAt = this.now() + (Math.max(5, Number(msg.interval_minutes) || 15) * 60_000);
          this.db.markScheduledRun(msg.id, { nextRunAt, lastRunAt: this.now(), error: null });
          results.push({ id: msg.id, ok: true, nextRunAt });
        } catch (error) {
          this.logger.warn?.('[scheduler]', error.message);
          this.db.markScheduledRun(msg.id, { nextRunAt: Number(msg.next_run_at) || this.now(), lastRunAt: this.now(), error: error.message });
          results.push({ id: msg.id, ok: false, error: error.message });
        }
      }
      return results;
    } finally {
      this.schedulerLocked = false;
    }
  }
}
