import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordClient } from '../src/discord/client.mjs';

test('Discord linking is one slash command without claim/verify subcommands',()=>{
 const d=new DiscordClient({config:{},services:{},db:{}});
 const link=d.commands().find(c=>c.name==='link');
 assert.ok(link);
 assert.equal(link.options?.some(o=>o.type===1),false);
 assert.deepEqual(link.options?.map(o=>o.name),['player']);
});

test('Discord slow interactions are deferred before editing the original response', async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),method:options.method,body:options.body});
    return new Response(options.method==='PATCH'?JSON.stringify({id:'message'}):'',{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const services={
      poller:{snapshot:()=>({players:[]})},
      brand:{footer:'PalControl'},
      publicBaseUrl:'https://example.test',
      shop:{enabled:false}
    };
    const d=new DiscordClient({config:{clientId:'app'},services,db:{}});
    await d.handleInteraction({type:2,id:'interaction',token:'token',application_id:'app',data:{name:'players'},member:{user:{id:'u1'}}});
    assert.equal(JSON.parse(calls[0].body).type,5);
    assert.match(calls[1].url,/\/webhooks\/app\/token\/messages\/@original$/);
    assert.equal(calls[1].method,'PATCH');
  }finally{globalThis.fetch=originalFetch;}
});

test('kit slash command is registered without hardcoded guild/server data',()=>{
  const d=new DiscordClient({config:{},services:{},db:{}});
  const kit=d.commands().find(c=>c.name==='kit');
  assert.ok(kit);
  assert.deepEqual(kit.options?.map(o=>o.name),['kit']);
});

test('kit target resolves save PlayerUID to live crossplay UserId',()=>{
  const services={poller:{snapshot:()=>({players:[{name:'VieraGuti',playerId:'495EA8D2000000000000000000000000',userId:'gdk_253541659768'}]})}};
  const d=new DiscordClient({config:{},services,db:{}});
  assert.equal(d.resolveLinkedPalUserId({player_uid:'495EA8D2000000000000000000000000',player_name:'VieraGuti'}),'gdk_253541659768');
});

test('kit target refuses raw PlayerUID when no live UserId can be resolved',()=>{
  const services={poller:{snapshot:()=>({players:[]})}};
  const d=new DiscordClient({config:{},services,db:{}});
  assert.throws(()=>d.resolveLinkedPalUserId({player_uid:'495EA8D2000000000000000000000000',player_name:'VieraGuti'}),/gdk_\/steam_/i);
});
