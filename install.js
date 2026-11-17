#!/usr/bin/env node
// Magpie · Devin bridge installer.
//
//   node install.js install     start the bridge and point Devin's ACP agent at it
//   node install.js status      show what is running and what Devin is set to
//   node install.js uninstall   restore Devin's settings and stop the bridge
//   node install.js restart     stop, then start again
//
// Everything it changes in Devin lives in `devin.acp.agentEnv["devin-cli"]`,
// and the original settings file is kept next to the bridge config.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applyAt, restore as restoreAt, state as stateOf, settingsPath, configPath } from './devin-settings.js';
import { apply as applyRegistry, remove as removeRegistry, state as registryState, registryPath, devinCli } from './devin-registry.js';

const HOME = process.env.MAGPIE_DEVIN_HOME || path.join(os.homedir(), '.config', 'magpie-devin-bridge');
const CONFIG_PATH = process.env.MAGPIE_DEVIN_CONFIG || path.join(HOME, 'config.json');
const BACKUP_PATH = path.join(HOME, 'settings-backup.json');
const STATUS_PATH = path.join(HOME, 'status.json');
const LOG_PATH = path.join(HOME, 'bridge.log');
const PID_PATH = path.join(HOME, 'bridge.pid');

function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function listenTarget() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).listen || '127.0.0.1:8788'; }
  catch { return '127.0.0.1:8788'; }
}

function baseUrl() {
  const [host, port] = listenTarget().split(':');
  return `http://${host || '127.0.0.1'}:${port || 8788}`;
}

function alive(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port: Number(port) });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

// ─── MITM certificates ────────────────────────────────────
//
// Same idea as AnyBridge's certs/: a local CA plus a leaf for the API hosts.
// devin-cli trusts the CA through SSL_CERT_FILE; the editor's Chromium trusts
// it through proxyStrictSSL=false on Windows and the login Keychain on macOS.

const CERTS = path.join(HOME, 'certs');
const CA_PEM = path.join(CERTS, 'ca.pem');

function ensureCerts() {
  const ca = CA_PEM;
  const key = path.join(CERTS, 'ca-key.pem');
  const leaf = path.join(CERTS, 'leaf.pem');
  const leafKey = path.join(CERTS, 'leaf-key.pem');
  if (fs.existsSync(ca) && fs.existsSync(leaf) && fs.existsSync(leafKey)) return true;
  fs.mkdirSync(CERTS, { recursive: true });
  const cnf = path.join(CERTS, 'san.cnf');
  fs.writeFileSync(cnf, [
    '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
    '[dn]', 'CN=server.codeium.com',
    '[v3]', 'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:server.codeium.com,DNS:server.self-serve.windsurf.com,DNS:api.codeium.com,DNS:*.codeium.com,DNS:*.windsurf.com',
    '',
  ].join(String.fromCharCode(10)));
  const run = args => {
    const r = spawnSync('openssl', args, { windowsHide: true, encoding: 'utf8' });
    if (r.error) throw new Error('openssl is needed to make the proxy certificate: ' + r.error.message);
    if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || '').trim()}`);
  };
  // A config file instead of -subj/-addext: macOS ships LibreSSL, whose older
// versions reject -addext.
  const caCnf = path.join(CERTS, 'ca.cnf');
  fs.writeFileSync(caCnf, [
    '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
    '[dn]', 'CN=Magpie Devin Local CA',
    '[v3]', 'basicConstraints=critical,CA:TRUE',
    'keyUsage=critical,keyCertSign,cRLSign',
    '',
  ].join(String.fromCharCode(10)));
  if (!fs.existsSync(ca)) {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', ca, '-days', '3650',
      '-config', caCnf]);
  }
  const csr = path.join(CERTS, 'leaf.csr');
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', leafKey, '-out', csr, '-config', cnf]);
  run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', key, '-CAcreateserial', '-out', leaf,
    '-days', '825', '-extfile', cnf, '-extensions', 'v3']);
  try { fs.unlinkSync(csr); } catch {}
  return true;
}

// macOS validates the GUI's TLS against the Keychain, not against
// proxyStrictSSL. Add the local CA once (the dialog asks for the login
// password); the devin-cli side only needs SSL_CERT_FILE.
function trustCa() {
  if (process.platform !== 'darwin') return '';
  const keychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
  const r = spawnSync('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, CA_PEM], {
    encoding: 'utf8',
    timeout: 20000,
  });
  if (r.status === 0) return 'CA trusted in the login keychain';
  return `trust the CA once: security add-trusted-cert -r trustRoot -k "${keychain}" "${CA_PEM}"`;
}


// ─── Devin SessionStart hook ──────────────────────────────
//
// Devin's own config.json may carry hooks; a SessionStart hook runs once per
// session and is what brings the bridge up when Devin starts, so nothing has
// to run at login.

// Use this Node binary, not "node": Devin on macOS starts the hook from the
// GUI, whose PATH often has no Node installed at all.
const HOOK_COMMAND = `"${process.execPath}" "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure-bridge.js')}"`;

function hookState() {
  try {
    const json = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const runs = (json.hooks?.SessionStart || []).flatMap(entry => entry.hooks || []);
    return runs.some(run => String(run.command || '').includes('ensure-bridge.js')) ? 'installed' : 'missing';
  } catch {
    return 'unreadable';
  }
}

function installHook() {
  const file = configPath();
  let json = {};
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (hookState() === 'installed') return false;
  json.hooks = json.hooks || {};
  json.hooks.SessionStart = json.hooks.SessionStart || [];
  json.hooks.SessionStart.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return true;
}

function removeHook() {
  const file = configPath();
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 'no config to clean'; }
  const groups = json.hooks?.SessionStart;
  if (!Array.isArray(groups)) return 'hook was not installed';
  const kept = groups
    .map(entry => ({ ...entry, hooks: (entry.hooks || []).filter(run => !String(run.command || '').includes('ensure-bridge.js')) }))
    .filter(entry => (entry.hooks || []).length > 0);
  if (kept.length) json.hooks.SessionStart = kept;
  else {
    delete json.hooks.SessionStart;
    if (!Object.keys(json.hooks).length) delete json.hooks;
  }
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return 'SessionStart hook removed';
}

// ─── bridge process ────────────────────────────────────────

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge.js');

function startBridge() {
  fs.mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, [BRIDGE], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, MAGPIE_DEVIN_HOME: HOME },
  });
  child.unref();
  fs.writeFileSync(PID_PATH, String(child.pid));
  return child.pid;
}

function stopBridge() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8'));
    if (pid) process.kill(pid);
    fs.unlinkSync(PID_PATH);
    return pid;
  } catch {
    return 0;
  }
}

function writeStatus(text) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STATUS_PATH, JSON.stringify({
    state: text, updated: new Date().toISOString(),
  }, null, 2));
}

async function waitAlive(host, port, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await alive(host, port)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// ─── commands ──────────────────────────────────────────────

async function install() {
  ensureCerts();
  const trust = trustCa();
  if (trust) console.log(trust);
  const mitmPort = Number(config().mitmPort || 7450);
  const url = baseUrl();
  const [host, port] = listenTarget().split(':');
  let running = await alive(host, port);
  // A bridge started before the MITM existed answers on 8788 but not on the
  // proxy port; restart it so the editor's own traffic is intercepted too.
  if (running && !(await alive('127.0.0.1', mitmPort))) {
    stopBridge();
    await new Promise(r => setTimeout(r, 600));
    running = false;
  }
  if (!running) {
    const pid = startBridge();
    const up = await waitAlive(host, port);
    console.log(up ? `bridge started (pid ${pid}) at ${url}` : `bridge did not answer at ${url}; see ${LOG_PATH}`);
  } else {
    console.log(`bridge already listening at ${url}`);
  }
  applyAt(HOME, url, { proxy: `http://127.0.0.1:${mitmPort}`, ca: CA_PEM });
  const hooked = installHook();
  writeStatus(`connected; Devin's agent uses ${url}`);
  console.log(`Devin: ${stateOf(url)}`);
  console.log(hooked ? 'Devin: SessionStart hook installed (starts the bridge when Devin does)' : 'Devin: SessionStart hook already installed');
  const reg = applyRegistry(url);
  console.log(`${reg ? 'Devin: agent "Devin via Magpie" added to' : 'Devin: agent already in'} ${registryPath()}`);
  console.log('Restart Devin (or its agent session) for the change to take effect.');
}

async function status() {
  const [host, port] = listenTarget().split(':');
  const running = await alive(host, port);
  console.log(`bridge:  ${running ? 'listening' : 'not listening'} at ${baseUrl()}`);
  console.log(`Devin:   ${stateOf(baseUrl())}`);
  console.log(`config:  ${CONFIG_PATH}`);
  console.log(`log:     ${LOG_PATH}`);
  const c = config();
  console.log(`model:   ${c.model || c.models?.['*'] || '(unset)'}`);
  console.log(`proxy:   ${(await alive('127.0.0.1', Number(config().mitmPort || 7450))) ? 'listening' : 'not listening'} at 127.0.0.1:${config().mitmPort || 7450}`);
  console.log(`hook:    ${hookState()}`);
  console.log(`agent:   ${registryState()} (${registryPath()})`);
}

async function uninstall() {
  const pid = stopBridge();
  const restored = restoreAt(HOME);
  const unhooked = removeHook();
  const unregistered = removeRegistry();
  writeStatus('disconnected');
  console.log(pid ? `stopped bridge (pid ${pid})` : 'bridge was not running');
  console.log(restored);
  console.log(unhooked);
  console.log(unregistered ? 'local ACP agent removed' : 'local ACP agent was not registered');
  console.log('Restart Devin for its own server to be used again.');
}

async function restart() {
  stopBridge();
  await new Promise(r => setTimeout(r, 600));
  const [host, port] = listenTarget().split(':');
  if (await alive(host, port)) {
    console.log('another bridge still answers; leaving it alone');
    return;
  }
  await install();
}

const command = process.argv[2] || 'install';
const commands = { install, status, uninstall, restart };
if (!commands[command]) {
  console.log('usage: node install.js [install|status|uninstall|restart]');
  process.exit(2);
}
commands[command]().catch(err => {
  console.error('✖', err.message);
  process.exit(1);
});