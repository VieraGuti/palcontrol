import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NitradoClient } from '../src/providers/nitrado.mjs';

function response(body, status=200){return new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}

test('Nitrado provider calls restart and file API with bearer auth', async()=>{
  const calls=[];
  const fetchImpl=async(url,opts={})=>{
    calls.push({url:String(url),opts});
    const u=new URL(url);
    if(u.pathname.endsWith('/gameservers/restart')) return response({status:'success'});
    if(u.pathname.endsWith('/file_server/list')) return response({data:{entries:[{name:'Level.sav',path:'/save/Level.sav',type:'file'}]}});
    if(u.pathname.endsWith('/file_server/download')) return response({data:{token:{url:'https://download.example/file',token:'abc'}}});
    if(u.hostname==='download.example') return new Response(Buffer.from('SAVE'),{status:200});
    return response({data:{gameserver:{status:'started'}}});
  };
  const n=new NitradoClient({token:'secret',serviceId:'123',fetchImpl});
  await n.restart();
  assert.equal(calls[0].opts.headers.Authorization,'Bearer secret');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pc-nitrado-'));
  await n.downloadTree('/save',dir);
  assert.equal(await fs.readFile(path.join(dir,'Level.sav'),'utf8'),'SAVE');
});
