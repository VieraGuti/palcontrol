import { PALCONTROL_VERSION } from '../version.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionAuth, parseCookies } from './auth.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../public');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
async function jsonBody(req,limit=256_000){let body='';for await(const c of req){body+=c;if(body.length>limit)throw new Error('Request body too large');}return body?JSON.parse(body):{};}
function sendJson(res,status,obj){const data=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(data)});res.end(data);}
function sanitizeDbPlayer(p){return{userId:p.user_id,playerId:p.player_id,name:p.name,accountName:p.account_name,level:p.level,ping:p.ping,buildingCount:p.building_count,firstSeen:p.first_seen,lastSeen:p.last_seen,online:Boolean(p.online),playtimeMs:Number(p.playtime_ms??0)};}
function ingestToken(req){const value=req.headers.authorization??'';return value.startsWith('Bearer ')?value.slice(7):String(req.headers['x-map-ingest-token']??'');}
function normalizeActors(value){
  if(!Array.isArray(value)||value.length>10_000)throw new Error('actors must be an array with at most 10000 entries.');
  return value.map((actor)=>({
    type:String(actor.type??actor.Type??'Actor'),
    unitType:String(actor.unitType??actor.UnitType??actor.type??'Unknown'),
    nickName:actor.nickName??actor.NickName??null,
    trainerNickName:actor.trainerNickName??actor.TrainerNickName??null,
    userId:actor.userId??actor.userid??actor.UserId??null,
    playerId:actor.playerId??actor.PlayerId??null,
    instanceId:actor.instanceId??actor.InstanceId??null,
    level:Number.isFinite(Number(actor.level??actor.Level))?Number(actor.level??actor.Level):null,
    guildId:actor.guildId??actor.GuildID??null,
    guildName:actor.guildName??actor.GuildName??null,
    class:actor.class??actor.Class??null,
    action:actor.action??actor.Action??null,
    x:Number(actor.x??actor.LocationX), y:Number(actor.y??actor.LocationY), z:Number(actor.z??actor.LocationZ),
    isActive:actor.isActive??actor.IsActive??true
  })).filter((actor)=>Number.isFinite(actor.x)&&Number.isFinite(actor.y));
}

export class PalHttpServer{
  constructor({config,services,db,logger=console}){this.cfg=config;this.services=services;this.db=db;this.logger=logger;this.auth=new SessionAuth({password:config.panelPassword,secret:config.sessionSecret});this.sse=new Set();this.server=http.createServer((req,res)=>this.handle(req,res));}
  start(){return new Promise(resolve=>this.server.listen(this.cfg.port,this.cfg.host,()=>{const local=`http://127.0.0.1:${this.cfg.port}`;const bind=`http://${this.cfg.host}:${this.cfg.port}`;this.logger.log(`[web] dashboard ${local} (local only)`);this.logger.log(`[web] listening on ${bind} (admin authentication required)`);if(this.cfg.publicBaseUrlConfigured)this.logger.log(`[web] configured public URL ${this.cfg.publicBaseUrl}`);else this.logger.log('[web] no public URL configured; use a Cybrancee domain/reverse proxy pointing to this port.');resolve();}));}
  stop(){for(const r of this.sse)r.end();return new Promise(resolve=>this.server.close(resolve));}
  push(event,data){const msg=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;for(const r of this.sse)r.write(msg);}
  isAuthed(req){return this.auth.verify(parseCookies(req.headers.cookie??'').palcontrol_session);}
  async handle(req,res){
    try{
      const url=new URL(req.url,`http://${req.headers.host??'localhost'}`);const p=url.pathname;
      if(p==='/api/health')return sendJson(res,200,{ok:true,version:PALCONTROL_VERSION,palworldOnline:this.services.poller.snapshot().online,provider:this.services.provider.type,saveReader:{enabled:this.services.saveReader?.enabled??false,ready:Boolean(this.services.saveReader?.version),version:this.services.saveReader?.version??null},now:new Date().toISOString()});
      if(p==='/api/session'&&req.method==='POST'){const body=await jsonBody(req);const token=this.auth.login(body.password);if(!token)return sendJson(res,401,{error:'Invalid password'});res.setHeader('Set-Cookie',this.auth.cookie(token));return sendJson(res,200,{ok:true});}
      if(p==='/api/map/ingest'&&req.method==='POST'){
        if(!this.cfg.mapIngestToken)return sendJson(res,503,{error:'Map ingest is not configured.'});
        if(ingestToken(req)!==this.cfg.mapIngestToken)return sendJson(res,401,{error:'Invalid map ingest token.'});
        const body=await jsonBody(req);const actors=normalizeActors(body.actors);this.services.poller.ingestExternalActors(actors);
        return sendJson(res,202,{ok:true,actors:actors.length,receivedAt:new Date().toISOString()});
      }
      if(p.startsWith('/api/')&&!this.isAuthed(req))return sendJson(res,401,{error:'Authentication required'});
      if(p==='/api/state'&&req.method==='GET')return sendJson(res,200,this.safeState());
      if(p==='/api/metrics'&&req.method==='GET')return sendJson(res,200,{summary:this.db.serverMetricsSummary(),samples:this.db.serverSamples(Number(url.searchParams.get('limit')??100))});
      if(p==='/api/diagnostics'&&req.method==='GET')return sendJson(res,200,await this.diagnostics());
      if(p==='/api/provider'&&req.method==='GET'){let status;try{status=await this.services.provider.status();}catch(err){status={provider:this.services.provider.type,error:err.message,capabilities:this.services.provider.capabilities?.()??{}};}return sendJson(res,200,status);}
      if(p==='/api/provider/restart'&&req.method==='POST'){const out=await this.services.provider.restart('Restart requested from PalControl panel');this.db.audit('panel','provider.restart','',JSON.stringify(out).slice(0,3000));return sendJson(res,200,out);}
      if(p==='/api/settings'&&req.method==='GET')return sendJson(res,200,await this.services.rest.settings());
      if(p==='/api/paldefender'&&req.method==='GET'){if(!this.services.palDefender.configured)return sendJson(res,200,{enabled:false});try{return sendJson(res,200,{enabled:true,ready:true,version:await this.services.palDefender.version()});}catch(err){return sendJson(res,200,{enabled:true,ready:false,error:err.message});}}
      if(p==='/api/paldefender/players'&&req.method==='GET')return sendJson(res,200,await this.services.palDefender.players());
      if(p==='/api/paldefender/guilds'&&req.method==='GET')return sendJson(res,200,await this.services.palDefender.guilds());
      if(p==='/api/paldefender/banlist'&&req.method==='GET'){
        if(!this.services.palDefender.configured)return sendJson(res,200,{enabled:false,items:[]});
        return sendJson(res,200,await this.services.palDefender.banlist());
      }
      if(p==='/api/paldefender/player'&&req.method==='GET'){const id=url.searchParams.get('id');if(!id)return sendJson(res,400,{error:'id required'});const [player,items,pals,progression]=await Promise.allSettled([this.services.palDefender.player(id),this.services.palDefender.items(id),this.services.palDefender.pals(id),this.services.palDefender.progression(id)]);return sendJson(res,200,{player:setResult(player),items:setResult(items),pals:setResult(pals),progression:setResult(progression)});}
      if(p==='/api/paldefender/broadcast'&&req.method==='POST'){const b=await jsonBody(req);const out=await this.services.palDefender.broadcast(b.message);this.db.audit('panel','paldefender.broadcast','',String(b.message??''));return sendJson(res,200,out);}
      if(p==='/api/paldefender/message'&&req.method==='POST'){const b=await jsonBody(req);const out=await this.services.palDefender.sendPlayerMessage(b.userId,b.message,b.sendType||'PlayerChat');this.db.audit('panel','paldefender.message',b.userId,String(b.message??''));return sendJson(res,200,out);}
      if(p==='/api/whitelist'&&req.method==='GET')return sendJson(res,200,{status:this.services.whitelist.status(),...(this.services.whitelist.enabled?await this.services.whitelist.list():{})});
      if(p==='/api/whitelist/add'&&req.method==='POST'){const b=await jsonBody(req);return sendJson(res,200,await this.services.whitelist.add(b.userId,'panel'));}
      if(p==='/api/whitelist/remove'&&req.method==='POST'){const b=await jsonBody(req);return sendJson(res,200,await this.services.whitelist.remove(b.userId,'panel'));}
      if(p==='/api/shop'&&req.method==='GET')return sendJson(res,200,{...this.services.shop.status(),products:this.services.shop.catalog(),kits:this.services.shop.kitsCatalog?.()??[]});
      if(p==='/api/shop/products'&&req.method==='PUT'){const body=await jsonBody(req);const out=this.services.shop.upsertProduct(body);this.db.audit('panel','shop.product.save',String(body.id??''),JSON.stringify(body).slice(0,2000));return sendJson(res,200,out);}
      if(p.startsWith('/api/shop/products/')&&req.method==='DELETE'){const id=decodeURIComponent(p.slice('/api/shop/products/'.length));const out=this.services.shop.removeProduct(id);this.db.audit('panel','shop.product.delete',id);return sendJson(res,200,out);}
      if(p==='/api/shop/kits'&&req.method==='PUT'){const body=await jsonBody(req);const out=this.services.shop.upsertKit(body);this.db.audit('panel','shop.kit.save',String(body.id??''),JSON.stringify(body).slice(0,2000));return sendJson(res,200,out);}
      if(p.startsWith('/api/shop/kits/')&&req.method==='DELETE'){const id=decodeURIComponent(p.slice('/api/shop/kits/'.length));const out=this.services.shop.removeKit(id);this.db.audit('panel','shop.kit.delete',id);return sendJson(res,200,out);}
      if(p==='/api/schedule'&&req.method==='GET')return sendJson(res,200,{items:this.db.scheduledMessages()});
      if(p==='/api/schedule'&&req.method==='POST'){const b=await jsonBody(req);if(!String(b.message??'').trim())return sendJson(res,400,{error:'message required'});const id=this.services.serverMessageService.scheduleMessage(String(b.message),{intervalMinutes:Number(b.intervalMinutes??b.minutes??15),enabled:b.enabled!==false});this.db.audit('panel','message.schedule.create',String(id));return sendJson(res,201,{id,items:this.db.scheduledMessages()});}
      const scheduleMatch=p.match(/^\/api\/schedule\/(\d+)$/);
      if(scheduleMatch&&req.method==='PUT'){const id=Number(scheduleMatch[1]),b=await jsonBody(req),patch={};if(b.message!==undefined)patch.message=String(b.message).trim();if(b.intervalMinutes!==undefined)patch.intervalMinutes=Math.max(5,Number(b.intervalMinutes)||15);if(b.enabled!==undefined)patch.enabled=b.enabled?1:0;if(b.nextRunAt!==undefined)patch.nextRunAt=Number(b.nextRunAt);const changes=this.db.updateScheduledMessage(id,patch);this.db.audit('panel','message.schedule.update',String(id),JSON.stringify(patch));return sendJson(res,200,{changes,items:this.db.scheduledMessages()});}
      if(scheduleMatch&&req.method==='DELETE'){const id=Number(scheduleMatch[1]),changes=this.db.deleteScheduledMessage(id);this.db.audit('panel','message.schedule.delete',String(id));return sendJson(res,200,{changes,items:this.db.scheduledMessages()});}
      if(p==='/api/shop/purchases'&&req.method==='GET')return sendJson(res,200,{items:this.db.purchases(null,Number(url.searchParams.get('limit')??100))});
      if(p==='/api/shop/wallet'&&req.method==='GET'){const id=url.searchParams.get('discordId');if(!id)return sendJson(res,400,{error:'discordId required'});return sendJson(res,200,{...this.services.shop.wallet(id),ledger:this.db.economyLedger(id,50)});}
      if(p==='/api/shop/credit'&&req.method==='POST'){const b=await jsonBody(req);const out=this.services.shop.credit(b.discordId,Number(b.amount),'panel.credit',String(b.reason??''));this.db.audit('panel','economy.credit',String(b.discordId),JSON.stringify({amount:b.amount,reason:b.reason??''}));return sendJson(res,200,out);}
      if(p==='/api/shop/debit'&&req.method==='POST'){const b=await jsonBody(req);const out=this.services.shop.debit(b.discordId,Number(b.amount),'panel.debit',String(b.reason??''));this.db.audit('panel','economy.debit',String(b.discordId),JSON.stringify({amount:b.amount,reason:b.reason??''}));return sendJson(res,200,out);}
      if(p==='/api/players'&&req.method==='GET')return sendJson(res,200,{players:this.db.listPlayers().map(sanitizeDbPlayer)});
      if(p==='/api/player-detail'&&req.method==='GET'){const uid=url.searchParams.get('uid');const playerUid=url.searchParams.get('playerUid');const out={live:uid?this.db.player(uid):null,link:uid?this.db.linkForUser(uid):null,save:null,palDefender:null};if(out.live)out.live=sanitizeDbPlayer(out.live);const saveId=playerUid||out.link?.player_uid;if(saveId&&this.services.saveReader.enabled){try{out.save=await this.services.saveReader.player(saveId);}catch(err){out.save={error:err.message};}}const pdId=uid||out.link?.user_id||saveId;if(pdId&&this.services.palDefender.enabled){const results=await Promise.allSettled([this.services.palDefender.player(pdId),this.services.palDefender.items(pdId),this.services.palDefender.pals(pdId),this.services.palDefender.progression(pdId)]);out.palDefender={player:setResult(results[0]),items:setResult(results[1]),pals:setResult(results[2]),progression:setResult(results[3])};}if(!uid&&!playerUid)return sendJson(res,400,{error:'uid or playerUid required'});return sendJson(res,200,out);}
      if(p==='/api/save-reader/roster'&&req.method==='GET')return sendJson(res,200,await this.services.saveReader.roster());
      if(p==='/api/save-reader/guilds'&&req.method==='GET')return sendJson(res,200,await this.services.saveReader.guilds());
      if(p==='/api/guilds'&&req.method==='GET'){
        if(this.services.saveReader.enabled){try{const doc=await this.services.saveReader.guilds();return sendJson(res,200,{source:'save-reader',guilds:doc.guilds??[]});}catch{}}
        if(this.services.palDefender.enabled){const doc=await this.services.palDefender.guilds();const entries=Object.entries(doc?.Guilds??doc?.guilds??{});const guilds=entries.map(([id,g])=>({groupId:id,name:g?.name??g?.Name??'',baseCampLevel:g?.Level??g?.level??null,members:(g?.members??[]).map(x=>typeof x==='string'?{playerUId:x}:{playerUId:x?.id??x?.PlayerUID,name:x?.name}),bases:(g?.camps??[]).map(c=>({id:c?.id,location:c?.world_pos??c?.worldPos??null})),counts:{players:g?.member_count??g?.members?.length??0,bases:g?.camp_count??g?.camps?.length??0,workers:0}}));return sendJson(res,200,{source:'paldefender',guilds});}
        return sendJson(res,503,{error:'Guild data requires save-reader or PalDefender REST.'});
      }
      if(p==='/api/save-reader/world'&&req.method==='GET')return sendJson(res,200,await this.services.saveReader.world());
      if(p==='/api/save-reader/player'&&req.method==='GET'){const id=url.searchParams.get('id');if(!id)return sendJson(res,400,{error:'id required'});return sendJson(res,200,await this.services.saveReader.player(id));}
      if(p==='/api/map'&&req.method==='GET')return sendJson(res,200,this.mapState());
      if(p==='/api/heatmap'&&req.method==='GET'){const hours=Math.min(Math.max(Number(url.searchParams.get('hours')??24),1),168);return sendJson(res,200,{hours,positions:this.db.recentPositions(Date.now()-hours*3600000)});}
      if(p==='/api/audit'&&req.method==='GET')return sendJson(res,200,{items:this.db.auditLog(Number(url.searchParams.get('limit')??100))});
      if(p==='/api/backups'&&req.method==='GET')return sendJson(res,200,{enabled:this.services.backups.enabled,restoreEnabled:this.services.backups.allowRestore,items:await this.services.backups.list()});
      if(p==='/api/backups'&&req.method==='POST'){const b=await this.services.backups.create('panel');return sendJson(res,201,b);}
      const restoreMatch=p.match(/^\/api\/backups\/([^/]+)\/restore$/);if(restoreMatch&&req.method==='POST'){const b=await this.services.backups.restore(decodeURIComponent(restoreMatch[1]),'panel');return sendJson(res,200,b);}
      if(p==='/api/announce'&&req.method==='POST'){const b=await jsonBody(req);if(!b.message)return sendJson(res,400,{error:'message required'});const message=String(b.message).slice(0,500);let transport='palworld-rest';if(this.services.bridge?.enabled){try{await this.services.bridge.announce(message);transport='ue4ss-bridge';}catch(error){this.logger.warn?.('[panel announce/bridge]',error.message);throw new Error(`UE4SS bridge announce failed: ${error.message}`);}}else await this.services.rest.announce(message);this.db.audit('panel','server.announce','',`${message};transport=${transport}`);return sendJson(res,200,{ok:true,transport});}
      if(p==='/api/save'&&req.method==='POST'){await this.services.rest.save();this.db.audit('panel','server.save');return sendJson(res,200,{ok:true});}
      if(p==='/api/kick'&&req.method==='POST'){const b=await jsonBody(req);if(!b.userId)return sendJson(res,400,{error:'userId required'});await this.services.rest.kick(b.userId,b.message??'Kicked by an administrator.');this.db.audit('panel','player.kick',b.userId,b.message??'');return sendJson(res,200,{ok:true});}
      if(p==='/api/ban'&&req.method==='POST'){const b=await jsonBody(req);if(!b.userId)return sendJson(res,400,{error:'userId required'});await this.services.rest.ban(b.userId,b.message??'Banned by an administrator.');this.db.audit('panel','player.ban',b.userId,b.message??'');return sendJson(res,200,{ok:true});}
      if(p==='/api/unban'&&req.method==='POST'){const b=await jsonBody(req);if(!b.userId)return sendJson(res,400,{error:'userId required'});await this.services.rest.unban(b.userId);this.db.audit('panel','player.unban',b.userId,'');return sendJson(res,200,{ok:true});}
      if(p==='/api/shutdown'&&req.method==='POST'){const b=await jsonBody(req);await this.services.rest.shutdown(Number(b.waittime??30),b.message??'Server is shutting down.');this.db.audit('panel','server.shutdown','',JSON.stringify(b));return sendJson(res,200,{ok:true});}
      if(p==='/api/events'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`event: state\ndata: ${JSON.stringify(this.safeState())}\n\n`);this.sse.add(res);req.on('close',()=>this.sse.delete(res));return;}
      return this.staticFile(p,res);
    }catch(err){this.logger.error('[http]',err);if(!res.headersSent)sendJson(res,500,{error:err.message});else res.end();}
  }
  safeState(){const s=this.services.poller.snapshot();return{...s,players:s.players.map(p=>({name:p.name,accountName:p.accountName,playerId:p.playerId,userId:p.userId,ping:p.ping,location_x:p.location_x,location_y:p.location_y,level:p.level,building_count:p.building_count})),actors:this.mapState().actors,provider:{type:this.services.provider.type,capabilities:this.services.provider.capabilities?.()??{}}};}
  mapState(){const s=this.services.poller.snapshot();let actors=(s.actors??[]).map(a=>({type:a.type??a.Type,unitType:a.unitType??a.UnitType,nickName:a.nickName??a.NickName,trainerNickName:a.trainerNickName??a.TrainerNickName,userId:a.userId??a.userid??a.UserId??a.UserID,playerId:a.playerId??a.PlayerId??a.PlayerID,instanceId:a.instanceId??a.InstanceId??a.InstanceID,level:a.level??a.Level,guildId:a.guildId??a.GuildID,guildName:a.guildName??a.GuildName,class:a.class??a.Class,fullName:a.fullName??a.FullName,controller:a.controller??a.Controller,range:a.range??a.Range,action:a.action??a.Action,aiAction:a.aiAction??a.AI_Action,x:a.x??a.LocationX,y:a.y??a.LocationY,z:a.z??a.LocationZ,isActive:a.isActive??a.IsActive}));if(!actors.length){actors=s.players.filter(p=>Number.isFinite(Number(p.location_x))&&Number.isFinite(Number(p.location_y))).map(p=>({type:'Character',unitType:'Player',nickName:p.name,userId:p.userId,playerId:p.playerId,level:p.level,x:Number(p.location_x),y:Number(p.location_y),z:Number(p.location_z??0),isActive:true}));}const b=this.cfg.palworld.mapBounds;const bounds=Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)?b:[349400,724400,-1099400,-724400];return{time:s.gameData?.Time??null,fps:s.gameData?.FPS??s.metrics?.serverfps??null,averageFps:s.gameData?.AverageFPS??null,layer:{id:'palpagos',name:'Palpagos',imageUrl:this.cfg.palworld.mapImageUrl,bounds},actors};}
  async diagnostics(){
    const s=this.services.poller.snapshot();let settings=null,provider=null,saveReader=null;
    try{settings=await this.services.rest.settings();}catch(err){settings={error:err.message};}
    try{provider=await this.services.provider.status();}catch(err){provider={provider:this.services.provider.type,error:err.message,capabilities:this.services.provider.capabilities?.()??{}};}
    try{saveReader=await this.services.saveReader.probe();}catch(err){saveReader={ready:false,error:err.message};}
    let bridge={enabled:Boolean(this.services.bridge?.enabled),ready:false};
    if(this.services.bridge?.enabled){try{bridge={enabled:true,...await this.services.bridge.probe()};}catch(err){bridge={enabled:true,ready:false,error:err.message};}}
    let palDefender={enabled:this.services.palDefender.configured,ready:false};
    if(this.services.palDefender.configured){try{palDefender={enabled:true,ready:true,version:await this.services.palDefender.version()};}catch(err){palDefender={enabled:true,ready:false,error:err.message};}}
    return{version:PALCONTROL_VERSION,palworld:{online:s.online,error:s.lastError,restUrl:this.cfg.palworld.restUrl,gameDataEnabled:this.cfg.palworld.gameDataEnabled,settings},provider,saveSource:{enabled:this.services.saveSource.enabled,remote:this.services.saveSource.remote,localPath:this.services.saveSource.localSavePath,remoteSavePath:this.cfg.remoteFiles.savePath||null,remoteLogPath:this.cfg.remoteFiles.logPath||null},saveReader,bridge,palDefender,whitelist:this.services.whitelist.status(),shop:this.services.shop.status(),backups:{enabled:this.services.backups.enabled,restoreEnabled:this.services.backups.allowRestore},discord:{enabled:this.services.discord?.enabled??false,bridgeEnabled:this.cfg.discord.bridgeEnabled},watchdog:{enabled:this.cfg.watchdog.enabled}};
  }
  async staticFile(p,res){let rel=p==='/'?'/index.html':p;if(rel.includes('..'))return sendJson(res,400,{error:'bad path'});const file=path.join(root,rel);try{const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]??'application/octet-stream','Cache-Control':'no-cache'});res.end(data);}catch{const data=await fs.readFile(path.join(root,'index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(data);}}
}
