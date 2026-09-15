import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PalDatabase } from '../src/db.mjs';
import { LinkService } from '../src/services/link-service.mjs';

test('console-safe save claim links Discord to PlayerUID without game chat', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'palclaim-'));
  const db=new PalDatabase(path.join(dir,'test.sqlite'));
  const uid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  db.syncPlayers([{userId:'xbox_123',playerId:'AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE',name:'Wery',level:50}],1000);
  let saves=0;
  const saveReader={enabled:true,roster:async()=>({resolveVersion:4,kind:'roster',roster:[{playerUId:uid,character:{nickname:'Wery',level:50}}]}),player:async()=>({resolveVersion:4,kind:'player',player:{playerUId:uid,character:{nickname:'Wery',level:50},pals:[{location:'party',slot:0,level:41},{location:'party',slot:1,level:27},{location:'party',slot:2,level:50}],inventory:{food:[],weapons:[],armor:[],common:[]}}})};
  const links=new LinkService({db,saveReader,rest:{save:async()=>{saves++;}}});
  const challenge=await links.createSaveClaim('discord_1','Wery');
  assert.equal(saves,1);
  assert.equal(challenge.questions.length,3);
  const row=db.db.prepare('SELECT answer FROM claim_challenges WHERE discord_id=?').get('discord_1');
  const linked=links.verifySaveClaim('discord_1',row.answer);
  assert.equal(linked.discord_id,'discord_1');
  assert.equal(linked.player_uid,uid);
  assert.equal(linked.user_id,'xbox_123');
  assert.equal(linked.platform,'xbox');
  db.close(); fs.rmSync(dir,{recursive:true,force:true});
});
