// Devin · Magpie Bridge — the agent card Magpie shows on its Agents page.
//
// Agent plugins run in a sandbox that only lets them import files beside them,
// so this file does no I/O at all: Magpie writes what connect() returns into
// connection.json, and the bridge (index.js, a provider plugin that shares
// this package) reads that file, starts listening and points Devin at itself.

export const agent = {
  id: 'devin-bridge',
  name: 'Devin · Magpie Bridge',
  icon: 'data:image/png;base64,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',
  bin: 'devin',
  dir: '~/.config/magpie-devin-bridge',
  config: '~/.config/magpie-devin-bridge/connection.json',
  format: 'json',
  model: 'model',
  ua: ['magpie-devin-bridge'],
  notice: '打开「接入」后，Magpie 中配置的模型会作为 Magpie 供应商出现在 agent 的模型列表里，也可在此直接选模型。桥接随 Devin 会话启动，不额外常驻进程；重启 Devin（或新开会话）后生效，关闭开关即还原 Devin 的设置。',
};

export function connect(input) {
  const { gateway, model, models } = input || {};
  if (!gateway || !gateway.v1) return { enabled: false };
  return {
    enabled: true,
    gateway: gateway.v1,
    key: gateway.key,
    model: model || '',
    models: (models || []).map(m => ({ id: m.id, name: m.name || m.id, context: m.context || null })),
  };
}