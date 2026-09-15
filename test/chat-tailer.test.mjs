import test from 'node:test';import assert from 'node:assert/strict';import {CHAT_RE,LINK_RE} from '../src/services/chat-tailer.mjs';
test('PalDefender chat and link lines parse',()=>{const chat="[Chat::Global]['Wery' (UserId=steam_123, PlayerId=ABC)]: hello world";assert.deepEqual(CHAT_RE.exec(chat).slice(1),['Wery','hello world']);const link="[Chat::Global]['Wery' (UserId=steam_123, PlayerId=ABC)]: /link A1B2C3";const m=LINK_RE.exec(link);assert.equal(m[1],'Wery');assert.equal(m[2],'steam_123');assert.equal(m[3],'A1B2C3');});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PalDefenderTailer } from '../src/services/chat-tailer.mjs';

test('chat tailer ignores historical startup lines but reads the beginning of a rotated log', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'palcontrol-chat-'));
  const first=path.join(dir,'PalDefender-1.log');
  const seen=[];
  await fs.writeFile(first,"[Chat::Global]['Old' (UserId=gdk_old, PlayerId=A)]: !kit starter\n");
  const tailer=new PalDefenderTailer({logDir:dir,onCommand:async ev=>seen.push(ev)});
  await tailer.tick();
  assert.equal(seen.length,0);
  await fs.appendFile(first,"[Chat::Global]['Wery' (UserId=gdk_1, PlayerId=B)]: !kit starter\n");
  await tailer.tick();
  assert.equal(seen.length,1);
  const rotated=path.join(dir,'PalDefender-2.log');
  await new Promise(r=>setTimeout(r,5));
  await fs.writeFile(rotated,"[Chat::Global]['Wery' (UserId=gdk_1, PlayerId=B)]: !kit beginner\n");
  await tailer.tick();
  assert.equal(seen.length,2);
  assert.equal(seen[1].args[0],'beginner');
  await fs.rm(dir,{recursive:true,force:true});
});
