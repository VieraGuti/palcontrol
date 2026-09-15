import test from 'node:test';
import assert from 'node:assert/strict';
import { WhitelistService } from '../src/services/whitelist-service.mjs';

test('PalDefender whitelist service emits documented RCON commands', async()=>{
  const commands=[];const rcon={password:'x',exec:async cmd=>{commands.push(cmd);return 'ok';}};
  const service=new WhitelistService({rcon,enabled:true});
  await service.add('steam_123'); await service.remove('steam_123'); await service.list();
  assert.deepEqual(commands,['/whitelist_add steam_123','/whitelist_remove steam_123','/whitelist_get']);
});
