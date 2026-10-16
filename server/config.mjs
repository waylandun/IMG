import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

export const IMAGE_MODEL = 'gpt-image-2.5-flare';

async function readOptional(file, parser) {
  try { return parser(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`无法读取 ${path.basename(file)}，请检查文件格式。`);
  }
}

export async function loadConfig({ env = process.env, home = os.homedir() } = {}) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  let config = await readOptional(path.join(codexHome, 'config.toml'), parse);
  const profile = env.IMAGEBOARD_CODEX_PROFILE || config.profile;
  if (profile) {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Codex profile 名称无效。');
    const fileProfile = await readOptional(path.join(codexHome, `${profile}.config.toml`), parse);
    const overlay = { ...config.profiles?.[profile], ...fileProfile };
    config = { ...config, ...overlay, model_providers: { ...config.model_providers, ...overlay.model_providers } };
  }
  const providerId = config.model_provider || 'openai';
  const provider = config.model_providers?.[providerId] || {};
  const model = config.model;
  const rawBase = provider.base_url || (providerId === 'openai' ? (env.OPENAI_BASE_URL || config.openai_base_url || 'https://api.openai.com/v1') : '');
  let base;
  try { base = new URL(rawBase); } catch { throw new Error('当前 Codex provider 未配置有效的 base_url。'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('base_url 必须是没有内嵌凭据、查询参数或片段的 HTTP(S) 地址。');
  }
  const headers = { ...(provider.http_headers || {}) };
  for (const [name, variable] of Object.entries(provider.env_http_headers || {})) {
    if (env[variable]) headers[name] = env[variable];
  }
  const auth = await readOptional(path.join(codexHome, 'auth.json'), JSON.parse);
  let key = '';
  let credentialSource = '';
  if (provider.experimental_bearer_token) {
    key = provider.experimental_bearer_token;
    credentialSource = 'Codex provider';
  } else if (provider.env_key) {
    key = env[provider.env_key] || '';
    credentialSource = key ? '环境变量' : '';
  } else if (providerId === 'openai' || provider.requires_openai_auth) {
    key = env.OPENAI_API_KEY || auth.OPENAI_API_KEY || '';
    credentialSource = env.OPENAI_API_KEY ? '环境变量' : key ? 'Codex auth.json' : '';
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  const hasHeaderCredential = Object.keys(headers).some(name => /authorization|api[-_]?key/i.test(name));
  if (!credentialSource && hasHeaderCredential) credentialSource = 'Codex 请求头';
  const wireApi = provider.wire_api || 'responses';
  let promptError = !model ? '请先在 Codex config.toml 中设置默认 model。' : '';
  let imageError = '';
  if (!key && !hasHeaderCredential) {
    imageError = provider.env_key
      ? `当前进程缺少 provider 所需的 ${provider.env_key} 环境变量。`
      : '未找到可用于 Images API 的 API Key / Bearer 凭据。仅有 ChatGPT 登录态不能直接调用此接口。';
  }
  if (provider.auth) imageError = '此版本尚不支持 Codex 动态凭据解析器，请使用 provider 的 env_key 或 Bearer 配置。';
  if (!['responses', 'chat'].includes(wireApi)) promptError = 'Codex 提示词模型协议暂不支持，请使用 responses 或 chat。';
  promptError ||= imageError;
  const error = promptError || imageError;
  return {
    model, imageModel: IMAGE_MODEL, providerId, wireApi,
    baseUrl: base.href.replace(/\/$/, ''), headers, error, promptError, imageError,
    public: {
      ready: !error, promptReady: !promptError, imageReady: !imageError, model: model || '未配置', imageModel: IMAGE_MODEL,
      provider: provider.name || providerId, baseUrl: base.href.replace(/\/$/, ''),
      credentialSource: credentialSource || '未找到', profile: profile || null, error,
    },
  };
}
