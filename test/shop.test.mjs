import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PalDatabase } from '../src/db.mjs';
import { ShopService } from '../src/services/shop-service.mjs';

test('shop reserves coins, delivers through PalDefender, and settles', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palcontrol-shop-'));
  const catalog=path.join(dir,'shop.json');
  fs.writeFileSync(catalog,JSON.stringify({version:1,products:[{id:'money100',name:'Money x100',price:25,type:'items',items:[{ItemID:'Money',Count:100}]}]}));
  const db=new PalDatabase(path.join(dir,'db.sqlite'));
  db.linkAccount({discordId:'d1',userId:'steam_1',playerName:'Wery'});
  db.adjustWallet('d1',100,'test');
  const calls=[]; const pd={enabled:true,giveItems:async(target,items)=>{calls.push({target,items});return{Success:true};},sendPlayerMessage:async()=>({Success:true})};
  const shop=new ShopService({enabled:true,catalogPath:catalog,palDefender:pd,db});
  const out=await shop.purchase('d1','money100','test');
  assert.equal(out.balance,75); assert.equal(db.wallet('d1').balance,75); assert.equal(db.purchases('d1')[0].status,'delivered');
  assert.deepEqual(calls,[{target:'steam_1',items:[{ItemID:'Money',Count:100}]}]);
  db.close();
});

test('shop refunds wallet when PalDefender delivery fails', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palcontrol-shop-refund-'));
  const catalog=path.join(dir,'shop.json');
  fs.writeFileSync(catalog,JSON.stringify({version:1,products:[{id:'pal',name:'Pal',price:40,type:'pals',pals:[{PalID:'Anubis',Level:10}]}]}));
  const db=new PalDatabase(path.join(dir,'db.sqlite')); db.linkAccount({discordId:'d1',userId:'steam_1'}); db.adjustWallet('d1',100,'test');
  const pd={enabled:true,givePals:async()=>{throw new Error('inventory full');},sendPlayerMessage:async()=>{}};
  const shop=new ShopService({enabled:true,catalogPath:catalog,palDefender:pd,db});
  await assert.rejects(()=>shop.purchase('d1','pal'),/inventory full/);
  assert.equal(db.wallet('d1').balance,100); assert.equal(db.purchases('d1')[0].status,'refunded'); db.close();
});


test('starter alias resolves and kit can deliver through PalDefender RCON fallback', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palcontrol-kit-rcon-'));
  const catalog=path.join(dir,'shop.json');
  fs.writeFileSync(catalog,JSON.stringify({version:1,products:[],kits:[{id:'start',aliases:['starter'],name:'Starter',cooldownMs:0,items:[{ItemID:'PalSphere',Count:10},{ItemID:'Berries',Count:20}]}]}));
  const db=new PalDatabase(path.join(dir,'db.sqlite'));
  const calls=[];
  const rcon={password:'configured',exec:async(command)=>{calls.push(command);return 'ok';}};
  const pd={enabled:false};
  const shop=new ShopService({enabled:true,catalogPath:catalog,palDefender:pd,rcon,db});
  const out=await shop.claimKit({playerUserId:'steam_1',playerName:'Wery',discordId:'d1',kitId:'starter'});
  assert.equal(out.kit.id,'start');
  assert.equal(shop.deliveryTransport,'paldefender-rcon');
  assert.deepEqual(calls,['/giveitems steam_1 PalSphere:10 Berries:20']);
  db.close();
});


test('shop falls back from failing PalDefender REST to RCON', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palcontrol-shop-fallback-'));
  const catalog=path.join(dir,'shop.json');
  fs.writeFileSync(catalog,JSON.stringify({version:1,products:[{id:'berries',name:'Berries',price:10,type:'items',items:[{ItemID:'Berries',Count:5}]}]}));
  const db=new PalDatabase(path.join(dir,'db.sqlite'));
  db.linkAccount({discordId:'d1',userId:'gdk_1',playerName:'Wery'}); db.adjustWallet('d1',20,'test');
  const pd={enabled:true,giveItems:async()=>{throw new Error('REST offline');},sendPlayerMessage:async()=>{},version:async()=>{throw new Error('REST offline');}};
  const calls=[]; const rcon={password:'configured',exec:async(command)=>{calls.push(command);return '{"PalDefender":"1.8.1"}';}};
  const shop=new ShopService({enabled:true,catalogPath:catalog,palDefender:pd,rcon,db,logger:{warn(){}}});
  const out=await shop.purchase('d1','berries');
  assert.equal(out.delivery.transport,'paldefender-rcon');
  assert.deepEqual(calls,['/giveitems gdk_1 Berries:5']);
  assert.equal(db.wallet('d1').balance,10);
  db.close();
});

test('shop live probe does not call configured RCON READY until PalDefender command responds', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palcontrol-shop-probe-'));
  const catalog=path.join(dir,'shop.json'); fs.writeFileSync(catalog,JSON.stringify({version:1,products:[],kits:[]}));
  const db=new PalDatabase(path.join(dir,'db.sqlite'));
  const down=new ShopService({enabled:true,catalogPath:catalog,palDefender:{enabled:false},rcon:{password:'configured',exec:async()=>{throw new Error('timeout');}},db});
  assert.equal((await down.probeDelivery()).ready,false);
  const up=new ShopService({enabled:true,catalogPath:catalog,palDefender:{enabled:false},rcon:{password:'configured',exec:async()=>'{"Version":"1.8.1"}'},db});
  const status=await up.probeDelivery(); assert.equal(status.ready,true); assert.equal(status.transport,'paldefender-rcon');
  db.close();
});

test('shop prefers PalControlBridge for kit delivery and does not require gdk/steam id', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palcontrol-kit-bridge-'));
  const catalog=path.join(dir,'shop.json');
  fs.writeFileSync(catalog,JSON.stringify({version:1,products:[],kits:[{id:'start',aliases:['starter'],name:'Starter',cooldownMs:0,items:[{ItemID:'PalSphere',Count:10}]}]}));
  const db=new PalDatabase(path.join(dir,'db.sqlite'));
  const calls=[];
  const bridge={enabled:true,ping:async()=>({message:'pong',data:{version:'1.0.0'}}),giveItems:async(payload)=>{calls.push(payload);return{transport:'ue4ss-ftp',response:{success:true}};},personalMessage:async()=>({success:true})};
  const shop=new ShopService({enabled:true,catalogPath:catalog,bridge,palDefender:{enabled:false},db});
  const live=await shop.probeDelivery(); assert.equal(live.ready,true); assert.equal(live.transport,'ue4ss-ftp');
  const out=await shop.claimKit({playerUserId:'legacy-playeruid',playerName:'VieraGuti',discordId:'d1',kitId:'starter'});
  assert.equal(out.delivery.transport,'ue4ss-ftp');
  assert.equal(calls[0].playerName,'VieraGuti');
  assert.equal(calls[0].userId,'legacy-playeruid');
  db.close();
});


test('failed kit delivery releases cooldown reservation', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palcontrol-kit-release-'));
  const catalog=path.join(dir,'shop.json');
  fs.writeFileSync(catalog,JSON.stringify({version:1,products:[],kits:[{id:'start',aliases:['starter'],name:'Starter',cooldownMs:600000,items:[{ItemID:'PalSphere',Count:10}]}]}));
  const db=new PalDatabase(path.join(dir,'db.sqlite'));
  let attempts=0;
  const bridge={enabled:true,giveItems:async()=>{attempts++; throw new Error('delivery failed');},personalMessage:async()=>{}};
  const shop=new ShopService({enabled:true,catalogPath:catalog,bridge,palDefender:{enabled:false},db});
  await assert.rejects(()=>shop.claimKit({playerUserId:'gdk_1',playerName:'VieraGuti',discordId:'',kitId:'starter'}),/delivery failed/);
  await assert.rejects(()=>shop.claimKit({playerUserId:'gdk_1',playerName:'VieraGuti',discordId:'',kitId:'starter'}),/delivery failed/);
  assert.equal(attempts,2);
  db.close();
});
