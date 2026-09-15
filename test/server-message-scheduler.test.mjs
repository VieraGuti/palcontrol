import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerMessageService } from '../src/services/server-message-service.mjs';
import { PalDatabase } from '../src/db.mjs';

test('message templates resolve player/server variables', () => {
  const service = new ServerMessageService({
    rest: { announce: async () => ({ ok: true }) },
    bridge: { enabled: false },
    db: new PalDatabase(':memory:'),
    poller: { snapshot: () => ({ players: [{ name: 'VieraGuti' }], metrics: { currentplayernum: 1, maxplayernum: 4 } }) },
    serverName: 'Stick Drift Society'
  });

  const rendered = service.renderTemplate('Welcome {player} to {server}! {online}/{maxPlayers}', {
    player: 'VieraGuti',
    online: 1,
    maxPlayers: 4,
    server: 'Stick Drift Society'
  });

  assert.equal(rendered, 'Welcome VieraGuti to Stick Drift Society! 1/4');
  service.db.close();
});

test('scheduled messages do not advance nextRunAt when delivery fails', async () => {
  const db = new PalDatabase(':memory:');
  const service = new ServerMessageService({
    db,
    rest: { announce: async () => { throw new Error('announce failed'); } },
    bridge: { enabled: false },
    now: () => 1_700_000_000_000,
    serverName: 'Stick Drift Society'
  });

  const id = service.scheduleMessage('Failing message', { intervalMinutes: 15, enabled: true });
  await service.processScheduled();
  const row = db.scheduledMessages().find((m) => m.id === id);
  assert.equal(row.last_run_at, null);
  assert.ok(Number(row.next_run_at) > 1_700_000_000_000);
  db.close();
});
