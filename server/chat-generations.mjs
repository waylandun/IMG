import { createHash } from 'node:crypto';
import path from 'node:path';
import { SIZES, QUALITIES, isActive } from './jobs.mjs';
import { ProviderError } from './provider.mjs';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SOURCE = 'codex-chat';
const defaults = { size: 'auto', quality: 'auto', format: 'png', background: 'auto' };
const choices = { size: SIZES, quality: QUALITIES, format: ['png', 'jpeg', 'webp'], background: ['auto', 'opaque', 'transparent'] };
const invalid = message => { throw new ProviderError(message, 400); };

export function generationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['requestId', 'prompt', ...Object.keys(defaults)].includes(key))) invalid('不支持的聊天生图参数。');
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) invalid('requestId 必须是小写 UUID；重试同一次创作时保持不变。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) invalid('提示词应为 1–8000 字。');
  const normalized = { requestId: input.requestId, prompt: input.prompt.trim() };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = input[key] === undefined ? fallback : input[key];
    if (!choices[key].includes(value)) invalid(`不支持的 ${key} 参数。`);
    normalized[key] = value;
  }
  if (normalized.background === 'transparent' && normalized.format === 'jpeg') invalid('透明背景请选择 PNG 或 WebP。');
  return normalized;
}

export class ChatGenerations {
  constructor({ jobs, conversations }) {
    Object.assign(this, { jobs, conversations });
    this.acceptQueue = Promise.resolve();
  }
  create(input) {
    const accepted = this.acceptQueue.catch(() => {}).then(() => this.accept(input));
    this.acceptQueue = accepted;
    return accepted;
  }
  async accept(input) {
    const normalized = generationInput(input);
    const { requestId, ...parameters } = normalized;
    const requestHash = createHash('sha256').update(JSON.stringify(parameters)).digest('hex');
    const existing = this.jobs.get(requestId);
    // Check durable identity before busy/config checks, including failed jobs.
    if (existing) {
      if (existing.source !== SOURCE || existing.requestHash !== requestHash) throw new ProviderError('requestId 已用于其他创作；同一次重试必须保持参数一致。', 409);
      return this.get(requestId);
    }
    if (this.conversations.isBusy()) throw new ProviderError('请等待工作室当前对话处理完成，再用同一个 requestId 重试。', 409);
    const job = await this.jobs.create({ ...parameters, mode: 'generate', optimize: false, count: 1 }, { jobId: requestId, source: SOURCE, requestHash });
    return this.summary(job);
  }
  job(id) {
    if (typeof id !== 'string' || !UUID.test(id)) invalid('jobId 必须是小写 UUID。');
    const job = this.jobs.get(id);
    if (!job || job.source !== SOURCE || job.deletedAt) throw new ProviderError('找不到该聊天生图任务，或作品已移入回收站。', 404);
    return job;
  }
  summary(job) {
    return {
      jobId: job.id, requestId: job.id, status: job.status,
      prompt: job.prompt, size: job.size, quality: job.quality, format: job.format, background: job.background,
      imageModel: job.imageModel, channelId: job.channelId, channelName: job.channelName,
      createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
      images: job.outputs.map(asset => ({
        assetId: asset.id, mimeType: asset.mime, width: asset.width, height: asset.height, size: asset.size,
        path: path.resolve(this.jobs.assets.directory, `${asset.id}.${asset.format}`),
      })),
      error: job.error || '', warning: job.warning || '',
      nextAction: isActive(job) ? '使用 get_generation 查询此 jobId；不要创建新的生图任务。'
        : job.status === 'completed' ? '展示图片；原图已保存到 Imageboard 作品库。'
          : '任务已结束，未自动重新生成。只有用户要求重新创作时才使用新的 requestId。',
    };
  }
  async get(id, { waitSeconds = 0, signal } = {}) {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 20) invalid('waitSeconds 应为 0–20 的整数。');
    const job = this.job(id);
    if (waitSeconds && isActive(job) && !signal?.aborted) {
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); this.jobs.off('change', changed); signal?.removeEventListener('abort', finish); resolve(); };
        const changed = updated => { if (updated.id === id && !isActive(updated)) finish(); };
        const timer = setTimeout(finish, waitSeconds * 1000);
        this.jobs.on('change', changed);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
    return this.summary(this.job(id));
  }
}
