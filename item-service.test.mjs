import test from 'node:test';
import assert from 'node:assert/strict';
import { PalworldItemService } from '../src/services/palworld-item-service.mjs';
import { PalDatabase } from '../src/db.mjs';

const itemCatalog = {
  PalSphere: { id: 'PalSphere', name: 'Pal Sphere' },
  Wood: { id: 'Wood', name: 'Wood' },
  Stone: { id: 'Stone', name: 'Stone' },
  Berries: { id: 'Berries', name: 'Berries' }
};

test('validateItemId rejects unknown items before delivery', () => {
  const service = new PalworldItemService({ itemCatalog, bridge: { enabled: true } });
  assert.equal(service.validateItemId('Wood'), true);
  assert.equal(service.validateItemId('UnknownItem'), false);
});

test('giveItems fails atomically when any item cannot be delivered', async () => {
  const db = new PalDatabase(':memory:');
  const service = new PalworldItemService({
    db,
    itemCatalog,
    bridge: {
      enabled: true,
      giveItems: async () => ({ ok: false, errors: [{ itemId: 'Wood', error: 'bad item' }] })
    }
  });

  await assert.rejects(() => service.giveItems('VieraGuti', [
    { itemId: 'PalSphere', quantity: 1 },
    { itemId: 'Wood', quantity: 1 }
  ]), /failed/i);

  const claim = db.kitClaimed('starter:VieraGuti');
  assert.equal(claim, false);
  db.close();
});

test('giveKit applies cooldown only after successful delivery', async () => {
  const db = new PalDatabase(':memory:');
  let attempts = 0;
  const service = new PalworldItemService({
    db,
    itemCatalog,
    bridge: {
      enabled: true,
      giveItems: async () => {
        attempts += 1;
        return { ok: true, delivered: [{ itemId: 'Wood', quantity: 1 }] };
      }
    },
    clock: () => 1_700_000_000_000
  });

  const result = await service.giveKit('VieraGuti', 'starter');
  assert.equal(result.ok, true);
  assert.equal(service.isOnCooldown('starter', 'VieraGuti'), true);
  assert.equal(attempts, 1);
  db.close();
});
