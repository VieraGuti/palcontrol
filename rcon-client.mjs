import net from 'node:net';
import { randomInt } from 'node:crypto';

const SERVERDATA_RESPONSE_VALUE = 0;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;

function packet(id, type, body = '') {
  const payload = Buffer.from(body + '\0\0', 'utf8');
  const out = Buffer.alloc(12 + payload.length);
  out.writeInt32LE(out.length - 4, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  payload.copy(out, 12);
  return out;
}

function decodePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || buffer.length - offset < size + 4) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.subarray(offset + 12, offset + 4 + size - 2).toString('utf8');
    packets.push({ id, type, body });
    offset += size + 4;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export class SourceRconClient {
  constructor({ host, port = 25575, password, timeoutMs = 5000 }) {
    this.host = host; this.port = port; this.password = password; this.timeoutMs = timeoutMs;
  }

  async exec(command) {
    if (!this.password) throw new Error('RCON password is not configured.');
    const socket = net.createConnection({ host: this.host, port: this.port });
    let buffer = Buffer.alloc(0);
    let authed = false;
    const authId = randomInt(1, 2 ** 30);
    const commandId = randomInt(1, 2 ** 30);
    const chunks = [];

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`RCON timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
      const finish = (err, value) => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
        err ? reject(err) : resolve(value);
      };
      socket.on('error', finish);
      socket.on('connect', () => socket.write(packet(authId, SERVERDATA_AUTH, this.password)));
      socket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        const decoded = decodePackets(buffer); buffer = decoded.rest;
        for (const p of decoded.packets) {
          if (!authed && p.type === SERVERDATA_AUTH_RESPONSE) {
            if (p.id === -1) return finish(new Error('RCON authentication failed.'));
            if (p.id === authId) {
              authed = true;
              socket.write(packet(commandId, SERVERDATA_EXECCOMMAND, command));
              continue;
            }
          }
          if (authed && p.id === commandId && p.type === SERVERDATA_RESPONSE_VALUE) {
            chunks.push(p.body);
            setTimeout(() => finish(null, chunks.join('')), 80);
          }
        }
      });
    });
  }
}

export { decodePackets, packet as encodePacket };
