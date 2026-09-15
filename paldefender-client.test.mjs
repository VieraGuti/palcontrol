import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PalDefenderClient } from '../src/paldefender/client.mjs';

test('PalDefender client uses bearer auth and documented grant/broadcast shapes', async () => {
  const seen=[];
  const server=http.createServer(async(req,res)=>{
    let body=''; for await(const c of req) body+=c;
    seen.push({method:req.method,url:req.url,auth:req.headers.authorization,body:body?JSON.parse(body):null});
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({Success:true}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address();
  const c=new PalDefenderClient({enabled:true,baseUrl:`http://127.0.0.1:${port}`,token:'secret'});
  await c.giveItems('steam_1',[{ItemID:'Money',Count:100}]);
  await c.givePals('steam_1',[{PalID:'Anubis',Level:10}]);
  await c.broadcast('hello');
  await c.sendPlayerMessage('steam_1','delivery','PlayerLogImportant');
  await new Promise(r=>server.close(r));
  assert.equal(seen[0].auth,'Bearer secret');
  assert.deepEqual(seen[0],{method:'POST',url:'/v1/pdapi/give/items/steam_1',auth:'Bearer secret',body:{Items:[{ItemID:'Money',Count:100}]}});
  assert.deepEqual(seen[1].body,{Pals:[{PalID:'Anubis',Level:10}]});
  assert.deepEqual(seen[2].body,{Message:'hello'});
  assert.deepEqual(seen[3].body,{SendType:'PlayerLogImportant',UserID:'steam_1',Message:'delivery'});
});
