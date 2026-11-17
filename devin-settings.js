// Everything that touches Devin's own settings.json lives here, so the
// in-process bridge and the standalone installer cannot drift apart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function settingsPath() {
  if (process.env.DEVIN_SETTINGS) return process.env.DEVIN_SETTINGS;
  const roots = [];
  if (process.platform === 'win32') {
    roots.push(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support'));
  } else {
    roots.push(path.join(os.homedir(), '.config'));
  }
  // The desktop app's product name is "Devin"; older builds used lowercase.
  // Windows is case-insensitive, macOS and Linux are not, so pick whichever
  // directory actually exists.
  const candidates = roots
    .flatMap(root => ['Devin', 'devin'].map(name => path.join(root, name, 'User', 'settings.json')))
    .filter((file, i, all) => all.indexOf(file) === i);
  return candidates.find(file => fs.existsSync(file)) || candidates[0];
}

export function configPath() {
  return path.join(path.dirname(path.dirname(settingsPath())), 'config.json');
}

export function backupPath(home) {
  return path.join(home, 'settings-backup.json');
}

export function readSettings(file = settingsPath()) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { file, text, json: JSON.parse(text) };
  } catch (err) {
    throw new Error(`${file} is not plain JSON (${err.message}); open it in Devin and save it once without comments, then try again`);
  }
}

function agentEnv(json) {
  json['devin.acp.agentEnv'] = json['devin.acp.agentEnv'] || {};
  json['devin.acp.agentEnv']['devin-cli'] = json['devin.acp.agentEnv']['devin-cli'] || {};
  return json['devin.acp.agentEnv']['devin-cli'];
}

function withNoProxy(current) {
  const parts = String(current || '').split(',').map(x => x.trim()).filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!parts.some(p => p.toLowerCase() === host)) parts.push(host);
  }
  return parts.join(',');
}

// Writes the three variables Devin's ACP agent needs, keeping the original
// file's text in the journal the first time around. Returns true when the
// file actually changed, so a supervisor can skip needless writes.
export function apply(home, url, options = {}) {
  const file = settingsPath();
  const { text, json } = readSettings(file);
  const journal = backupPath(home);
  if (!fs.existsSync(journal)) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(journal, JSON.stringify({ savedAt: new Date().toISOString(), settingsPath: file, text }, null, 2));
  }
  const env = agentEnv(json);
  const before = JSON.stringify(json);
  env.WINDSURF_API_SERVER_URL = url;
  env.WINDSURF_API_KEY = env.WINDSURF_API_KEY || 'magpie-bridge';
  env.NO_PROXY = withNoProxy(env.NO_PROXY || process.env.NO_PROXY);
  if (options.proxy) {
    env.HTTP_PROXY = options.proxy;
    env.HTTPS_PROXY = options.proxy;
    json['http.proxy'] = options.proxy;
    json['http.proxyStrictSSL'] = false;
    json['http.proxySupport'] = 'override';
    if (options.ca) {
      env.SSL_CERT_FILE = options.ca;
      env.NODE_EXTRA_CA_CERTS = options.ca;
    }
  }
  json['devin.acp.enabledAgents'] = json['devin.acp.enabledAgents'] || {};
  json['devin.acp.enabledAgents']['devin-cli'] = true;
  if (JSON.stringify(json) === before) return false;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return true;
}

// Puts back exactly what the file held before the first apply().
export function restore(home) {
  const journal = backupPath(home);
  if (!fs.existsSync(journal)) return 'no backup to restore';
  const backup = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (backup.settingsPath !== settingsPath()) return `backup belongs to ${backup.settingsPath}`;
  fs.writeFileSync(backup.settingsPath, backup.text, 'utf8');
  fs.unlinkSync(journal);
  return `restored ${backup.settingsPath}`;
}

export function state(url) {
  try {
    const { json } = readSettings();
    const env = json['devin.acp.agentEnv']?.['devin-cli'] || {};
    return env.WINDSURF_API_SERVER_URL === url
      ? 'pointed at the bridge'
      : `points at ${env.WINDSURF_API_SERVER_URL || 'the official server'}`;
  } catch (err) {
    return `unreadable: ${err.message}`;
  }
}