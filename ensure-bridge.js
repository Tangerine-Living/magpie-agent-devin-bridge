#!/usr/bin/env node
// Devin's SessionStart hook runs this. If the bridge already answers, it does
// nothing; otherwise it starts one, detached, and exits. Kept tiny and silent:
// a hook that prints to stdout would land in the agent's context.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applySettings } from './devin-settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.MAGPIE_DEVIN_HOME || path.join(os.homedir(), '.config', 'magpie-devin-bridge');
const configPath = path.join(home, 'config.json');

let listen = '127.0.0.1:8788';
try {
  listen = JSON.parse(fs.readFileSync(configPath, 'utf8')).listen || listen;
} catch {}

const [host, port] = listen.split(':');

// Keep Devin's own settings pointing here while Magpie has the agent switched
// on; this also repairs them after a plugin reinstall clears the connection.
try {
  if (JSON.parse(fs.readFileSync(path.join(home, 'connection.json'), 'utf8')).enabled) {
    applySettings(home, `http://${listen}`);
  }
} catch {}

function answering() {
  return new Promise(resolve => {
    const socket = net.connect({ host: host || '127.0.0.1', port: Number(port || 8788) });
    socket.setTimeout(700);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

if (!(await answering())) {
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [path.join(here, 'bridge.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, MAGPIE_DEVIN_HOME: home },
  });
  child.unref();
  try { fs.writeFileSync(path.join(home, 'bridge.pid'), String(child.pid)); } catch {}
}

process.exit(0);