import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SaveReaderService } from '../src/services/save-reader.mjs';

test('save reader sidecar probes and parses the supported CLI JSON envelope', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'palsave-reader-'));
  const calls = [];
  const fakeExec = async (bin, args) => {
    calls.push({ bin, args:[...args] });
    if (args[0] === '--version') return { stdout:'palworld-save-reader v0.3.0\n', stderr:'' };
    if (args[0] === '--resolve' && args[1] === 'roster') return { stdout:JSON.stringify({resolveVersion:4,kind:'roster',roster:[{playerUId:'ABC',character:{nickname:'Wery',level:55}}]}), stderr:'' };
    throw new Error(`unexpected fake reader args: ${args.join(' ')}`);
  };
  const svc = new SaveReaderService({enabled:true,bin:'fake-reader',savesPath:dir,execFileFn:fakeExec});
  const probe = await svc.probe();
  assert.equal(probe.ready,true);
  assert.match(probe.version,/v0\.3\.0/);
  const roster = await svc.roster();
  assert.equal(roster.resolveVersion,4);
  assert.equal(roster.roster[0].character.nickname,'Wery');
  assert.equal(calls[0].args[0],'--version');
  assert.deepEqual(calls[1].args.slice(0,2),['--resolve','roster']);
  await fs.rm(dir,{recursive:true,force:true});
});
