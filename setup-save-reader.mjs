import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const VERSION = 'v0.2.0';
const assets = {
  'linux-x64': {
    archive: 'palworld-save-reader-v0.2.0-linux-amd64.tar.gz',
    sha256: '003d971889dd1b788905f5b03d3b926cc765362f4bee2f894c15ee1eabae1bdb',
    dir: 'palworld-save-reader-v0.2.0-linux-amd64',
    bin: 'palworld-save-reader-linux-amd64'
  },
  'linux-arm64': {
    archive: 'palworld-save-reader-v0.2.0-linux-arm64.tar.gz',
    sha256: '9773b395759305bfa3845a01b363c82919a6c9f934d528ef4a37ae2db82d6911',
    dir: 'palworld-save-reader-v0.2.0-linux-arm64',
    bin: 'palworld-save-reader-linux-arm64'
  },
  'win32-x64': {
    archive: 'palworld-save-reader-v0.2.0-windows-amd64.tar.gz',
    sha256: '2fdafd27764c9145857cd0c3c0d0b9f07e637395f864366083bd4f6ca16d3a09',
    dir: 'palworld-save-reader-v0.2.0-windows-amd64',
    bin: 'palworld-save-reader-windows-amd64.exe'
  }
};

const key = `${process.platform}-${process.arch}`;
const asset = assets[key];
if (!asset) throw new Error(`No automatic save-reader asset is configured for ${key}. Set SAVE_READER_BIN manually.`);

const tools = path.resolve('tools');
const targetDir = path.join(tools, asset.dir);
const targetBin = path.join(targetDir, asset.bin);
if (fsSync.existsSync(targetBin)) {
  if (process.platform !== 'win32') await fs.chmod(targetBin, 0o755).catch(()=>{});
  console.log(`[setup-save-reader] ready ${path.relative(process.cwd(), targetBin)}`);
  process.exit(0);
}

await fs.mkdir(tools, { recursive:true });
const archivePath = path.join(tools, asset.archive);
if (!fsSync.existsSync(archivePath)) {
  const url = `https://github.com/LukeHollandDev/palworld-save-reader/releases/download/${VERSION}/${asset.archive}`;
  console.log(`[setup-save-reader] downloading ${url}`);
  const response = await fetch(url, { redirect:'follow', headers:{ 'User-Agent':'PalControl/0.5.1' } });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.archive}: ${digest}`);
  await fs.writeFile(archivePath, bytes);
} else {
  const bytes = await fs.readFile(archivePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) throw new Error(`Checksum mismatch for existing ${asset.archive}: ${digest}`);
}

await fs.rm(targetDir, { recursive:true, force:true });
await fs.mkdir(targetDir, { recursive:true });
await execFileAsync('tar', ['-xzf', archivePath, '-C', targetDir], { windowsHide:true });
if (!fsSync.existsSync(targetBin)) throw new Error(`Archive extracted but binary was not found at ${targetBin}`);
if (process.platform !== 'win32') await fs.chmod(targetBin, 0o755);
console.log(`[setup-save-reader] installed ${path.relative(process.cwd(), targetBin)}`);
