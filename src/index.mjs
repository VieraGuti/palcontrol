import path from 'node:path';
import { PALCONTROL_VERSION } from './version.mjs';
import { config, validateConfig } from './config.mjs';
import { PalworldRestClient } from './palworld/rest-client.mjs';
import { SourceRconClient } from './palworld/rcon-client.mjs';
import { PalDatabase } from './db.mjs';
import { ServerPoller } from './services/poller.mjs';
import { BackupService } from './services/backup-service.mjs';
import { Watchdog } from './services/watchdog.mjs';
import { PalDefenderTailer } from './services/chat-tailer.mjs';
import { LinkService } from './services/link-service.mjs';
import { SaveReaderService } from './services/save-reader.mjs';
import { FtpFileStore, SaveSource } from './services/remote-files.mjs';
import { LocalProvider, PassiveProvider } from './providers/provider.mjs';
import { NitradoClient } from './providers/nitrado.mjs';
import { DiscordClient } from './discord/client.mjs';
import { PalHttpServer } from './http/server.mjs';
import { PalDefenderClient } from './paldefender/client.mjs';
import { WhitelistService } from './services/whitelist-service.mjs';
import { ShopService } from './services/shop-service.mjs';
import { ActorBridge } from './services/actor-bridge.mjs';
import { Ue4ssBridge } from './services/ue4ss-bridge.mjs';
import { ServerDiscoveryService } from './services/server-discovery.mjs';
import { PalworldItemService, loadDefaultItemCatalog } from './services/palworld-item-service.mjs';
import { ServerMessageService } from './services/server-message-service.mjs';

for (const w of validateConfig()) console.warn('[config]', w);
const db = new PalDatabase(config.databasePath);
const rest = new PalworldRestClient({ baseUrl:config.palworld.restUrl, username:config.palworld.username, password:config.palworld.password, timeoutMs:config.palworld.timeoutMs });
const rcon = new SourceRconClient({ host:config.palworld.rconHost, port:config.palworld.rconPort, password:config.palworld.rconPassword, timeoutMs:config.palworld.rconTimeoutMs });

let provider;
if (config.provider.type === 'nitrado') provider = new NitradoClient(config.provider.nitrado);
else if (config.provider.type === 'local') provider = new LocalProvider(config.provider.local);
else provider = new PassiveProvider(config.provider.type);

let remoteStore = null;
if (config.provider.type === 'nitrado' && provider.enabled) remoteStore = provider;
else if (config.remoteFiles.ftp.host) remoteStore = new FtpFileStore(config.remoteFiles.ftp);

const savedRestUrl = db.appSetting('setup.rest_url', '');
if (savedRestUrl) {
  rest.baseUrl = `${savedRestUrl.replace(/\/$/, '')}/v1/api`;
  rest.password = db.appSetting('setup.rest_password', rest.password);
}
if (remoteStore?.type === 'ftp') {
  remoteStore.host = db.appSetting('setup.ftp_host', remoteStore.host);
  remoteStore.port = Number(db.appSetting('setup.ftp_port', String(remoteStore.port)) || remoteStore.port);
  remoteStore.user = db.appSetting('setup.ftp_user', remoteStore.user);
  remoteStore.password = db.appSetting('setup.ftp_password', remoteStore.password);
}

const saveSource = new SaveSource({
  localPath: config.palworld.savePath,
  remoteStore,
  remoteSavePath: config.remoteFiles.savePath,
  remoteLogPath: config.remoteFiles.logPath,
  cacheDir: config.remoteFiles.cacheDir
});

const poller = new ServerPoller({ client:rest, db, intervalMs:config.pollIntervalMs, positionSampleMs:config.positionSampleMs, gameDataEnabled:config.palworld.gameDataEnabled });
const saveReader = new SaveReaderService({ enabled:config.saveReader.enabled, bin:config.saveReader.bin, savesPath:saveSource.localSavePath, timeoutMs:config.saveReader.timeoutMs, beforeRead:saveSource.remote?()=>saveSource.syncSaves():null });
const backups = new BackupService({ client:rest, saveSource, backupDir:config.backups.dir, retention:config.backups.retention, allowRestore:config.backups.allowRestore, provider, db });
const watchdog = new Watchdog({ ...config.watchdog, provider, db });
const links = new LinkService({ db, saveReader, rest });
const palDefender = new PalDefenderClient(config.palDefender);
const whitelist = new WhitelistService({ rcon, enabled:config.palDefender.whitelistEnabled, db });
const bridge = new Ue4ssBridge({ remoteStore, remoteDir:config.ue4ssBridge.remoteDir, cacheDir:'./data/remote-cache/ue4ss-bridge', poller, intervalMs:config.ue4ssBridge.pollIntervalMs, worldIntervalMs:config.ue4ssBridge.worldIntervalMs, commandTimeoutMs:config.ue4ssBridge.commandTimeoutMs, spawnEnabled:config.ue4ssBridge.spawnEnabled });
// Explicitly disable the bridge client unless UE4SS_BRIDGE_ENABLED=true.
if (!config.ue4ssBridge.enabled) bridge.remoteDir = '';
const serverDiscovery = new ServerDiscoveryService({
  bridgeRoot: path.resolve('./mods/PalControlBridge'),
  logger: console
});
const itemService = new PalworldItemService({
  bridge,
  db,
  itemCatalog: loadDefaultItemCatalog('./config'),
  kits: [],
  logger: console
});
const shop = new ShopService({ enabled:config.shop.enabled, catalogPath:config.shop.catalogPath, bridge, palDefender, rcon, db, playtimeCoinsPerHour:config.shop.playtimeCoinsPerHour, vipPlaytimeCoinsPerHour:config.shop.vipPlaytimeCoinsPerHour, killReward:config.shop.killReward });
const actorBridge = new ActorBridge({ remoteStore, remotePath:config.palworld.remoteActorPath, localPath:'./data/remote-cache/actors.json', poller, intervalMs:config.mapBridgePollMs });
const serverMessageService = new ServerMessageService({ rest, bridge, db, poller, serverName:config.brand.name, logger:console });
const services = { rest, rcon, poller, backups, watchdog, saveReader, links, provider, remoteStore, saveSource, palDefender, whitelist, bridge, itemService, shop, actorBridge, serverDiscovery, serverMessageService, brand:config.brand, publicBaseUrl:config.publicBaseUrl, config };
const discord = new DiscordClient({ config:config.discord, services, db }); services.discord=discord;
const web = new PalHttpServer({ config, services, db }); services.web=web;
bridge.on('tick', () => web.push('state', { ...web.safeState(), actors: undefined }));
const runtimeAlerts = new Map();
const alertRuntime = (key, active, message) => {
  const previous = runtimeAlerts.get(key) ?? false;
  if (previous === active) return;
  runtimeAlerts.set(key, active);
  discord.sendLog(active ? '⚠️ PalControl alert' : '✅ PalControl recovered', message, active ? 0xED4245 : 0x57F287).catch(() => {});
};
bridge.on('tick', ({ ok, heartbeat }) => {
  const heartbeatAt = Date.parse(heartbeat?.timestamp ?? '');
  const stale = !ok || !Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > 30_000;
  alertRuntime('bridge', stale, stale ? 'UE4SS bridge heartbeat is stale or command polling failed.' : 'UE4SS bridge heartbeat and polling are healthy again.');
});

const chatLogDir = config.chat.logDir || saveSource.localLogPath;

await web.start();

const resolveLiveUserId = (playerName, fallback = '') => {
  const q = String(playerName ?? '').trim().toLowerCase();
  const live = (poller.snapshot().players ?? []).find(p => String(p?.name ?? '').trim().toLowerCase() === q);
  return live?.userId ?? fallback;
};

const handleChat = async ({ playerName, userId: bridgeUserId = '', message }) => {
  const text = String(message ?? '').trim();
  if (!text) return;
  const linkMatch = text.match(/^[!/]link\s+([A-Z0-9]+)/i);
  if (linkMatch) {
    const userId = resolveLiveUserId(playerName, bridgeUserId);
    if (!userId) {
      console.warn(`[link] Could not resolve user id for ${playerName}`);
      if (bridge.enabled) await bridge.personalMessage({ playerName, message:'Link failed: player identity could not be resolved.' }).catch(()=>{});
      return;
    }
    const discordId = links.consume(linkMatch[1].toUpperCase(), userId, playerName);
    if (discordId) {
      db.audit(`palworld:${userId}`, 'account.link.chat', discordId, playerName);
      await bridge.personalMessage({ playerName, userId, message:'Discord account linked successfully.' }).catch(()=>{});
      await discord.sendDm(discordId, `✅ Linked to **${playerName}**.`);
      await discord.sendLog('🔗 Account linked', `**${playerName}** linked to <@${discordId}>.`, 0x57F287);
    } else if (bridge.enabled) {
      await bridge.personalMessage({ playerName, userId, message:'Link code invalid or expired. Generate a new code with /link in Discord.' }).catch(()=>{});
    }
    return;
  }
  const commandMatch = text.match(/^[!/]([a-z0-9_-]+)(?:\s+(.*))?$/i);
  if (commandMatch) {
    const command = commandMatch[1].toLowerCase();
    const args = (commandMatch[2] ?? '').trim().split(/\s+/).filter(Boolean);
    if (command !== 'kit') return;
    const requestedKit = args[0] ?? 'start';
    // Bridge PlayerUId is authoritative for the current game session. If REST has
    // a platform id for this name, prefer it for existing Discord-link reconciliation.
    const userId = resolveLiveUserId(playerName, bridgeUserId) || bridgeUserId || playerName;
    const tellPlayer = async(message) => {
      if (bridge.enabled) { try { await bridge.personalMessage({ playerName, userId, message }); return; } catch(error) { console.warn('[kit feedback/bridge]', error.message); } }
      if (palDefender.enabled && userId) { try { await palDefender.sendPlayerMessage(userId, message, 'PlayerLogImportant'); } catch(error) { console.warn('[kit feedback]', error.message); } }
    };
    const kit = shop.kit(requestedKit);
    if (!kit) {
      await tellPlayer(`Kit not found: ${requestedKit}.`);
      return;
    }
    const link = bridgeUserId ? (db.linkForUser(userId) ?? db.linkForUser(bridgeUserId)) : db.linkForUser(userId);
    // Free/public kits are game-account scoped and do NOT require Discord.
    // Discord is only mandatory when the kit itself has a Discord role gate.
    if (kit.role && !link?.discord_id) {
      console.warn(`[kit] ${playerName}/${kit.id} requires Discord role ${kit.role} but has no Discord link`);
      await tellPlayer(`Kit ${kit.id} requires Discord role ${kit.role}. Link Discord first with !link CODE or /link.`);
      return;
    }
    try {
      const discordId = link?.discord_id ?? '';
      const result = await shop.claimKit({ playerUserId:userId, playerName, discordId, kitId:requestedKit, hasRole:(id,role)=>id ? discord.hasGuildRole(id,role) : false });
      await tellPlayer(`You claimed the ${result.kit.name} kit.`);
      if (discordId) await discord.sendDm(discordId, `✅ Kit **${result.kit.name}** delivered to **${playerName}**.`).catch(error=>console.warn('[kit dm]',error.message));
      await discord.sendLog('🎁 Kit delivered', `**${result.kit.name}** → **${playerName}**${discordId ? ` (<@${discordId}>)` : ''}.`, 0x57F287).catch(error=>console.warn('[kit log]',error.message));
      db.audit(`palworld:${userId}`, 'kit.claim', result.kit.id, `discord=${discordId || 'unlinked'}`);
    } catch(error) {
      console.warn(`[kit] ${playerName}/${requestedKit}: ${error.message}`);
      await tellPlayer(`Kit not delivered: ${error.message}`);
      if (link?.discord_id) await discord.sendDm(link.discord_id, `⚠️ Kit **${requestedKit}** was not delivered: ${error.message}`).catch(()=>{});
    }
    return;
  }
  await discord.sendChat(playerName, text);
};

if (bridge.enabled) {
  bridge.on('chat', event => handleChat({ playerName:event.playerName, userId:event.userId, message:event.message }).catch(err=>console.warn('[bridge-chat]',err.message)));
  bridge.on('death', event => {
    const name = event.kind === 'player' ? (event.playerName || 'Unknown player') : (event.class || event.fullName || 'Unknown character');
    const detail = event.kind === 'player' ? `**${name}** died in the world.\n\nThe event was captured live by PalControlBridge.` : `A wild character died: **${name}**.`;
    discord.sendLog('💀 Player death', detail, 0xED4245).catch(()=>{});
  });
}

const tailer = new PalDefenderTailer({
  logDir:chatLogDir,
  intervalMs:config.chat.pollIntervalMs,
  beforeTick:saveSource.localLogPath?()=>saveSource.syncLogs():null,
  onChat:async({playerName,message})=>handleChat({playerName,message}),
  onLink:async({playerName,userId,code})=>{
    if (bridge.enabled) return; // avoid duplicate processing when UE4SS chat capture is active
    const discordId=links.consume(code,userId,playerName);
    if(discordId){db.audit(`palworld:${userId}`,'account.link.chat',discordId,playerName);await discord.sendDm(discordId,`✅ Linked to **${playerName}**.`);await discord.sendLog('🔗 Account linked',`**${playerName}** linked to <@${discordId}>.`,0x57F287);}
  },
  onCommand:async({playerName,userId,command,args})=>{
    if (bridge.enabled || command!=='kit') return;
    await handleChat({ playerName, message:`!kit ${args[0]??'start'}` });
  }
});

const saveReaderProbe = await saveReader.probe();
if (config.saveReader.enabled && !saveReaderProbe.ready) console.warn('[save-reader]', saveReaderProbe.reason);
else if (saveReaderProbe.ready) console.log(`[save-reader] ready ${saveReaderProbe.version}`);

poller.on('state',state=>{
  discord.updatePresence(state);
  shop.syncPlaytimeRewards((discordId, role) => discord.hasGuildRole(discordId, role)).then(rewards=>{ for (const reward of rewards) { db.audit('system','economy.playtime',reward.discordId,JSON.stringify(reward)); discord.sendDm(reward.discordId,`💰 You received **${reward.coins} points** for ${reward.hours} hour(s) of playtime.`).catch(error=>console.warn('[economy-dm]',error.message)); } }).catch(err=>console.warn('[economy]',err.message));
  web.push('state',{...state,actors:undefined});
});
poller.on('failure',ev=>watchdog.onFailure(ev));
poller.on('failure', ev => alertRuntime('rest', true, `Palworld REST is failing: ${ev.error?.message ?? 'unknown error'}`));
poller.on('state', state => { if (state.online) alertRuntime('rest', false, 'Palworld REST is responding again.'); });
poller.on('player:joined',({player})=>discord.sendLog('🟢 Player joined',`**${player?.name??'Unknown'}** joined the server.`,0x57F287));
poller.on('player:joined',({player})=>serverMessageService.sendWelcome(player?.name ?? 'Unknown').catch(error=>console.warn('[welcome]',error.message)));
poller.on('player:left',({userId})=>{const p=db.player(userId);discord.sendLog('⚫ Player left',`**${p?.name??userId}** left the server.`,0x99AAB5);});

poller.start();
if (bridge.enabled) bridge.start();
else actorBridge.start();
if (!bridge.enabled) tailer.start();
await discord.start();
const schedulerTimer = setInterval(() => serverMessageService.processScheduled().catch(error => console.warn('[scheduler]', error.message)), 15_000);
let pdStatus='disabled'; if(config.palDefender.enabled){try{const v=await palDefender.version();pdStatus=`ready:${v?.Version??v?.version??'unknown'}`;}catch(err){pdStatus=`unavailable:${err.message}`;console.warn('[paldefender-api]',err.message);}}
const shopStatus=shop.status();
const bridgeProbe=bridge.enabled?await bridge.probe():{ready:false,reason:'disabled'};
const shopProbe=shop.enabled?await shop.probeDelivery():{ready:false,transport:null,reason:'disabled'};
const shopRuntimeStatus=!shop.enabled?'disabled':shopProbe.ready?`READY:${shopProbe.transport}`:`DEGRADED:${shopProbe.reason}`;
console.log(`[core] PalControl v${PALCONTROL_VERSION} started. Provider=${provider.type} Backups=${backups.enabled?'enabled':'disabled'} SaveReader=${saveReaderProbe.ready?'ready':'disabled/unavailable'} UE4SSBridge=${bridge.enabled?(bridgeProbe.ready?`ready:${bridgeProbe.version??'unknown'}`:`DEGRADED:${bridgeProbe.reason}`):'disabled'} PalDefender=${pdStatus} Shop=${shopRuntimeStatus} Chat=${bridge.enabled?(bridgeProbe.ready?'ready:ue4ss':'DEGRADED:ue4ss'):(tailer.enabled?'ready:paldefender-log':'DEGRADED:no-log-source')} Discord=${discord.enabled?'enabled':'disabled'} Watchdog=${config.watchdog.enabled?'enabled':'disabled'}`);
if(shop.enabled&&!shopProbe.ready)console.warn(`[readiness] Shop/kits delivery is configured but not live-verified: ${shopProbe.reason}`);
if(shop.enabled&&!bridge.enabled&&!tailer.enabled)console.warn('[readiness] In-game !kit commands cannot be detected: enable UE4SS bridge or configure a PalDefender log source.');

async function shutdown(signal){console.log(`[core] ${signal}: shutting down`);clearInterval(schedulerTimer);poller.stop();bridge.stop();actorBridge.stop();tailer.stop();discord.stop();await web.stop();db.close();process.exit(0);}
process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
