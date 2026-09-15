import { EventEmitter } from 'node:events';

export class ServerPoller extends EventEmitter {
  constructor({ client, db, intervalMs = 10000, positionSampleMs = 30000, gameDataEnabled = true, logger = console }) {
    super();
    this.client = client; this.db = db; this.intervalMs = intervalMs; this.positionSampleMs = positionSampleMs; this.gameDataEnabled = gameDataEnabled; this.logger = logger;
    this.timer = null; this.running = false; this.lastPositionSample = 0; this.externalActors = [];
    this.state = { online: false, info: null, metrics: null, players: [], gameData: null, lastOkAt: 0, lastError: null, consecutiveFailures: 0 };
  }

  start() { if (this.timer) return; this.tick(); this.timer = setInterval(() => this.tick(), this.intervalMs); }
  stop() { clearInterval(this.timer); this.timer = null; }

  ingestExternalActors(actors, now = Date.now()) {
    this.externalActors = actors;
    this.externalActorsAt = now;
    const positions = actors
      .filter(a => a.unitType === 'Player' && a.userId && Number.isFinite(a.x) && Number.isFinite(a.y))
      .map(a => ({ userId: a.userId, x: a.x, y: a.y, z: a.z, guildId: a.guildId, guildName: a.guildName, level: a.level }))
      // Bridge snapshots can arrive before the first REST /players sync and may
      // temporarily contain Palworld-side placeholder/player UIDs. positions.user_id
      // is FK-bound to players.user_id, so only persist samples once the official
      // REST identity is present in the players table. The actor still remains live
      // in the dashboard even when this DB sample is skipped.
      .filter(a => Boolean(this.db.player(a.userId)));
    this.db.recordPositions(positions, now);
    this.emit('state', this.snapshot());
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const now = Date.now();
    try {
      const [info, metrics, playerPayload] = await Promise.all([this.client.info(), this.client.metrics(), this.client.players()]);
      const players = Array.isArray(playerPayload?.players) ? playerPayload.players : [];
      const transitions = this.db.syncPlayers(players, now);
      this.db.recordMetrics(metrics, now);
      let gameData = this.state.gameData;
      if (this.gameDataEnabled && now - this.lastPositionSample >= this.positionSampleMs) {
        try {
          gameData = await this.client.gameData();
          this.lastPositionSample = now;
          const actors = (gameData?.ActorData ?? []).filter(a => a?.Type === 'Character' && a?.UnitType === 'Player' && a?.userid && Number.isFinite(a.LocationX) && Number.isFinite(a.LocationY)).map(a => ({
            userId: a.userid, x: a.LocationX, y: a.LocationY, z: a.LocationZ, guildId: a.GuildID, guildName: a.GuildName, level: a.level
          }));
          this.db.recordPositions(actors, now);
        } catch (err) {
          this.logger.warn?.('[game-data]', err.message);
        }
      }
      this.state = { online: true, info, metrics, players, gameData, lastOkAt: now, lastError: null, consecutiveFailures: 0 };
      for (const id of transitions.joined) this.emit('player:joined', { userId: id, player: players.find(p => p.userId === id) });
      for (const id of transitions.left) this.emit('player:left', { userId: id });
      this.emit('state', this.snapshot());
    } catch (err) {
      this.state.online = false;
      this.state.lastError = err.message;
      this.state.consecutiveFailures += 1;
      this.emit('failure', { error: err, consecutiveFailures: this.state.consecutiveFailures });
      this.emit('state', this.snapshot());
    } finally { this.running = false; }
  }

  snapshot() {
    const { gameData, ...safe } = this.state;
    const externalFresh = this.externalActorsAt && Date.now() - this.externalActorsAt <= 90_000;
    return { ...safe, actors: gameData?.ActorData?.length ? gameData.ActorData : (externalFresh ? this.externalActors : []), externalActorsAt: this.externalActorsAt ?? 0 };
  }
}
