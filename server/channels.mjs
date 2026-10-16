import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IMAGE_MODEL } from './config.mjs';
import { ProviderError } from './provider.mjs';
import { connectionErrorMessage } from './network.mjs';

export const CODEX_CHANNEL = 'codex';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid = message => { throw new ProviderError(message, 400); };
function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(`${label}不能为空、过长或包含控制字符。`);
  return value.trim();
}
function baseUrl(value) {
  const raw = field(value, 'Base URL', 2048);
  let url;
  try { url = new URL(raw); } catch { invalid('请输入有效的 HTTP(S) Base URL。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('Base URL 必须是没有内嵌凭据、查询参数或片段的 HTTP(S) 地址。');
  return url.href.replace(/\/+$/, '');
}
function credentials(input, previous) {
  const apiKey = input.apiKey === undefined || input.apiKey === '' ? previous?.apiKey : input.apiKey;
  const key = field(apiKey, 'API Key', 8192);
  if (/[^\x21-\x7e]/.test(key)) invalid('API Key 应为不含空白的 ASCII 字符。');
  return { baseUrl: baseUrl(input.baseUrl ?? previous?.baseUrl), apiKey: key };
}
function channelFields(input, previous) {
  return { ...credentials(input, previous), name: field(input.name ?? previous?.name, '渠道名称', 80), imageModel: field(input.imageModel ?? previous?.imageModel, '生图模型 ID', 200) };
}
function customConfig(channel) {
  return { baseUrl: channel.baseUrl, imageModel: channel.imageModel, headers: { Authorization: `Bearer ${channel.apiKey}` }, error: '' };
}
function customView(channel) {
  return { id: channel.id, source: 'custom', name: channel.name, baseUrl: channel.baseUrl, imageModel: channel.imageModel, hasApiKey: true, ready: true, error: '' };
}

// Config mutations are serialized; publish the new in-memory state only after the
// private file has been replaced. Jobs hold their own immutable config snapshot.
export class Channels {
  constructor({ directory, configLoader }) {
    this.directory = directory;
    this.file = path.join(directory, 'channels.json');
    this.configLoader = configLoader;
    this.state = { version: 1, defaultChannelId: CODEX_CHANNEL, channels: [] };
    this.writeQueue = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.channels) || data.channels.some(c => !c || !UUID.test(c.id))) throw new Error();
      const channels = data.channels.map(c => ({ id: c.id, ...channelFields(c) }));
      if (new Set(channels.map(c => c.id)).size !== channels.length || (data.defaultChannelId !== CODEX_CHANNEL && !channels.some(c => c.id === data.defaultChannelId))) throw new Error();
      this.state = { version: 1, defaultChannelId: data.defaultChannelId, channels };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取 Imageboard channels.json，请检查本地渠道配置文件。');
    }
  }
  async mutate(change) {
    const pending = this.writeQueue.catch(() => {}).then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temp, this.file);
      } finally { await unlink(temp).catch(() => {}); }
      this.state = next;
      return result;
    });
    this.writeQueue = pending;
    return pending;
  }
  findCustom(state, id) {
    if (id === CODEX_CHANNEL) throw new ProviderError('扫描到的 Codex 配置只读，不能编辑或删除。', 403);
    const channel = state.channels.find(c => c.id === id);
    if (!channel) throw new ProviderError('找不到该自定义渠道。', 404);
    return channel;
  }
  create(input) {
    return this.mutate(state => {
      const channel = { id: randomUUID(), ...channelFields(input) };
      state.channels.push(channel);
      return customView(channel);
    });
  }
  update(id, input) {
    return this.mutate(state => {
      const previous = this.findCustom(state, id);
      const channel = { id, ...channelFields(input, previous) };
      state.channels[state.channels.indexOf(previous)] = channel;
      return customView(channel);
    });
  }
  remove(id) {
    return this.mutate(state => {
      this.findCustom(state, id);
      state.channels = state.channels.filter(c => c.id !== id);
      if (state.defaultChannelId === id) state.defaultChannelId = CODEX_CHANNEL;
      return { defaultChannelId: state.defaultChannelId };
    });
  }
  setDefault(id) {
    return this.mutate(state => {
      if (id !== CODEX_CHANNEL) this.findCustom(state, id);
      state.defaultChannelId = id;
      return { defaultChannelId: id };
    });
  }
  async resolve() {
    await this.writeQueue.catch(() => {});
    const state = this.state;
    let codex;
    try { codex = await this.configLoader(); }
    catch (error) { codex = { error: error.message, public: { error: error.message } }; }
    const promptError = codex.promptError ?? codex.error ?? '';
    const imageError = codex.imageError ?? codex.error ?? '';
    const promptConfig = { ...codex, error: promptError };
    const scan = {
      id: CODEX_CHANNEL, source: 'codex', name: 'Codex 扫描配置',
      model: codex.public?.model || codex.model || '未配置', imageModel: codex.imageModel || IMAGE_MODEL,
      provider: codex.public?.provider || '未配置', baseUrl: codex.public?.baseUrl || codex.baseUrl || '',
      credentialSource: codex.public?.credentialSource || '未找到', profile: codex.public?.profile || null,
      ready: !imageError, error: imageError, promptReady: !promptError, promptError,
    };
    const selected = state.channels.find(c => c.id === state.defaultChannelId);
    const imageConfig = selected ? customConfig(selected) : { ...codex, imageModel: scan.imageModel, error: imageError };
    return {
      promptConfig, imageConfig,
      public: {
        ready: !imageConfig.error, imageReady: !imageConfig.error, promptReady: !promptError,
        error: imageConfig.error, promptError, model: scan.model, imageModel: imageConfig.imageModel,
        provider: selected?.name || scan.provider, baseUrl: imageConfig.baseUrl || '',
        credentialSource: selected ? 'Imageboard 自定义渠道' : scan.credentialSource, profile: scan.profile,
        defaultChannelId: state.defaultChannelId, channelName: selected?.name || scan.name,
        channels: [scan, ...state.channels.map(customView)],
      },
    };
  }
  async models(input) {
    await this.writeQueue.catch(() => {});
    const previous = input.channelId ? this.findCustom(this.state, input.channelId) : undefined;
    const config = customConfig(credentials(input, previous));
    return { models: await listModels(config) };
  }
}

export async function listModels(config, { signal = AbortSignal.timeout(20_000) } = {}) {
  const urls = [`${config.baseUrl}/models`];
  if (new URL(config.baseUrl).pathname === '/') urls.push(`${config.baseUrl}/v1/models`);
  try {
    for (let i = 0; i < urls.length; i++) {
      const response = await fetch(urls[i], { method: 'GET', headers: { ...config.headers, Accept: 'application/json' }, signal, redirect: 'error' });
      if ([404, 405].includes(response.status) && i < urls.length - 1) { await response.body?.cancel(); continue; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(response.status === 401 || response.status === 403 ? '模型列表认证失败，请检查 API Key 和访问权限。' : `模型列表拉取失败（HTTP ${response.status}），可手动填写模型 ID。`);
      }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new ProviderError('模型列表响应过大，请手动填写模型 ID。');
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProviderError('模型列表不是有效 JSON，可手动填写模型 ID。'); }
      if (!Array.isArray(data.data)) throw new ProviderError('网关未返回兼容的模型列表，可手动填写模型 ID。');
      return [...new Set(data.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id)))].sort();
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(connectionErrorMessage(signal.aborted ? signal.reason : error));
  }
}
