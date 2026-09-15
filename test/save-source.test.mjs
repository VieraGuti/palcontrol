import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SaveSource } from '../src/services/remote-files.mjs';

test('remote SaveSource synchronizes to a stable local cache used by save-reader',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pc-source-'));
 const store={downloadTree:async(remote,local)=>{await fs.mkdir(path.join(local,'Players'),{recursive:true});await fs.writeFile(path.join(local,'Level.sav'),'x');return{remoteDir:remote,localDir:local};},uploadTree:async()=>({ok:true})};
 const source=new SaveSource({remoteStore:store,remoteSavePath:'/world',cacheDir:root});
 const r=await source.syncSaves();
 assert.equal(r.mode,'remote');
 assert.equal(await fs.readFile(path.join(source.localSavePath,'Level.sav'),'utf8'),'x');
});
