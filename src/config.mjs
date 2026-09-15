import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = '.env') {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) return;
  for (const raw of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const str = (key, fallback = '') => process.env[key] ?? fallback;
const int = (key, fallback) => { const n = Number.parseInt(process.env[key] ?? '', 10); return Number.isFinite(n) ? n : fallback; };
const bool = (key, fallback = false) => { const v = process.env[key]; if (v == null || v === '') return fallback; return ['1','true','yes','on'].includes(v.toLowerCase()); };
const abs = (value, fallback = '') => value ? path.resolve(value) : fallback;
const providerType = str('SERVER_PROVIDER', 'local').trim().toLowerCase();
const cacheDir = path.resolve(str('REMOTE_CACHE_DIR', './data/remote-cache'));
const palworldAdminPassword = str('PALWORLD_ADMIN_PASSWORD');

function bundledSaveReaderBin() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32' && arch === 'x64') return path.resolve('tools/palworld-save-reader-v0.2.0-windows-amd64/palworld-save-reader-windows-amd64.exe');
  if (platform === 'linux' && arch === 'x64') return path.resolve('tools/palworld-save-reader-v0.2.0-linux-amd64/palworld-save-reader-linux-amd64');
  return 'palworld-save-reader';
}

export const config = Object.freeze({
  host: str('PALCONTROL_HOST', '0.0.0.0'),
  port: int('PALCONTROL_PORT', 8787),
  panelPassword: str('PANEL_PASSWORD', 'change-me-now'),
  sessionSecret: str('SESSION_SECRET', 'dev-only-change-me'),
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${int('PALCONTROL_PORT',8787)}`).replace(/\/$/, ''),
  publicBaseUrlConfigured: Boolean(str('PUBLIC_BASE_URL').trim()),
  databasePath: path.resolve(str('DATABASE_PATH', './data/palcontrol.sqlite')),
  pollIntervalMs: int('POLL_INTERVAL_MS', 10_000),
  positionSampleMs: int('POSITION_SAMPLE_MS', 30_000),
  mapIngestToken: str('MAP_INGEST_TOKEN'),
  mapBridgePollMs: int('MAP_BRIDGE_POLL_MS', 10_000),
  palworld: {
    restUrl: str('PALWORLD_REST_URL', 'http://127.0.0.1:8212').replace(/\/$/, ''),
    username: str('PALWORLD_REST_USERNAME', 'admin'),
    password: palworldAdminPassword,
    timeoutMs: int('PALWORLD_REST_TIMEOUT_MS', 8_000),
    gameDataEnabled: bool('PALWORLD_GAME_DATA_ENABLED', true),
    rconHost: str('PALWORLD_RCON_HOST', '127.0.0.1'),
    rconPort: int('PALWORLD_RCON_PORT', 25575),
    rconTimeoutMs: int('PALWORLD_RCON_TIMEOUT_MS', 8_000),
    // Palworld RCON authenticates with the same AdminPassword. An explicit
    // PALWORLD_RCON_PASSWORD can still override it for unusual host setups.
    rconPassword: str('PALWORLD_RCON_PASSWORD') || palworldAdminPassword,
    savePath: abs(str('PALWORLD_SAVE_PATH')),
    remoteActorPath: str('PALWORLD_REMOTE_ACTOR_PATH'),
    mapImageUrl: str('PALWORLD_MAP_IMAGE_URL', 'https://raw.githubusercontent.com/LukeHollandDev/palworld-live-map/main/assets/palworld/maps/palpagos.jpg'),
    mapBounds: str('PALWORLD_MAP_BOUNDS', '349400,724400,-1099400,-724400').split(',').map(Number)
  },
  provider: {
    type: providerType,
    local: {
      startCommand: str('PALWORLD_START_COMMAND'),
      stopCommand: str('PALWORLD_STOP_COMMAND'),
      restartCommand: str('PALWORLD_RESTART_COMMAND')
    },
    nitrado: {
      token: str('NITRADO_TOKEN'),
      serviceId: str('NITRADO_SERVICE_ID'),
      baseUrl: str('NITRADO_API_URL', 'https://api.nitrado.net')
    }
  },
  remoteFiles: {
    cacheDir,
    savePath: str('PALWORLD_REMOTE_SAVE_PATH'),
    logPath: str('PALDEFENDER_REMOTE_LOG_PATH'),
    ftp: {
      host: str('FTP_HOST'),
      port: int('FTP_PORT', 21),
      user: str('FTP_USER'),
      password: str('FTP_PASSWORD'),
      secure: bool('FTP_SECURE', false)
    }
  },
  ue4ssBridge: {
    enabled: bool('UE4SS_BRIDGE_ENABLED', false),
    remoteDir: str('UE4SS_BRIDGE_REMOTE_DIR', '/Pal/Binaries/Win64/ue4ss/Mods/PalControlBridge/data').replace(/\/$/, ''),
    pollIntervalMs: int('UE4SS_BRIDGE_POLL_MS', 6_000),
    worldIntervalMs: int('UE4SS_BRIDGE_WORLD_POLL_MS', 15_000),
    commandTimeoutMs: int('UE4SS_BRIDGE_COMMAND_TIMEOUT_MS', 12_000),
    spawnEnabled: bool('UE4SS_BRIDGE_SPAWN_ENABLED', false)
  },
  saveReader: {
    enabled: bool('SAVE_READER_ENABLED', false),
    bin: str('SAVE_READER_BIN').trim() || bundledSaveReaderBin(),
    timeoutMs: int('SAVE_READER_TIMEOUT_MS', 30_000)
  },
  backups: {
    dir: path.resolve(str('BACKUP_DIR', './backups')),
    retention: int('BACKUP_RETENTION', 48),
    allowRestore: bool('BACKUP_ALLOW_RESTORE', true)
  },
  watchdog: {
    enabled: bool('WATCHDOG_ENABLED', false),
    failuresBeforeRestart: int('WATCHDOG_FAILURES_BEFORE_RESTART', 3),
    cooldownMs: int('WATCHDOG_COOLDOWN_MS', 120_000)
  },
  chat: {
    logDir: abs(str('PALDEFENDER_LOG_DIR')),
    pollIntervalMs: int('CHAT_POLL_INTERVAL_MS', 3_000)
  },
  palDefender: {
    enabled: bool('PALDEFENDER_API_ENABLED', false),
    baseUrl: str('PALDEFENDER_API_URL', 'http://127.0.0.1:17993').replace(/\/$/, ''),
    token: str('PALDEFENDER_API_TOKEN'),
    timeoutMs: int('PALDEFENDER_API_TIMEOUT_MS', 8_000),
    whitelistEnabled: bool('PALDEFENDER_WHITELIST_ENABLED', false)
  },
  shop: {
    enabled: bool('SHOP_ENABLED', false),
    catalogPath: path.resolve(str('SHOP_CATALOG_PATH', './config/shop.json')),
    playtimeCoinsPerHour: int('SHOP_PLAYTIME_COINS_PER_HOUR', 100),
    vipPlaytimeCoinsPerHour: int('SHOP_VIP_PLAYTIME_COINS_PER_HOUR', 200),
    killReward: int('SHOP_KILL_REWARD', 25)
  },
  discord: {
    token: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID'),
    chatChannelId: str('DISCORD_CHAT_CHANNEL_ID'),
    logChannelId: str('DISCORD_LOG_CHANNEL_ID'),
    registerCommands: bool('DISCORD_REGISTER_COMMANDS', true),
    bridgeEnabled: bool('DISCORD_BRIDGE_ENABLED', true)
  },
  brand: {
    name: str('BRAND_NAME', 'PalControl'),
    footer: str('BRAND_FOOTER', 'PalControl • Palworld Server Control'),
    iconUrl: str('BRAND_ICON_URL')
  }
});

export function validateConfig() {
  const warnings = [];
  if (!config.palworld.password) warnings.push('PALWORLD_ADMIN_PASSWORD is empty; Palworld REST calls will fail authentication.');
  if (config.panelPassword === 'change-me-now') warnings.push('PANEL_PASSWORD is still the default.');
  if (config.sessionSecret === 'dev-only-change-me') warnings.push('SESSION_SECRET is still the default.');
  if (!['local','nitrado','gportal','generic'].includes(config.provider.type)) warnings.push(`Unknown SERVER_PROVIDER=${config.provider.type}; generic behavior will be used.`);
  if (config.provider.type === 'nitrado' && (!config.provider.nitrado.token || !config.provider.nitrado.serviceId)) warnings.push('SERVER_PROVIDER=nitrado requires NITRADO_TOKEN and NITRADO_SERVICE_ID for provider actions.');
  if (config.provider.type === 'gportal' && !config.remoteFiles.ftp.host && !config.palworld.savePath) warnings.push('G-Portal remote saves require FTP_HOST/FTP_USER/FTP_PASSWORD and PALWORLD_REMOTE_SAVE_PATH.');
  if (config.saveReader.enabled && !config.palworld.savePath && !config.remoteFiles.savePath) warnings.push('SAVE_READER_ENABLED=true but neither PALWORLD_SAVE_PATH nor PALWORLD_REMOTE_SAVE_PATH is configured.');
  if (config.ue4ssBridge.enabled && !config.remoteFiles.ftp.host && config.provider.type !== 'nitrado') warnings.push('UE4SS_BRIDGE_ENABLED=true requires FTP access on G-Portal/generic hosting.');
  if (config.palDefender.enabled && !config.palDefender.token) warnings.push('PALDEFENDER_API_ENABLED=true requires PALDEFENDER_API_TOKEN.');
  if (config.palDefender.whitelistEnabled && !config.palworld.rconPassword) warnings.push('PALDEFENDER_WHITELIST_ENABLED=true currently requires PALWORLD_RCON_PASSWORD because PalDefender documents whitelist management as RCON commands.');
  if (config.shop.enabled && !config.ue4ssBridge.enabled && !config.palDefender.enabled && !config.palworld.rconPassword) warnings.push('SHOP_ENABLED=true needs UE4SS bridge, PalDefender REST, or PalDefender-compatible RCON delivery.');
  if (config.shop.enabled && !config.ue4ssBridge.enabled && !config.chat.logDir && !config.remoteFiles.logPath) warnings.push('In-game !kit commands need UE4SS_BRIDGE_ENABLED=true or a PalDefender chat-log source.');
  if (config.watchdog.enabled && config.provider.type === 'gportal') warnings.push('G-Portal has no documented public restart API configured; watchdog will stay passive unless provider restart becomes available.');
  return warnings;
}
