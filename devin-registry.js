// Devin's local ACP agent registry (JSONC).
//
// The desktop merges this file with the registry it gets from Cognition. An
// entry here whose distribution sets WINDSURF_API_SERVER_URL gives the user an
// explicit "Devin via Magpie" agent in the agent picker — the same CLI, wired
// to the bridge, without touching the bundled devin-cli entry.
//
// The extension looks for it under the Windsurf config directory, which this
// Devin build spells as %APPDATA%\Code\User even though the app's own settings
// live in %APPDATA%\devin\User. Write both, so whichever one the build reads
// finds the entry.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENT_ID = 'magpie-devin';

export function registryPaths() {
  if (process.env.DEVIN_ACP_REGISTRY) return [process.env.DEVIN_ACP_REGISTRY];
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'win32') {
    return [
      path.join(appdata, 'devin', 'acp', 'registry.json'),
      path.join(appdata, 'Code', 'User', 'acp', 'registry.json'),
    ];
  }
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    return ['Devin', 'devin'].map(name => path.join(base, name, 'acp', 'registry.json'));
  }
  return [path.join(os.homedir(), '.config', 'devin', 'acp', 'registry.json')];
}

export function registryPath() {
  return registryPaths()[0];
}

function read() {
  try {
    const text = fs.readFileSync(registryPath(), 'utf8');
    // JSONC, but the file is written by this module; tolerate comments by
    // falling back to an empty registry rather than corrupting the file.
    return JSON.parse(text);
  } catch {
    return { version: '1.0.0', agents: [] };
  }
}

function write(json) {
  for (const file of registryPaths()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
}

export function devinCli() {
  if (process.env.DEVIN_CLI) return process.env.DEVIN_CLI;
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      'D:\\DevSpace\\Tools\\Devin\\resources\\app\\extensions\\windsurf\\devin\\bin\\devin.exe',
    );
  } else if (process.platform === 'darwin') {
    const relative = 'Contents/Resources/app/extensions/windsurf/devin/bin/devin';
    candidates.push(
      path.join('/Applications', 'Devin.app', relative),
      path.join(os.homedir(), 'Applications', 'Devin.app', relative),
    );
  }
  const known = candidates.find(file => fs.existsSync(file));
  return known || (process.platform === 'win32' ? 'devin.exe' : 'devin');
}

export function entry(url) {
  const target = () => ({
    archive: '',
    cmd: devinCli(),
    args: ['acp'],
    env: {
      WINDSURF_API_SERVER_URL: url,
      WINDSURF_API_KEY: 'magpie-bridge',
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
  });
  // Entries carry the binary path of the machine writing them, so only the
// running platform's architectures are listed: an entry for another OS would
// point at a path that does not exist there.
  const binary = {};
  if (process.platform === 'darwin') {
    binary['darwin-x86_64'] = target();
    binary['darwin-aarch64'] = target();
  } else if (process.platform === 'win32') {
    binary['windows-x86_64'] = target();
    binary['windows-aarch64'] = target();
  } else {
    binary['linux-x86_64'] = target();
  }
  return {
    id: AGENT_ID,
    name: 'Devin via Magpie',
    version: '1.0.0',
    description: 'Devin CLI through the local Magpie bridge (Magpie models and routing groups)',
    authors: ['magpie-devin-bridge'],
    license: 'MIT',
    distribution: { binary },
  };
}

export function apply(url) {
  const mine = entry(url);
  let changed = false;
  for (const file of registryPaths()) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { json = { version: '1.0.0', agents: [] }; }
    if (!Array.isArray(json.agents)) json.agents = [];
    const at = json.agents.findIndex(a => a && a.id === AGENT_ID);
    if (at >= 0 && JSON.stringify(json.agents[at]) === JSON.stringify(mine)) continue;
    if (at >= 0) json.agents[at] = mine;
    else json.agents.push(mine);
    json.version = json.version || '1.0.0';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
    changed = true;
  }
  return changed;
}

export function remove() {
  let changed = false;
  for (const file of registryPaths()) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!Array.isArray(json.agents)) continue;
    const kept = json.agents.filter(a => !a || a.id !== AGENT_ID);
    if (kept.length === json.agents.length) continue;
    json.agents = kept;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
    changed = true;
  }
  return changed;
}

export function state() {
  for (const file of registryPaths()) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((json.agents || []).some(a => a && a.id === AGENT_ID)) return `registered (${file})`;
    } catch {}
  }
  return 'missing';
}