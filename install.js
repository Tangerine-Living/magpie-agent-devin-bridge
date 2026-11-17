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
// Devin trusts the CA through SSL_CERT_FILE (its CLI) and proxyStrictSSL=false
// (the extension), so no certificate has to be installed system-wide.

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
  if (!fs.existsSync(ca)) {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', ca, '-days', '3650',
      '-subj', '/CN=Magpie Devin Local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }
  const csr = path.join(CERTS, 'leaf.csr');
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', leafKey, '-out', csr, '-config', cnf]);
  run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', key, '-CAcreateserial', '-out', leaf,
    '-days', '825', '-extfile', cnf, '-extensions', 'v3']);
  try { fs.unlinkSync(csr); } catch {}
  return true;
}


// ─── sessions.html script injection (AnyBridge's workbench_inject) ────────
//
// The new Devin UI renders its model menu from its own front-end state, so
// changing the RPC responses is not enough. AnyBridge solves the same problem
// by injecting a script into the IDE's own HTML; this is the same trick for
// Devin's sessions window: a same-origin script (CSP allows 'self') that
// renames the model entries it can see to Magpie's models. Selection still
// sends Devin's own uid, and the bridge maps it to Magpie's chosen model.

const SCRIPT_NAME = 'magpie-models.js';
const MARK = '<!-- magpie-models -->';

function appRoot() {
  const cli = devinCli();
  const norm = cli.split(String.fromCharCode(92)).join('/');
  const i = norm.indexOf('/resources/app/');
  return i >= 0 ? norm.slice(0, i + '/resources/app'.length) : '';
}

function sessionsHtml() {
  const root = appRoot();
  return root ? path.join(root.replace(/\//g, String.fromCharCode(92)), 'out', 'vs', 'sessions', 'electron-browser', 'sessions.html') : '';
}

function modelNames() {
  let c = config();
  try {
    const conn = JSON.parse(fs.readFileSync(path.join(HOME, 'connection.json'), 'utf8'));
    if (Array.isArray(conn.models) && conn.models.length) c = { ...c, exposedModels: conn.models.map(m => (typeof m === 'string' ? m : m.id)) };
  } catch {}
  const list = Array.isArray(c.exposedModels) && c.exposedModels.length ? c.exposedModels : [c.model].filter(Boolean);
  return list.map(m => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
}

function injectSessions(enable) {
  const file = sessionsHtml();
  if (!file || !fs.existsSync(file)) return 'sessions.html not found';
  const backup = file + '.magpie-origin';
  const scriptFile = path.join(path.dirname(file), SCRIPT_NAME);
  if (!enable) {
    if (fs.existsSync(backup)) fs.writeFileSync(file, fs.readFileSync(backup), 'utf8');
    try { fs.unlinkSync(backup); } catch {}
    try { fs.unlinkSync(scriptFile); } catch {}
    return 'sessions.html restored';
  }
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const names = modelNames();
  const js = `(function(){
const NAMES=${JSON.stringify(names)};
const RE=/^(SWE-|Kimi|GLM-|DeepSeek|Nemotron|Fusion|Adaptive|Fable|MAE?-|Claude|GPT-)/i;
let i=0;
function walk(root){
  if(!root) return;
  const it=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,null);
  while(it.nextNode()){
    const n=it.currentNode;
    if(n.nodeType===1){ if(n.shadowRoot) walk(n.shadowRoot); continue; }
    const t=(n.nodeValue||'').trim();
    if(t&&t.length<40&&RE.test(t)&&!n.parentElement?.dataset.magpie){ n.nodeValue=NAMES[i++%NAMES.length]; n.parentElement.dataset.magpie='1'; }
  }
}
setInterval(()=>{ try{ walk(document); }catch(e){} }, 800);
})();`;
  fs.writeFileSync(scriptFile, js, 'utf8');
  let html = fs.readFileSync(file, 'utf8');
  if (!html.includes(MARK)) {
    html = html.replace('</head>', `${MARK}<script src="./${SCRIPT_NAME}"></script></head>`);
    fs.writeFileSync(file, html, 'utf8');
  }
  return `sessions.html patched (${names.length} names)`;
}

// ─── Devin SessionStart hook ──────────────────────────────
//
// Devin's own config.json may carry hooks; a SessionStart hook runs once per
// session and is what brings the bridge up when Devin starts, so nothing has
// to run at login.

const HOOK_COMMAND = `node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure-bridge.js')}"`;

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