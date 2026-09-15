import { Client } from 'basic-ftp';
import { config } from '../src/config.mjs';

const { host, port, user, password, secure } = config.remoteFiles.ftp;
const maxDepth = Number(process.env.FTP_DISCOVERY_DEPTH || 5);
const maxDirectories = Number(process.env.FTP_DISCOVERY_MAX_DIRS || 250);

if (!host || !user || !password) throw new Error('Set FTP_HOST, FTP_USER and FTP_PASSWORD first.');

const client = new Client(30_000);
client.ftp.verbose = false;
const matches = [];
let directories = 0;

async function inspect(remotePath) {
  try { return await client.list(remotePath); }
  catch { return null; }
}

async function walk(remotePath, depth) {
  if (depth > maxDepth || directories >= maxDirectories) return;
  directories += 1;
  if (directories % 25 === 0) console.log(`Scanned ${directories} directories...`);
  const entries = await inspect(remotePath);
  if (!entries) return;
  const names = entries.map(entry => entry.name);
  if (names.includes('Level.sav') && names.includes('Players')) matches.push({ type: 'save', path: remotePath });
  if (names.some(name => /paldefender|log/i.test(name))) matches.push({ type: 'possible-log-root', path: remotePath });
  for (const entry of entries) {
    if (entry.type !== 2 || entry.name === '.' || entry.name === '..') continue;
    const child = remotePath === '/' ? `/${entry.name}` : `${remotePath}/${entry.name}`;
    await walk(child, depth + 1);
  }
}

try {
  await client.access({ host, port, user, password, secure });
  console.log(`Connected to ${host}:${port}`);
  const candidates = [
    '/Pal/Saved/SaveGames/0',
    '/Pal/Binaries/Win64/PalDefender/Logs',
    '/Pal/Pal/Saved/SaveGames/0',
    '/Pal/Pal/Binaries/Win64/PalDefender/Logs'
  ];
  for (const candidate of candidates) {
    const entries = await inspect(candidate);
    if (!entries) continue;
    console.log(`Found FTP path: ${candidate}`);
    const names = entries.map(entry => entry.name);
    if (names.includes('Level.sav') && names.includes('Players')) matches.push({ type: 'save-root', path: candidate });
    if (candidate.toLowerCase().includes('logs')) matches.push({ type: 'log-root', path: candidate });
  }
  if (!matches.some(match => match.type === 'save-root')) await walk('/', 0);
  console.log(JSON.stringify({ scannedDirectories: directories, matches }, null, 2));
} finally {
  client.close();
}