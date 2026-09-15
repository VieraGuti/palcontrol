import { PALCONTROL_VERSION } from '../src/version.mjs';
import { config, validateConfig } from '../src/config.mjs';
import { PalworldRestClient } from '../src/palworld/rest-client.mjs';
import { LocalProvider, PassiveProvider } from '../src/providers/provider.mjs';
import { NitradoClient } from '../src/providers/nitrado.mjs';
import { FtpFileStore, SaveSource } from '../src/services/remote-files.mjs';
import { SaveReaderService } from '../src/services/save-reader.mjs';
import { Ue4ssBridge } from '../src/services/ue4ss-bridge.mjs';
import { PalDefenderClient } from '../src/paldefender/client.mjs';
import { SourceRconClient } from '../src/palworld/rcon-client.mjs';
import { WhitelistService } from '../src/services/whitelist-service.mjs';
import { ShopService } from '../src/services/shop-service.mjs';
import { ServerDiscoveryService, compareVersions } from '../src/services/server-discovery.mjs';
import { PalDatabase } from '../src/db.mjs';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const pass=(name,detail='')=>console.log(`\x1b[32mPASS\x1b[0m ${name}${detail?` — ${detail}`:''}`);
const fail=(name,err)=>console.log(`\x1b[31mFAIL\x1b[0m ${name} — ${err?.message??err}`);
const warn=(name,detail)=>console.log(`\x1b[33mWARN\x1b[0m ${name} — ${detail}`);
const skip=(name,why)=>console.log(`\x1b[36mSKIP\x1b[0m ${name} — ${why}`);

console.log(`PalControl doctor v${PALCONTROL_VERSION}\n`);
const bridgeDiscovery = new ServerDiscoveryService({ bridgeRoot: './mods/PalControlBridge', logger: console });
const bundledBridgeVersion = await bridgeDiscovery.readBundledVersion();
console.log(`PalControl: ${PALCONTROL_VERSION}`);
console.log(`Bundled Bridge: ${bundledBridgeVersion || 'unknown'}`);
for(const warning of validateConfig()) warn('config', warning);

const rest=new PalworldRestClient({baseUrl:config.palworld.restUrl,username:config.palworld.username,password:config.palworld.password,timeoutMs:config.palworld.timeoutMs});
for(const [name,fn] of [['REST /info',()=>rest.info()],['REST /metrics',()=>rest.metrics()],['REST /players',()=>rest.players()],['REST /settings',()=>rest.settings()]]){
  try{const x=await fn();pass(name,JSON.stringify(x).slice(0,160));}catch(e){fail(name,e);}
}
if(config.palworld.gameDataEnabled){try{const g=await rest.gameData();pass('REST /game-data',`${g.ActorData?.length??0} actors`);}catch(e){fail('REST /game-data',e);}}
else skip('REST /game-data','PALWORLD_GAME_DATA_ENABLED=false; PalControlBridge supplies live actor data');

let provider;
if(config.provider.type==='nitrado')provider=new NitradoClient(config.provider.nitrado);
else if(config.provider.type==='local')provider=new LocalProvider(config.provider.local);
else provider=new PassiveProvider(config.provider.type);
try{const s=await provider.status();pass(`Provider ${provider.type}`,JSON.stringify(s).slice(0,180));}catch(e){fail(`Provider ${provider.type}`,e);}

let remoteStore=null;
if(config.provider.type==='nitrado'&&provider.enabled)remoteStore=provider;
else if(config.remoteFiles.ftp.host)remoteStore=new FtpFileStore(config.remoteFiles.ftp);

const bridge=new Ue4ssBridge({
  remoteStore,
  remoteDir:config.ue4ssBridge.enabled?config.ue4ssBridge.remoteDir:'',
  cacheDir:path.join(config.remoteFiles.cacheDir,'doctor-ue4ss'),
  intervalMs:config.ue4ssBridge.pollIntervalMs,
  worldIntervalMs:config.ue4ssBridge.worldIntervalMs,
  commandTimeoutMs:config.ue4ssBridge.commandTimeoutMs
});

if(config.ue4ssBridge.enabled){
  if(!bridge.enabled) fail('PalControlBridge','UE4SS_BRIDGE_ENABLED=true but remote FTP/file access is unavailable');
  else {
    const p=await bridge.probe();
    const runningBridgeVersion = p.version ?? bridge.lastHeartbeat?.version ?? 'unknown';
    const heartbeatState = p.ready ? 'fresh' : 'stale';
    const filesState = compareVersions(runningBridgeVersion, bundledBridgeVersion) === 0 ? 'installed' : 'outdated';
    console.log(`Running Bridge: ${runningBridgeVersion}`);
    console.log(`Heartbeat: ${heartbeatState}`);
    console.log(`Bridge files: ${filesState}`);
    console.log(`Restart required: ${filesState === 'outdated' ? 'yes' : 'no'}`);
    if(p.ready) pass('PalControlBridge heartbeat',`v${p.version} · ${Math.round(p.ageMs)}ms old · features=${Object.keys(p.features??{}).filter(k=>p.features[k]).join(',')}`);
    else fail('PalControlBridge heartbeat',p.reason);
    try{const pong=await bridge.ping();pass('PalControlBridge command IPC',`${pong.message??'pong'} · v${pong.data?.version??'unknown'}`);}catch(e){fail('PalControlBridge command IPC',e);}
    try{const a=await bridge.downloadJson('actors.json');pass('PalControlBridge players',`${(a.actors??a.players??[]).length} live actor(s) in snapshot`);}catch(e){fail('PalControlBridge players',e);}
    try{const w=await bridge.downloadJson('world.json',{optional:true});if(w)pass('PalControlBridge world',`${w.actors?.length??0} loaded Pal/NPC/base actor(s)`);else warn('PalControlBridge world','world.json not created yet');}catch(e){warn('PalControlBridge world',e.message);}
  }
}else skip('PalControlBridge','UE4SS_BRIDGE_ENABLED=false');

const source=new SaveSource({localPath:config.palworld.savePath,remoteStore,remoteSavePath:config.remoteFiles.savePath,remoteLogPath:config.remoteFiles.logPath,cacheDir:config.remoteFiles.cacheDir});
if(source.enabled){try{const s=await source.syncSaves();pass('Save source',`${s.mode} ${source.localSavePath}`);}catch(e){fail('Save source',e);}}
else skip('Save source','not configured');

if(config.ue4ssBridge.enabled){
  skip('PalDefender chat log','PalControlBridge captures in-game chat directly');
}else if(config.remoteFiles.logPath && remoteStore){
  try{
    const logSync=await source.syncLogs();
    if(logSync?.file)pass('PalDefender log source',`${config.remoteFiles.logPath}/${logSync.file}`);
    else fail('PalDefender log source','No .log/.txt file found in configured remote log directory.');
  }catch(e){fail('PalDefender log source',e);}
  if(typeof remoteStore.downloadFile==='function'){
    const remoteConfig=path.posix.join(path.posix.dirname(config.remoteFiles.logPath.replace(/\\/g,'/')),'Config.json');
    const localConfig=path.join(os.tmpdir(),`paldefender-config-${process.pid}.json`);
    try{
      await remoteStore.downloadFile(remoteConfig,localConfig);
      const pdCfg=JSON.parse(await fs.readFile(localConfig,'utf8'));
      if(pdCfg.logChat===true)pass('PalDefender Config logChat','true');else fail('PalDefender Config logChat','must be true for in-game command detection');
      if(pdCfg.logPlayerUID===true)pass('PalDefender Config logPlayerUID','true');else fail('PalDefender Config logPlayerUID','must be true so !kit can target the correct player');
    }catch(e){fail('PalDefender Config chat flags',e);}
    finally{await fs.rm(localConfig,{force:true}).catch(()=>{});}
  }
}else if(config.chat.logDir){
  pass('PalDefender log source',`local ${config.chat.logDir}`);
}else skip('PalDefender log source','not configured');

const reader=new SaveReaderService({enabled:config.saveReader.enabled,bin:config.saveReader.bin,savesPath:source.localSavePath,timeoutMs:config.saveReader.timeoutMs,beforeRead:source.remote?()=>source.syncSaves():null});
if(reader.enabled){
  const p=await reader.probe();
  if(p.ready){pass('palworld-save-reader',p.version);try{const r=await reader.roster();pass('save-reader roster',`${r.roster?.length??0} players`);}catch(e){fail('save-reader roster',e);}}
  else fail('palworld-save-reader',p.reason);
}else skip('palworld-save-reader','SAVE_READER_ENABLED=false');

const pd=new PalDefenderClient(config.palDefender);
if(config.palDefender.enabled){
  try{const v=await pd.version();pass('PalDefender REST /version',JSON.stringify(v).slice(0,160));}
  catch(e){fail('PalDefender REST /version',e);}
}else skip('PalDefender REST','PALDEFENDER_API_ENABLED=false');

const rcon=new SourceRconClient({host:config.palworld.rconHost,port:config.palworld.rconPort,password:config.palworld.rconPassword,timeoutMs:config.palworld.rconTimeoutMs});
let rconReachable=false;
if(config.palworld.rconPassword){
  try{const out=await rcon.exec('Info');rconReachable=true;pass('RCON Info (optional fallback)',String(out).slice(0,160));}
  catch(e){warn('RCON Info (optional fallback)',e.message);}
  if(rconReachable && config.palDefender.whitelistEnabled){
    try{const out=await rcon.exec('/version');pass('PalDefender RCON /version',String(out).slice(0,160));}catch(e){warn('PalDefender RCON /version',e.message);}
  }
}else skip('RCON','not configured; PalControlBridge does not require it for kits/chat/map');

const whitelist=new WhitelistService({rcon,enabled:config.palDefender.whitelistEnabled});
if(config.palDefender.whitelistEnabled){try{const out=await whitelist.list();pass('PalDefender whitelist RCON',String(out.raw).slice(0,120));}catch(e){fail('PalDefender whitelist RCON',e);}}
else skip('PalDefender whitelist','PALDEFENDER_WHITELIST_ENABLED=false');

if(config.shop.enabled){
  const tmp=path.join(os.tmpdir(),`palcontrol-doctor-${process.pid}.sqlite`);
  const db=new PalDatabase(tmp);
  try{
    const shop=new ShopService({enabled:true,catalogPath:config.shop.catalogPath,bridge,palDefender:pd,rcon,db,playtimeCoinsPerHour:config.shop.playtimeCoinsPerHour,vipPlaytimeCoinsPerHour:config.shop.vipPlaytimeCoinsPerHour,killReward:config.shop.killReward});
    const st=shop.status();
    if(st.catalogError)fail('Shop catalog',st.catalogError);else pass('Shop catalog',`${st.products} product(s), ${st.kits} kit(s)`);
    const live=await shop.probeDelivery();
    if(live.ready)pass('Shop delivery LIVE',`${live.transport}${live.detail?` — ${live.detail}`:''}`);else fail('Shop delivery LIVE',live.reason);
  }finally{db.close();await fs.rm(tmp,{force:true}).catch(()=>{});}
}else skip('Shop','SHOP_ENABLED=false');

console.log('\nDoctor complete. PASS means the real installed integration accepted the check; WARN is an optional/fallback path.');
