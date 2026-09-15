import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

const root = path.resolve('.');
const releaseRoot = path.join(root, '.release', `PalControl-v${packageJson.version}`);
const skippedDirectories = new Set(['.git', '.release', 'backups', 'data', 'node_modules']);
const skippedFiles = new Set(['.env']);
const topLevelFiles = [
  'ARCHITECTURE.md',
  'CHANGELOG_v0.5.1.md',
  'CHANGELOG_v0.5.2.md',
  'CHANGELOG_v0.6.0.md',
  'CHANGELOG_v0.6.1.md',
  'CHANGELOG_v0.6.2.md',
  'CHANGELOG_v0.6.3.md',
  'DEPLOY_CYBRANCEE.md',
  'Dockerfile',
  'docker-compose.yml',
  'INTEGRATION_STATUS.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'VERIFICATION_REPORT.md',
  '.env.example',
  '.env.cybrancee.example',
  'package.json',
  'package-lock.json'
];
const topLevelDirectories = ['config', 'docs', 'mods', 'public', 'scripts', 'src', 'tools'];

async function copyTree(source, target, relative = '') {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(relative, entry.name);
    const destination = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name) || (relative === 'mods/PalControlBridge' && entry.name === 'data')) continue;
      await fs.mkdir(destination, { recursive: true });
      await copyTree(path.join(source, entry.name), destination, rel);
      continue;
    }
    if (skippedFiles.has(entry.name) || entry.name.startsWith('.env.') && entry.name !== '.env.example' && entry.name !== '.env.cybrancee.example') continue;
    if (/\.sqlite(?:-shm|-wal)?$/i.test(entry.name)) continue;
    await fs.copyFile(path.join(source, entry.name), destination);
  }
}

await fs.rm(releaseRoot, { recursive: true, force: true });
await fs.mkdir(releaseRoot, { recursive: true });
for (const file of topLevelFiles) {
  await fs.copyFile(path.join(root, file), path.join(releaseRoot, file));
}
for (const directory of topLevelDirectories) {
  const source = path.join(root, directory);
  const target = path.join(releaseRoot, directory);
  await fs.mkdir(target, { recursive: true });
  await copyTree(source, target, directory);
}

const bridgeMain = path.join(releaseRoot, 'mods', 'PalControlBridge', 'Scripts', 'main.lua');
const bridgeSource = await fs.readFile(bridgeMain);
const bridgeHash = crypto.createHash('sha256').update(bridgeSource).digest('hex').toUpperCase();
const bridgeVersion = bridgeSource.toString('utf8').match(/local VERSION\s*=\s*["']([^"']+)["']/)?.[1] ?? 'unknown';
const manifest = {
  product: 'PalControl',
  version: packageJson.version,
  bridgeVersion,
  bridgeSha256: bridgeHash,
  generatedAt: new Date().toISOString(),
  excluded: ['.env', 'node_modules', 'data', 'backups', 'SQLite runtime files', 'mods/PalControlBridge/data']
};
await fs.writeFile(path.join(releaseRoot, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Release prepared: ${releaseRoot}`);
console.log(`PalControl: ${packageJson.version}`);
console.log(`Bridge: ${bridgeVersion}`);
console.log(`Bridge SHA256: ${bridgeHash}`);
