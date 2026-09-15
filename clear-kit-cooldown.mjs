import path from 'node:path';
import { config } from '../src/config.mjs';
import { PalDatabase } from '../src/db.mjs';

const kitId = String(process.argv[2] ?? '').trim();
if (!kitId) {
  console.error('Usage: npm run kit:clear -- <kitId>');
  console.error('Example: npm run kit:clear -- start');
  process.exit(2);
}

const db = new PalDatabase(path.resolve(config.databasePath));
try {
  const changes = db.clearKitClaimsByKit(kitId);
  console.log(`Cleared ${changes} cooldown claim(s) for kit ${kitId}.`);
} finally {
  db.close();
}
