#!/usr/bin/env node
// Magpie · Devin bridge
//
// Devin's ACP agent (devin.exe acp) talks to an HTTP API that speaks
// Connect-RPC (exa.api_server_pb.ApiServerService). WINDSURF_API_SERVER_URL
// points it at this server instead of server.codeium.com, and every chat turn
// is translated into Magpie's OpenAI-compatible /v1/chat/completions call.
//
// No TLS, no MITM, no proxy: Devin talks plain HTTP to 127.0.0.1.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { extractModelList, unlockModels } from './anybridge/rename-models.js';
import { apply as applyDevinSettings, restore as restoreDevinSettings, state as devinState } from './devin-settings.js';

const HOME = process.env.MAGPIE_DEVIN_HOME || path.join(os.homedir(), '.config', 'magpie-devin-bridge');
const CONFIG_PATH = process.env.MAGPIE_DEVIN_CONFIG || path.join(HOME, 'config.json');
const CONNECTION_PATH = path.join(HOME, 'connection.json');
const LOG_PATH = process.env.MAGPIE_DEVIN_LOG || path.join(HOME, 'bridge.log');
const DEVIN_MODELS_PATH = path.join(HOME, 'devin-models.json');

// The copy shipped in the plugin is only a bootstrap. The editor menu's slots
// are built from THIS user's Magpie models on first run, so a fresh install
// never lists models the user does not have.
const BUNDLED_ANYBRIDGE_CONFIG = fileURLToPath(new URL('./anybridge-config/', import.meta.url));
const ANYBRIDGE_CONFIG = path.join(HOME, 'anybridge-config');
try {
  fs.mkdirSync(ANYBRIDGE_CONFIG, { recursive: true });
  if (!fs.existsSync(path.join(ANYBRIDGE_CONFIG, 'providers.json'))) {
    fs.cpSync(BUNDLED_ANYBRIDGE_CONFIG, ANYBRIDGE_CONFIG, { recursive: true });
  }
} catch (err) {
  console.error('magpie-devin: anybridge config bootstrap failed:', err.message);
}
process.env.BYOK_CONFIG_DIR = process.env.BYOK_CONFIG_DIR || ANYBRIDGE_CONFIG;

// ─── config ────────────────────────────────────────────────

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// config.json is the bridge's own settings; connection.json is what Magpie
// writes when the agent is switched on (gateway, key, model, model catalog,
// enabled). Both are re-read per request, so a model change in Magpie's
// Agents page applies to the next turn without restarting anything.
function current() {
  const base = readJSON(CONFIG_PATH);
  const conn = readJSON(CONNECTION_PATH);
  const merged = { ...base };
  if (conn.magpie) merged.magpie = conn.magpie;
  if (conn.gateway) merged.magpie = conn.gateway;
  if (conn.key) merged.key = conn.key;
  if (conn.model) merged.model = conn.model;
  if (Array.isArray(conn.models) && conn.models.length) {
    merged.exposedModels = conn.models
      .map(m => (typeof m === 'string' ? m : m && m.id))
      .filter(Boolean);
  }
  if (conn.enabled !== undefined) merged.enabled = conn.enabled === true;
  return merged;
}

function magpieBase(cfg) {
  return String(cfg.magpie || 'http://127.0.0.1:3425/v1').replace(/\/+$/, '');
}

// ─── editor model menu: per-user slot map ─────────────────

// "ccx/loomy/spark-x2.6" → "ccx/loomy-spark-x2.6": keep the vendor as the
// group prefix, flatten the rest so the picker shows one group per vendor.
function flattenModelLabel(id) {
  const s = String(id || '');
  const i = s.indexOf('/');
  return i > 0 ? s.slice(0, i + 1) + s.slice(i + 1).replace(/\//g, '-') : s;
}

function syncModelMap(uids) {
  if (!Array.isArray(uids) || !uids.length) return;
  const cfg = current();
  const models = [...new Set((Array.isArray(cfg.exposedModels) ? cfg.exposedModels : []).filter(Boolean))];
  if (!models.length) return;
  const dir = process.env.BYOK_CONFIG_DIR;
  const file = path.join(dir, 'model-map.json');
  const map = readJSON(file);
  const slots = Array.isArray(map.slots) ? map.slots : [];
  // A map that already covers this user's own models is theirs; leave it alone.
  const covered = slots.length > 0 && slots.every(s => {
    const t = s && Array.isArray(s.targets) ? s.targets[0] : null;
    return !!(t && t.model && models.includes(t.model));
  });
  if (covered) return;
  const provider = (readJSON(path.join(dir, 'providers.json')).providers || [])[0];
  const providerId = (provider && provider.id) || 'magpie';
  const n = Math.min(models.length, uids.length);
  const next = {
    labelTemplate: '{label}',
    namePrefix: '',
    slotVisibilityMode: 'mapped',
    unlockScope: 'all',
    slots: models.slice(0, n).map((id, i) => ({
      modelUid: uids[i],
      displayName: flattenModelLabel(id),
      enabled: true,
      targets: [{ providerId, model: id }],
    })),
    injected: [],
    enhancement: { unlockModels: true, autoRouting: true },
  };
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    console.log(`· editor model map generated: ${n} slots for this Magpie account`);
  } catch (err) {
    console.error('magpie-devin: model map write failed:', err.message);
  }
}

// Remember the Devin model UIDs the server actually offers, then map this
// user's Magpie models onto them. Cheap and idempotent: runs on heartbeats.
// UIDs the server sends that are not pickable models (agent defaults, org
// ids, streaming placeholders). Mapping a Magpie model onto them would waste
// a menu slot.
const NON_MODEL_UIDS = new Set(['subagent-default', 'LLAMA_WITH_SPECIAL', 'NVIDIA', 'swe-1-6']);

function isModelUid(uid) {
  if (!uid || NON_MODEL_UIDS.has(uid) || uid.startsWith('org-')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(uid);
}

function saveDevinModels(body) {
  try {
    const list = extractModelList(body);
    const uids = (Array.isArray(list) ? list : [])
      .map(x => x && x.modelUid)
      .filter(isModelUid);
    if (!uids.length) return;
    const prev = readJSON(DEVIN_MODELS_PATH);
    const same = Array.isArray(prev.uids) && prev.uids.length === uids.length
      && prev.uids.every((u, i) => u === uids[i]);
    if (!same) fs.writeFileSync(DEVIN_MODELS_PATH, JSON.stringify({ updated: Date.now(), uids }, null, 2));
    syncModelMap(uids);
  } catch { /* heartbeats must never fail on this */ }
}

// Rebuild the map on restart too, so a model change in Magpie applies even
// before the next heartbeat arrives.
syncModelMap((readJSON(DEVIN_MODELS_PATH).uids) || []);

// ─── logging ───────────────────────────────────────────────

let quiet = readJSON(CONFIG_PATH).verbose === false;

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  if (!quiet) console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

// ─── protobuf wire format ──────────────────────────────────

function varint(value) {
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n;
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

function decodeVarint(buf, offset) {
  let result = 0n, shift = 0n, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, bytesRead: pos - offset };
}

function tag(field, wire) { return varint((field << 3) | wire); }
function fVarint(field, value) { return Buffer.concat([tag(field, 0), varint(value)]); }
function fBytes(field, buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([tag(field, 2), varint(data.length), data]);
}
function fString(field, str) { return fBytes(field, Buffer.from(str, 'utf8')); }
function fMessage(field, buf) { return fBytes(field, buf); }
function fFixed64(field, buf8) { return Buffer.concat([tag(field, 1), buf8]); }
function fDouble(field, value) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value, 0);
  b.swap64();
  return fFixed64(field, b);
}

function parseFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const t = decodeVarint(buf, offset);
    offset += t.bytesRead;
    const field = Number(t.value >> 3n);
    const wire = Number(t.value & 7n);
    if (!field) break;
    if (wire === 0) {
      const v = decodeVarint(buf, offset);
      offset += v.bytesRead;
      fields.push({ field, wire, value: Number(v.value) });
    } else if (wire === 2) {
      const l = decodeVarint(buf, offset);
      offset += l.bytesRead;
      const len = Number(l.value);
      if (len < 0 || offset + len > buf.length) break;
      fields.push({ field, wire, value: buf.subarray(offset, offset + len) });
      offset += len;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) break;
      fields.push({ field, wire, value: buf.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) break;
      fields.push({ field, wire, value: buf.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

const get = (fields, n, wire) => fields.find(f => f.field === n && (wire === undefined || f.wire === wire));
const all = (fields, n) => fields.filter(f => f.field === n);
const s = f => (f ? f.value.toString('utf8') : '');

// ─── Connect framing ───────────────────────────────────────

function frame(payload, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function endOfStream(json = {}) {
  return frame(Buffer.from(JSON.stringify(json)), 2);
}

function unwrap(body, headers = {}) {
  let buf = body;
  const enc = String(headers['content-encoding'] || headers['connect-content-encoding'] || '');
  if (enc.includes('gzip')) {
    try { buf = zlib.gunzipSync(buf); } catch {}
  }
  if (buf.length >= 5) {
    const flags = buf[0];
    const len = buf.readUInt32BE(1);
    if (len === buf.length - 5 && flags <= 1) {
      let payload = buf.subarray(5);
      if (flags === 1) {
        try { payload = zlib.gunzipSync(payload); } catch {}
      }
      return payload;
    }
  }
  return buf;
}

// ─── GetChatMessageRequest ─────────────────────────────────

const SOURCE = { USER: 1, ASSISTANT: 2, UNKNOWN: 3, TOOL: 4, SYSTEM_PROMPT: 5 };

function parseImage(buf) {
  const f = parseFields(buf);
  return {
    base64: s(get(f, 1, 2)),
    mime: s(get(f, 2, 2)) || 'image/png',
    caption: s(get(f, 3, 2)),
  };
}

function parseToolCall(buf) {
  const f = parseFields(buf);
  return { id: s(get(f, 1, 2)), name: s(get(f, 2, 2)), args: s(get(f, 3, 2)) || '{}' };
}

function parseMessage(buf) {
  const f = parseFields(buf);
  return {
    source: Number(get(f, 2, 0)?.value || 0),
    text: s(get(f, 3, 2)),
    toolCalls: all(f, 6).map(x => parseToolCall(x.value)),
    toolCallId: s(get(f, 7, 2)),
    toolError: Boolean(get(f, 9, 0)?.value),
    images: all(f, 10).map(x => parseImage(x.value)),
    thinking: s(get(f, 11, 2)),
  };
}

function parseToolDefinition(buf) {
  const f = parseFields(buf);
  const name = s(get(f, 1, 2));
  const desc = s(get(f, 2, 2));
  const schema = s(get(f, 3, 2));
  let parameters = { type: 'object', properties: {} };
  try { parameters = JSON.parse(schema); } catch {}
  return { type: 'function', function: { name, description: desc, parameters } };
}

function parseToolChoice(buf) {
  const f = parseFields(buf);
  const name = s(get(f, 2, 2)).trim();
  const option = s(get(f, 1, 2)).trim();
  if (name) return { type: 'function', function: { name } };
  if (option === 'any') return 'required';
  if (option === 'none') return 'none';
  return 'auto';
}

function openAIMessages(systemPrompt, messages) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    if (m.source === SOURCE.SYSTEM_PROMPT) continue;
    if (m.source === SOURCE.TOOL) {
      out.push({ role: 'tool', tool_call_id: m.toolCallId || '', content: m.text || '(no output)' });
      continue;
    }
    if (m.source === SOURCE.ASSISTANT || m.source === SOURCE.UNKNOWN) {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id || `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        }));
        if (!msg.content) delete msg.content;
      }
      out.push(msg);
      continue;
    }
    // USER
    if (m.images.length) {
      const content = [{ type: 'text', text: m.text || '' }];
      for (const img of m.images) {
        if (img.base64) content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
      }
      out.push({ role: 'user', content });
    } else {
      out.push({ role: 'user', content: m.text || '' });
    }
  }

  // Merge consecutive same-role messages (Devin appends several USER blocks).
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && m.role !== 'tool' && !prev.tool_calls && !m.tool_calls) {
      prev.content = joinContent(prev.content, m.content);
    } else {
      merged.push(m);
    }
  }
  return merged;
}

function joinContent(a, b) {
  const asText = typeof a === 'string' ? a : null;
  const bs = typeof b === 'string' ? b : null;
  if (asText !== null && bs !== null) return asText && bs ? `${asText}\n\n${bs}` : (asText || bs);
  const norm = c => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
  return [...norm(a), ...norm(b)];
}

function parseChatRequest(body, headers) {
  const pb = unwrap(body, headers);
  const f = parseFields(pb);
  const systemPrompt = s(get(f, 2, 2));
  const requestedModel = s(get(f, 21, 2));
  const messages = all(f, 3).map(x => parseMessage(x.value));
  const tools = all(f, 10).map(x => parseToolDefinition(x.value));
  const toolChoiceField = get(f, 12, 2);
  const toolChoice = toolChoiceField ? parseToolChoice(toolChoiceField.value) : undefined;
  const noParallel = Boolean(get(f, 11, 0)?.value);
  const requestType = Number(get(f, 7, 0)?.value || 0);
  const promptId = s(get(f, 17, 2));
  const sessionId = s(get(f, 28, 2));
  const systemAppend = messages
    .filter(m => m.source === SOURCE.SYSTEM_PROMPT && m.text)
    .map(m => m.text)
    .join('\n');
  return {
    systemPrompt: systemAppend ? (systemPrompt ? `${systemPrompt}\n${systemAppend}` : systemAppend) : systemPrompt,
    messages: openAIMessages(systemPrompt, messages),
    tools,
    toolChoice,
    noParallel,
    requestedModel,
    requestType,
    promptId,
    sessionId,
  };
}

// ─── model routing ─────────────────────────────────────────

function resolveModel(requested) {
  const cfg = current();
  const map = cfg.models || {};
  const uid = String(requested || '').trim();
  if (uid && map[uid]) return map[uid];
  // Local Sessions send the Magpie id itself as model_uid (the id we put in
  // GetCliModelConfigs). Honour that pick instead of falling back to the
  // single model selected on Magpie's Agents page.
  const exposed = Array.isArray(cfg.exposedModels) ? cfg.exposedModels : [];
  if (uid && exposed.includes(uid)) return uid;
  // Magpie's own selection wins over whatever id Devin happened to carry:
  // the ACP session starts on the first model of the list we hand it, so
  // "group/group" would otherwise shadow the model chosen in Magpie's UI.
  if (cfg.model) return cfg.model;
  if (uid) return uid;
  if (map['*']) return map['*'];
  return uid;
}

// ─── GetChatMessageResponse ────────────────────────────────

function timestamp() {
  const now = Date.now();
  return Buffer.concat([fVarint(1, Math.floor(now / 1000)), fVarint(2, (now % 1000) * 1e6)]);
}

function textChunk(id, text) {
  return Buffer.concat([fString(1, id), fMessage(2, timestamp()), fString(3, text)]);
}

function thinkingChunk(id, text) {
  return Buffer.concat([fString(1, id), fMessage(2, timestamp()), fString(9, text)]);
}

function toolCallChunk(id, calls) {
  const parts = [fString(1, id), fMessage(2, timestamp())];
  for (const c of calls) {
    parts.push(fMessage(6, Buffer.concat([fString(1, c.id), fString(2, c.name), fString(3, c.args)])));
  }
  return Buffer.concat(parts);
}

function usageBlock(usage = {}) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const cacheRead = Number(usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || 0);
  const parts = [];
  if (input > 0) parts.push(fVarint(2, input));
  if (output > 0) parts.push(fVarint(3, output));
  if (cacheRead > 0) parts.push(fVarint(5, cacheRead));
  return parts.length ? Buffer.concat(parts) : null;
}

function stopChunk(id, stopReason, modelUid, latencyMs, usage, requestId) {
  const parts = [fString(1, id), fMessage(2, timestamp()), fVarint(5, stopReason)];
  const u = usageBlock(usage);
  if (u) parts.push(fMessage(7, u));
  if (Number.isFinite(latencyMs)) parts.push(fDouble(12, latencyMs));
  parts.push(fVarint(14, 0));
  if (requestId) parts.push(fString(17, requestId));
  if (modelUid) {
    parts.push(fString(20, modelUid));
    parts.push(fString(23, modelUid));
  }
  return Buffer.concat(parts);
}

function errorChunk(id, message) {
  return Buffer.concat([fString(1, id), fMessage(2, timestamp()), fString(3, message), fVarint(5, 13)]);
}

// ─── Magpie call ───────────────────────────────────────────

async function magpieChat(payload, signal, cfg) {
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  const res = await fetch(`${magpieBase(cfg)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  return res;
}

async function* sseEvents(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

const stopFromFinish = reason =>
  reason === 'tool_calls' ? 10 : reason === 'length' ? 3 : 2;

// ─── server ────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function replyUnary(res, payload) {
  const buf = payload || Buffer.alloc(0);
  res.writeHead(200, {
    'content-type': 'application/proto',
    'content-length': String(buf.length),
    'connect-protocol-version': '1',
  });
  res.end(buf);
}

async function handleChatMessage(req, res, body) {
  const started = Date.now();
  let parsed;
  try {
    parsed = parseChatRequest(body, req.headers);
  } catch (err) {
    log('✖ parse failed:', err.message);
    res.writeHead(200, { 'content-type': 'application/connect+proto', 'transfer-encoding': 'chunked' });
    res.write(frame(errorChunk(randomUUID(), `Magpie bridge could not read the request: ${err.message}`)));
    res.end(endOfStream());
    return;
  }

  const model = resolveModel(parsed.requestedModel);
  const messageId = randomUUID();
  const requestId = randomUUID();
  log(`→ chat model=${parsed.requestedModel || '(default)'} -> ${model || '(none)'} type=${parsed.requestType} prompt=${(parsed.promptId || '?').slice(0, 8)} session=${(parsed.sessionId || '?').slice(0, 8)} messages=${parsed.messages.length} tools=${parsed.tools.length}`);

  if (!model) {
    res.writeHead(200, { 'content-type': 'application/connect+proto', 'transfer-encoding': 'chunked' });
    res.write(frame(errorChunk(messageId, 'Magpie bridge has no model configured. Pick one on the Magpie Agents page.')));
    res.end(endOfStream());
    return;
  }

  const payload = {
    model,
    messages: parsed.messages,
    stream: true,
  };
  const cfg = current();
  if (cfg.temperature !== undefined) payload.temperature = cfg.temperature;
  if (cfg.maxTokens) payload.max_tokens = cfg.maxTokens;
  if (parsed.tools.length) {
    payload.tools = parsed.tools;
    payload.tool_choice = parsed.toolChoice || 'auto';
    if (parsed.noParallel) payload.parallel_tool_calls = false;
  }

  res.writeHead(200, {
    'content-type': 'application/connect+proto',
    'transfer-encoding': 'chunked',
    'connect-protocol-version': '1',
  });

  const controller = new AbortController();
  req.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const toolCalls = new Map();
  let usage = null;
  let finish = null;
  let textSent = 0;
  let stopped = false;

  const flush = buf => new Promise(resolve => { if (res.write(buf)) resolve(); else res.once('drain', resolve); });

  try {
    const upstream = await magpieChat(payload, controller.signal, cfg);
    if (!upstream.ok) {
      const text = await upstream.text();
      log(`✖ magpie ${upstream.status}: ${text.slice(0, 500)}`);
      await flush(frame(errorChunk(messageId, `Magpie answered ${upstream.status}: ${text.slice(0, 1000)}`)));
      res.end(endOfStream());
      return;
    }
    if (!(upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      // Non-streaming answer (some providers ignore stream:true).
      const json = await upstream.json();
      const choice = json.choices?.[0] || {};
      const text = choice.message?.content || '';
      if (text) await flush(frame(textChunk(messageId, text)));
      if (choice.message?.reasoning_content) await flush(frame(thinkingChunk(messageId, choice.message.reasoning_content)));
      await flush(frame(stopChunk(messageId, stopFromFinish(choice.finish_reason), model, Date.now() - started, json.usage, requestId)));
      res.end(endOfStream());
      log(`← chat done (json) ${text.length}b ${Date.now() - started}ms`);
      return;
    }

    for await (const event of sseEvents(upstream)) {
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.reasoning_content) await flush(frame(thinkingChunk(messageId, delta.reasoning_content)));
      if (delta.content) {
        textSent += delta.content.length;
        await flush(frame(textChunk(messageId, delta.content)));
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const key = tc.index ?? toolCalls.size;
          const prev = toolCalls.get(key) || { id: '', name: '', args: '' };
          toolCalls.set(key, {
            id: tc.id || prev.id,
            name: (prev.name || '') + (tc.function?.name || ''),
            args: (prev.args || '') + (tc.function?.arguments || ''),
          });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    if (toolCalls.size) {
      const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({
        id: c.id || `call_${randomUUID().slice(0, 8)}`,
        name: c.name,
        args: c.args || '{}',
      }));
      await flush(frame(toolCallChunk(messageId, calls)));
      stopped = true;
      await flush(frame(stopChunk(messageId, 10, model, Date.now() - started, usage, requestId)));
      log(`← chat done (tools=${calls.map(c => c.name).join(',')}) ${Date.now() - started}ms`);
    } else {
      await flush(frame(stopChunk(messageId, stopFromFinish(finish), model, Date.now() - started, usage, requestId)));
      log(`← chat done (text=${textSent}b, finish=${finish || 'stop'}) ${Date.now() - started}ms`);
    }
    res.end(endOfStream());
  } catch (err) {
    if (err.name === 'AbortError') { log('· client went away'); return; }
    log('✖ upstream failed:', err.message);
    if (!res.writableEnded) {
      try {
        await flush(frame(errorChunk(messageId, `Magpie bridge could not reach Magpie: ${err.message}`)));
        res.end(endOfStream());
      } catch {}
    }
  }
}

function modelConfigsResponse() {
  const cfg = current();
  const models = Array.isArray(cfg.exposedModels) && cfg.exposedModels.length
    ? cfg.exposedModels
    : magpieModelListFromConfig(cfg);
  const parts = [];
  for (const m of models) {
    const id = typeof m === 'string' ? m : m.id;
    if (!id) continue;
    // The Local Session picker groups entries by traits.field1. Use the
    // vendor prefix as the group and keep the item text free of it, so one
    // prefix produces one group instead of one group per model.
    const slash = id.indexOf('/');
    const group = slash > 0 ? id.slice(0, slash) : '';
    const shortId = slash > 0 ? id.slice(slash + 1) : id;
    const label = typeof m === 'string' ? shortId : (m.name || shortId);
    const entry = [
      fString(1, label),
      fVarint(5, 1),        // supports_images
      fString(22, id),      // model_uid (full id: the chat request carries it)
    ];
    if (group) entry.push(fMessage(30, fString(1, group)));
    parts.push(fMessage(1, Buffer.concat(entry)));
  }
  return Buffer.concat(parts);
}

function magpieModelListFromConfig(cfg = current()) {
  const map = cfg.models || {};
  const ids = new Set();
  for (const [k, v] of Object.entries(map)) if (k !== '*' && v) ids.add(v);
  if (cfg.model) ids.add(cfg.model);
  if (map['*']) ids.add(map['*']);
  return [...ids];
}

let lastActivity = Date.now();

// ─── MITM proxy for Devin's own clients ───────────────────
//
// Same shape as AnyBridge's gateway: Devin is pointed at this proxy with
// http.proxy, the TLS session for the API host is terminated here with a local
// CA, and only the chat RPC is rewritten. Everything else is forwarded to the
// real server untouched, so login, quota checks and non-chat traffic keep
// working. This is what reaches the editor's own chat, which talks to
// server.codeium.com directly and never sees WINDSURF_API_SERVER_URL.

const MITM_HOSTS = new Set(['server.codeium.com', 'server.self-serve.windsurf.com', 'app.devin.ai']);
const CERT_DIR = path.join(HOME, 'certs');
let mitmStarted = false;

function mitmCerts() {
  try {
    const key = fs.readFileSync(path.join(CERT_DIR, 'leaf-key.pem'));
    const leaf = fs.readFileSync(path.join(CERT_DIR, 'leaf.pem'));
    const ca = fs.readFileSync(path.join(CERT_DIR, 'ca.pem'));
    return { key, cert: Buffer.concat([leaf, ca]) };
  } catch {
    return null;
  }
}

function rpcName(url) {
  return String(url || '').split('?')[0].split('/').pop();
}

// Codeium's chat preflights answer "no capacity" for a free account; the local
// bridge does not draw on that quota, so say there is room.
function preflightOk(method) {
  const parts = [fVarint(1, 1)];
  if (method !== 'CheckChatCapacity') {
    parts.push(fVarint(3, 9999), fVarint(4, 9999));
  }
  return Buffer.concat(parts);
}


export function startMitm() {
  if (mitmStarted) return null;
  const cfg = current();
  const port = Number(cfg.mitmPort || process.env.MAGPIE_DEVIN_MITM_PORT || 7450);
  const certs = mitmCerts();
  if (!certs) {
    log('· MITM certificates missing; the proxy is not started');
    return null;
  }

  // A plain HTTP server: the CONNECT handler unwraps TLS itself and feeds the
  // socket in, the way AnyBridge does. An https.Server cannot be handed a
  // socket that already spoke CONNECT.
  const inner = http.createServer(async (req, res) => {
    const method = rpcName(req.url);
    try {
      if (method === 'GetChatMessage') {
        const body = await readBody(req);
        return await handleChatMessage(req, res, body);
      }
      if (CAPTURE && ['GetUserStatus', 'GetCliModelConfigs', 'GetCommandModelConfigs', 'GetProfileData', 'GetStatus', 'GetUserJwt', 'GetCascadeModelConfigs'].includes(method)) {
        return forwardCapture(req, res, method);
      }
      if (method === 'GetCliModelConfigs' || method === 'GetCommandModelConfigs'
        || method === 'GetCommandModelConfigsForSite' || method === 'GetCliModelConfigsForSite') {
        try {
          const up = await fetchUpstream(req);
          if (CAPTURE) {
            try {
              fs.writeFileSync(path.join(HOME, `capture-${method}.hex`), up.body.toString('hex'));
              log(`· [capture] ${method} ${up.body.length}b`);
            } catch {}
          }
          const viaAnyBridge = unlockModels(up.body);
          const out = (viaAnyBridge && viaAnyBridge.body && viaAnyBridge.body.length)
            ? viaAnyBridge.body
            : up.body;
          const headers = { ...up.headers };
          delete headers['transfer-encoding'];
          if (viaAnyBridge) {
            log(`· [mitm] ${method} via AnyBridge unlockModels -> ${viaAnyBridge.changed} changes`);
            if (viaAnyBridge.wasConnect) {
              delete headers['content-encoding'];
              delete headers['connect-content-encoding'];
            }
          }
          headers['content-length'] = String(out.length);
          res.writeHead(up.status || 200, headers);
          return res.end(out);
        } catch (err) {
          // Upstream unreachable: still hand Devin a usable model list.
          log('· [mitm] upstream model configs failed:', err.message, '— serving the local list');
        }
        const gz = zlib.gzipSync(modelConfigsResponse());
        res.writeHead(200, {
          'content-type': 'application/proto',
          'content-encoding': 'gzip',
          'content-length': String(gz.length),
          'connect-protocol-version': '1',
        });
        return res.end(gz);
      }
      if (method === 'GetUserStatus') {
        try {
          const up = await fetchUpstream(req);
          if (up.status === 200) saveDevinModels(up.body);
          // The desktop picker's labels come from GetUserStatus, in the same
          // Connect/gzip protobuf shape as GetCliModelConfigs. Reuse AnyBridge's
          // unlockModels here instead of the old label-only rewriter: it strips
          // the framing, renames the mapped slots and drops locked entries.
          const viaAnyBridge = unlockModels(up.body);
          const out = (viaAnyBridge && viaAnyBridge.body && viaAnyBridge.body.length)
            ? viaAnyBridge.body
            : up.body;
          const headers = { ...up.headers };
          delete headers['transfer-encoding'];
          if (viaAnyBridge) {
            log(`· [mitm] GetUserStatus via AnyBridge unlockModels -> ${viaAnyBridge.changed} changes`);
            if (viaAnyBridge.wasConnect) {
              delete headers['content-encoding'];
              delete headers['connect-content-encoding'];
            }
          }
          headers['content-length'] = String(out.length);
          res.writeHead(up.status || 200, headers);
          return res.end(out);
        } catch (err) {
          log('· [mitm] GetUserStatus rewrite failed:', err.message);
          if (!res.headersSent) res.writeHead(502);
          return res.end();
        }
      }
      if (method === 'CheckUserMessageRateLimit' || method === 'CheckChatCapacity') {
        return replyUnary(res, preflightOk(method));
      }
      return forward(req, res);
    } catch (err) {
      log('✖ [mitm] handler:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });


function fetchUpstream(req) {
  return new Promise((resolve, reject) => {
    const host = String(req.headers.host || '').split(':')[0] || 'server.codeium.com';
    const headers = { ...req.headers, host };
    delete headers['proxy-connection'];
    const up = https.request({ hostname: host, port: 443, path: req.url, method: req.method, headers }, upRes => {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => resolve({ status: upRes.statusCode, headers: upRes.headers, body: Buffer.concat(chunks) }));
    });
    up.on('error', reject);
    req.pipe(up);
  });
}


const CAPTURE = process.env.MAGPIE_DEVIN_CAPTURE === '1';

  // Opt-in debug capture (MAGPIE_DEVIN_CAPTURE=1): dump an upstream body to
// ~/.config/magpie-devin-bridge/capture-<method>.hex and pass it through.
function forwardCapture(req, res, method) {
  const host = String(req.headers.host || '').split(':')[0] || 'server.codeium.com';
  const up = https.request({ hostname: host, port: 443, path: req.url, method: req.method, headers: { ...req.headers, host } }, upRes => {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        fs.writeFileSync(path.join(HOME, `capture-${method}.hex`), body.toString('hex'));
        log(`· [capture] ${method} ${body.length}b`);
      } catch {}
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      res.end(body);
    });
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}

  function forward(req, res) {
  const host = String(req.headers.host || '').split(':')[0] || 'server.codeium.com';
  log(`· [mitm] ${req.method} ${req.url.slice(0, 120)} -> ${host}`);
  if (CAPTURE && host === 'app.devin.ai' && /(model|agent-version|toggleable)/i.test(req.url)) {
      const chunks = [];
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      res.write = (c, ...a) => { try { chunks.push(Buffer.from(c)); } catch {} return origWrite(c, ...a); };
      res.end = (c, ...a) => {
        try {
          if (c) chunks.push(Buffer.from(c));
          const body = Buffer.concat(chunks);
          const slug = req.url.split('?')[0].replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
          fs.writeFileSync(path.join(HOME, `capture-api-${slug}.json`), body);
          log(`· [capture] ${req.url.slice(0, 80)} ${body.length}b`);
        } catch {}
        return origEnd(c, ...a);
      };
    }
    const headers = { ...req.headers, host };
    delete headers['proxy-connection'];
    const up = https.request({
      hostname: host,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
    }, upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', err => {
      log('✖ [mitm] forward:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  }

  // A WebSocket (the cloud ACP stream) cannot go through the HTTP parser once
  // it upgrades; tunnel the upgraded socket straight to the real host.

  // Passive WebSocket sniffer: the handshake passes through untouched; after
  // it, frames are parsed only to log the ones that carry model metadata, so
  // we can learn the cloud catalog's shape before rewriting anything.
  function sniffer(sock, dir) {
    let buf = Buffer.alloc(0);
    let handshake = true;
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (handshake) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        buf = buf.subarray(i + 4);
        handshake = false;
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        let payload = buf.subarray(off + (masked ? 4 : 0), need);
        if (masked) {
          const key = buf.subarray(off, off + 4);
          payload = Buffer.from(payload.map((b, i2) => b ^ key[i2 % 4]));
        }
        buf = buf.subarray(need);
        if (op !== 1) continue;
        const text = payload.toString('utf8');
        if (/model|catalog|Adaptive|swe-2|capabilit/i.test(text)) {
          log(`· [ws ${dir}] ${text.slice(0, 400).replace(/\s+/g, ' ')}`);
        } else if (dir === 'in' && text.length < 200) {
          log(`· [ws in] ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
        }
      }
    });
  }

  const CRLF = String.fromCharCode(13, 10);
  inner.on('upgrade', (req, socket, head) => {
    const host = String(req.headers.host || 'app.devin.ai').split(':')[0];
    log(`· [mitm] upgrade ${host}${req.url}`);
    const up = tls.connect({ host, port: 443, servername: host }, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'proxy-connection') continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      up.write(lines.join(CRLF) + CRLF + CRLF);
      if (head && head.length) up.write(head);
      sniffer(up, 'in');
      sniffer(socket, 'out');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  const proxy = http.createServer((req, res) => {
    try {
      const target = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const up = http.request({
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      }, upRes => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
    } catch {
      res.writeHead(400);
      res.end();
    }
  });

  proxy.on('connect', (req, socket, head) => {
    const [host, p] = String(req.url || '').split(':');
    log(`· [proxy] CONNECT ${host}${MITM_HOSTS.has(host) ? ' (mitm)' : ''}`);
    if (MITM_HOSTS.has(host)) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) socket.unshift(head);
      let tlsSocket;
      try {
        tlsSocket = new tls.TLSSocket(socket, {
          isServer: true,
          cert: certs.cert,
          key: certs.key,
          ALPNProtocols: ['http/1.1'],
        });
      } catch (err) {
        log('✖ [mitm] tls wrap:', err.message);
        socket.destroy();
        return;
      }
      tlsSocket.on('secure', () => log(`· [mitm] tls ${host} ${tlsSocket.alpnProtocol || ''}`));
      tlsSocket.on('error', err => {
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') log('✖ [mitm] tls:', err.message);
        if (!socket.destroyed) socket.destroy();
      });
      inner.emit('connection', tlsSocket);
      return;
    }
    const upstream = net.connect(Number(p || 443), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  proxy.on('error', err => log('✖ [mitm] proxy:', err.message));
  proxy.listen(port, '127.0.0.1', () => {
    log(`mitm proxy listening on 127.0.0.1:${port} (${[...MITM_HOSTS].join(', ')})`);
  });
  mitmStarted = true;
  return { port };
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  lastActivity = Date.now();
  try {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('magpie devin bridge\n');
      return;
    }
    const body = await readBody(req);
    if (url.includes('GetChatMessage')) return await handleChatMessage(req, res, body);
    if (url.includes('GetCliModelConfigs')) {
      const payload = modelConfigsResponse();
      log(`· GetCliModelConfigs -> ${(current().exposedModels || []).length || 'config'} models`);
      return replyUnary(res, payload);
    }
    log(`· ${url.split('/').pop()} -> empty`);
    return replyUnary(res, Buffer.alloc(0));
  } catch (err) {
    log('✖ server error:', err.stack || err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const STATUS_PATH = path.join(HOME, 'status.json');
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

let running = null;
let supervised = false;
let lastApplied = null;
let enabledBefore = null;
let wasWired = null;

function writeStatus(state = 'connected') {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const cfg = current();
    fs.writeFileSync(STATUS_PATH, JSON.stringify({
      state,
      heartbeat: Date.now(),
      updated: new Date().toISOString(),
      url: running?.address || null,
      magpie: magpieBase(cfg),
      model: cfg.model || cfg.models?.['*'] || null,
      devin: devinState(running?.address),
    }, null, 2));
  } catch {}
}

// Magpie records a wired agent as `wired: true` in its agents state. A clear
// "was on, now off" transition is a second opinion to connection.json, which
// is what the Agents page writes.
const STATE_CANDIDATES = [
  path.join(os.homedir(), '.cache', 'magpie', 'agents-state.json'),
  path.join(process.env.LOCALAPPDATA || '', 'magpie', 'cache', 'agents-state.json'),
  path.join(process.env.APPDATA || '', 'magpie', 'cache', 'agents-state.json'),
];

function magpieSwitch() {
  for (const file of STATE_CANDIDATES) {
    let state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')).state; } catch { continue; }
    const agents = state?.agents;
    if (!Array.isArray(agents)) continue;
    const mine = agents.find(a => a?.id === 'devin-bridge');
    if (!mine) return null;
    return { wired: mine.wired === true };
  }
  return null;
}

function supervise() {
  // Magpie's Agents switch and connection.json are written at different
  // moments. Latching the switch-off edge stops the two sources from fighting:
  // without it, the tick restores Devin's settings and then re-applies them
  // from a still-enabled connection.json three seconds later.
  let switchPaused = false;
  const tick = () => {
    try {
      const cfg = current();
      const sw = magpieSwitch();
      if (sw) {
        if (sw.wired) {
          wasWired = true;
          switchPaused = false;
        } else if (wasWired === true && !switchPaused) {
          wasWired = false;
          switchPaused = true;
          if (lastApplied) {
            log('· magpie switch is off;', restoreDevinSettings(HOME));
            lastApplied = null;
          }
        }
      }

      // Supervised means the bridge was started by the Magpie plugin: only a
      // connection Magpie wrote as enabled may touch Devin. A standalone
      // bridge (node bridge.js / install.js) is on until told otherwise.
      const enabled = switchPaused
        ? false
        : (supervised ? cfg.enabled === true : cfg.enabled !== false);
      if (enabled) {
        if (lastApplied !== running.address || enabledBefore === false) {
          if (applyDevinSettings(HOME, running.address)) {
            log(`· Devin settings now point at ${running.address}`);
          }
          lastApplied = running.address;
        }
      } else if (lastApplied) {
        log('·', restoreDevinSettings(HOME));
        lastApplied = null;
      }
      enabledBefore = enabled;
      writeStatus(enabled ? 'connected' : 'paused');
    } catch (err) {
      log('· supervisor:', err.message);
    }
  };
  tick();
  setInterval(tick, 3000).unref();
}

export function startBridge(overrides = {}) {
  if (running) return running;
  supervised = overrides.supervised === true;
  const cfg = { ...current(), ...overrides };
  const listen = String(overrides.listen || cfg.listen || process.env.MAGPIE_DEVIN_LISTEN || '127.0.0.1:8788');
  const [host, port] = listen.split(':');
  running = { listen, address: `http://${host || '127.0.0.1'}:${port || 8788}` };
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      // Another host (a short-lived `magpie` CLI run, or a second Magpie) may
      // hold the port for a moment. It exits on its own, so try again instead
      // of staying dead for the rest of Magpie's lifetime.
      log('· port is busy; retrying in 2s');
      if (IS_MAIN) process.exit(0);
      setTimeout(() => {
        try { server.listen(Number(port || 8788), host || '127.0.0.1'); } catch {}
      }, 2000).unref();
      return;
    }
    log('✖ bridge listen failed:', err.message);
  });
  server.listen(Number(port || 8788), host || '127.0.0.1', () => {
    log(`magpie devin bridge listening on ${running.address} -> ${magpieBase(current())}`);
    writeStatus();
  });
  startMitm();
  supervise();
  return running;
}

// A bridge nobody is talking to should not outlive Devin. After ten quiet
// minutes, look for a Devin process twice a minute apart; two misses in a row
// means Devin is gone and this process can go too.
function devinRunning() {
  return new Promise(resolve => {
    const command = process.platform === 'win32' ? 'tasklist' : 'ps';
    const args = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-Ao', 'comm='];
    execFile(command, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? true : /devin/i.test(String(stdout)));
    });
  });
}

let misses = 0;
setInterval(async () => {
  if (process.env.MAGPIE_DEVIN_KEEPALIVE === '1') return;
  if (Date.now() - lastActivity < 10 * 60_000) { misses = 0; return; }
  if (await devinRunning()) { misses = 0; return; }
  if (++misses < 2) return;
  log('· Devin is not running; bridge exits');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}, 60_000).unref();

if (IS_MAIN) {
  startBridge();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('bridge stopping');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
    });
  }
}
