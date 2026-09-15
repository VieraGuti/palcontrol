import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);

export class UnsupportedProviderAction extends Error {
  constructor(action, provider) {
    super(`${action} is not supported by provider ${provider}.`);
    this.name = 'UnsupportedProviderAction';
    this.action = action;
    this.provider = provider;
  }
}

export class LocalProvider {
  constructor({ startCommand = '', stopCommand = '', restartCommand = '', logger = console } = {}) {
    this.type = 'local';
    this.startCommand = startCommand;
    this.stopCommand = stopCommand;
    this.restartCommand = restartCommand || startCommand;
    this.logger = logger;
  }
  capabilities() {
    return { restart: Boolean(this.restartCommand), stop: Boolean(this.stopCommand), start: Boolean(this.startCommand), remoteFiles: false };
  }
  async run(command, action) {
    if (!command) throw new UnsupportedProviderAction(action, this.type);
    const { stdout, stderr } = await execAsync(command, { timeout: 120_000, windowsHide: true });
    return { ok: true, action, stdout: String(stdout || '').slice(0, 4000), stderr: String(stderr || '').slice(0, 4000) };
  }
  start() { return this.run(this.startCommand, 'start'); }
  stop() { return this.run(this.stopCommand, 'stop'); }
  restart() { return this.run(this.restartCommand, 'restart'); }
  async status() { return { provider: this.type, capabilities: this.capabilities() }; }
}

export class PassiveProvider {
  constructor(type = 'generic') { this.type = type; }
  capabilities() { return { restart: false, stop: false, start: false, remoteFiles: false }; }
  async restart() { throw new UnsupportedProviderAction('restart', this.type); }
  async stop() { throw new UnsupportedProviderAction('stop', this.type); }
  async start() { throw new UnsupportedProviderAction('start', this.type); }
  async status() { return { provider: this.type, capabilities: this.capabilities() }; }
}
