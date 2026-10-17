import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { generateImage, refinePrompt, ProviderError } from './provider.mjs';
import { Assets } from './assets.mjs';

export const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '1536x864', '864x1536'];
export const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export const ROLES = { base: '待编辑原图', subject: '主体外观参考', style: '风格参考', composition: '构图参考', color: '配色参考', background: '场景背景参考', general: '综合参考' };
export const ACTIONS = {
  none: '', style: '只转换视觉风格，尽量保留主体和构图。', recolor: '按用户要求修改颜色，保留主体、光影和构图。',
  text: '只修改用户指定的图片文字，准确呈现目标文案，保留其他排版。', translate: '翻译图片内的文字并保持原来的布局和视觉风格。',
  sketch: '将草图转换为真实感画面，保持草图的布局、比例和透视。',
  'remove-background': '移除背景，保留主体及自然边缘，输出真实透明背景，不要棋盘格。',
  'replace-background': '仅替换背景，保留主体身份、形状和细节，使光影融合自然。',
};
export const isActive = job => ['refining', 'generating'].includes(job.status);
const bad = message => { throw new ProviderError(message, 400); };

export class Jobs extends EventEmitter {
  constructor({ directory, configLoader, refine = refinePrompt, generate = generateImage }) {
    super();
    Object.assign(this, { directory, configLoader, refine, generate });
    this.assets = new Assets(directory);
    this.items = new Map(); this.controllers = new Map(); this.writeQueue = Promise.resolve(); this.starting = false;
  }
  async init() {
    await mkdir(path.join(this.directory, 'images'), { recursive: true, mode: 0o700 });
    await this.assets.init();
    let records = [];
    try { records = JSON.parse(await readFile(path.join(this.directory, 'jobs.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本地图片历史，请检查 .data/jobs.json。'); }
    if (records.some(job => job.schemaVersion !== 2)) {
      await mkdir(path.join(this.directory, 'backups'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.directory, 'backups/jobs-before-v2.json'), JSON.stringify(records, null, 2), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    for (const record of records) {
      const job = { title: record.prompt?.slice(0, 100) || '未命名作品', tags: [], favorite: false, deletedAt: null, references: [], outputs: [], count: 1, format: 'png', compression: 90, background: 'auto', optimize: true, useVision: true, action: 'none', ...record };
      if (isActive(job)) { job.status = 'failed'; job.error = '服务已重启，之前的生成已中断。'; }
      if (!job.outputs.length && job.imageUrl && /^[a-f0-9-]{36}$/.test(job.id)) {
        const bytes = await readFile(path.join(this.directory, 'images', `${job.id}.png`));
        job.outputs = [await this.assets.save(bytes, { name: job.title })];
      }
      job.rootId ||= job.id; job.schemaVersion = 2;
      if (job.outputs.length) job.imageUrl = job.outputs[0].url;
      this.items.set(job.id, job);
    }
    await this.persist();
  }
  list() { return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { return this.items.get(id); }
  persist() {
    const snapshot = JSON.stringify(this.list(), null, 2);
    const file = path.join(this.directory, 'jobs.json');
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 }); await rename(`${file}.tmp`, file);
    });
    return this.writeQueue;
  }
  async update(job, patch) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.persist(); this.emit('change', job);
  }
  async manage(id, input) {
    const job = this.get(id);
    if (!job) throw new ProviderError('找不到该作品。', 404);
    const patch = {};
    if (input.title !== undefined) {
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 100) bad('作品名称应为 1–100 字。');
      patch.title = input.title.trim();
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 32)) bad('最多 20 个标签，每个不超过 32 字。');
      patch.tags = [...new Set(input.tags.map(tag => tag.trim()))];
    }
    if (input.favorite !== undefined) { if (typeof input.favorite !== 'boolean') bad('收藏参数无效。'); patch.favorite = input.favorite; }
    if (input.deleted !== undefined) {
      if (typeof input.deleted !== 'boolean') bad('回收站参数无效。');
      if (isActive(job)) throw new ProviderError('请先停止正在运行的任务。', 409);
      patch.deletedAt = input.deleted ? new Date().toISOString() : null;
    }
    await this.update(job, patch); return job;
  }
  async create(input, internal = {}) {
    if (internal.jobId && this.items.has(internal.jobId)) {
      const existing = this.items.get(internal.jobId);
      if (existing.conversationId !== internal.conversationId || existing.turnId !== internal.turnId) throw new ProviderError('图片任务标识已使用。', 409);
      return existing;
    }
    internal.signal?.throwIfAborted();
    if (this.starting || [...this.items.values()].some(isActive)) throw new ProviderError('已有图片任务正在运行，请等待完成或先停止。', 409);
    this.starting = true;
    try {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      const refinedPrompt = typeof input.refinedPrompt === 'string' ? input.refinedPrompt.trim() : '';
      if (prompt.length > 8_000 || refinedPrompt.length > 16_000) bad('生图需求不得超过 8000 字。');
      const size = input.size || 'auto', quality = input.quality || 'auto', format = input.format || 'png';
      const count = input.count ?? 1, compression = input.compression ?? 90;
      const optimize = input.optimize !== false, useVision = input.useVision !== false, action = input.action || 'none';
      let background = input.background || 'auto';
      if (!SIZES.includes(size) || !QUALITIES.includes(quality)) bad('尺寸或画质参数无效。');
      if (!['png', 'jpeg', 'webp'].includes(format) || ![1, 2, 4].includes(count) || !Number.isInteger(compression) || compression < 0 || compression > 100) bad('输出格式、张数或压缩质量无效。');
      if (!Object.hasOwn(ACTIONS, action)) bad('快捷编辑类型无效。');
      if (action === 'remove-background') background = 'transparent';
      if (!['auto', 'opaque', 'transparent'].includes(background)) bad('背景参数无效。');
      if (background === 'transparent' && format === 'jpeg') bad('透明背景请选择 PNG 或 WebP。');
      if (input.mode && !['refine', 'generate'].includes(input.mode)) bad('任务类型无效。');
      if (input.references !== undefined && (!Array.isArray(input.references) || input.references.length > 16)) bad('最多上传 16 张参考图。');
      let references = [];
      let commentLength = 0;
      for (const ref of input.references || []) {
        if (!ref || typeof ref !== 'object' || !Object.hasOwn(ROLES, ref.role || 'general') || (ref.note !== undefined && (typeof ref.note !== 'string' || ref.note.length > 300))) bad('参考图用途或说明无效。');
        const asset = await this.assets.get(ref.assetId);
        if (asset.mask) bad('蒙版不能作为普通参考图。');
        if (ref.comments !== undefined && (!Array.isArray(ref.comments) || ref.comments.length > 20)) bad('每张参考图最多添加 20 条评论。');
        const comments = (ref.comments || []).map(comment => {
          if (!comment || !Number.isFinite(comment.x) || !Number.isFinite(comment.y) || comment.x < 0 || comment.x > 1 || comment.y < 0 || comment.y > 1) bad('评论位置必须在图片范围内。');
          if (typeof comment.text !== 'string' || !comment.text.trim() || comment.text.trim().length > 300) bad('每条评论应为 1–300 字。');
          const text = comment.text.trim(); commentLength += text.length;
          return { x: comment.x, y: comment.y, text };
        });
        references.push({ assetId: asset.id, asset, role: ref.role || 'general', note: ref.note || '', comments });
      }
      if (commentLength > 8000) bad('图片评论总计不得超过 8000 字。');
      if (!prompt && !commentLength) bad('请输入生图需求，或为参考图添加评论。');
      if (new Set(references.map(ref => ref.assetId)).size !== references.length) bad('同一张参考图只能添加一次。');
      let parent = null;
      if (input.parent) {
        const previous = this.get(input.parent.jobId);
        const index = input.parent.outputIndex ?? 0;
        if (!previous || previous.deletedAt || !Number.isInteger(index) || !previous.outputs?.[index]) bad('要继续编辑的版本不存在或已移入回收站。');
        const asset = previous.outputs[index];
        parent = { jobId: previous.id, outputIndex: index, assetId: asset.id };
        const comments = references.find(ref => ref.assetId === asset.id)?.comments || [];
        references = [{ assetId: asset.id, asset, role: 'base', note: '在这张图上继续修改', comments }, ...references.filter(ref => ref.assetId !== asset.id)];
      }
      if (references.length > 16) bad('包括原图在内最多 16 张参考图。');
      if (action !== 'none' && !references.length) bad('请先上传或选择要编辑的图片。');
      let preparedEdit = null;
      if (input.edit && input.edit.type !== 'none') {
        if (!references.length) bad('请先选择编辑原图。');
        preparedEdit = await this.assets.prepare({ ...input.edit, sourceId: references[0].assetId });
        if (background === 'auto') background = preparedEdit.type === 'inpaint' && references[0].asset.transparent ? 'transparent' : 'opaque';
      }
      const loaded = internal.config || await this.configLoader();
      const config = { promptConfig: loaded.promptConfig || loaded, imageConfig: loaded.imageConfig || loaded };
      const needsPrompt = !refinedPrompt && (optimize || input.mode === 'refine');
      if (input.mode !== 'refine' && config.imageConfig.error) throw new ProviderError(config.imageConfig.error, 422);
      if (needsPrompt && config.promptConfig.error) throw new ProviderError(`提示词优化不可用：${config.promptConfig.error} 可关闭优化后直接生图。`, 422);
      internal.signal?.throwIfAborted();
      const id = internal.jobId || randomUUID();
      const job = {
        schemaVersion: 2, id, rootId: parent ? this.get(parent.jobId).rootId : id, parent,
        prompt, refinedPrompt, title: (prompt || references.flatMap(ref => ref.comments || [])[0]?.text || '图片创作').slice(0, 100), tags: [], favorite: false, deletedAt: null,
        size, quality, count, format, compression, background, optimize, useVision, action, references,
        edit: preparedEdit, outputs: [], mode: input.mode || 'generate',
        status: needsPrompt ? 'refining' : 'generating',
        model: config.promptConfig.model, imageModel: config.imageConfig.imageModel,
        channelId: loaded.public?.defaultChannelId, channelName: loaded.public?.channelName,
        ...(internal.conversationId ? { conversationId: internal.conversationId, turnId: internal.turnId } : {}),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      this.items.set(job.id, job); await this.persist();
      const controller = new AbortController(); this.controllers.set(job.id, controller);
      const cancel = () => controller.abort(internal.signal.reason);
      if (internal.signal?.aborted) cancel(); else internal.signal?.addEventListener('abort', cancel, { once: true });
      void this.run(job, config, controller).catch(() => {}).finally(() => internal.signal?.removeEventListener('abort', cancel));
      return job;
    } finally { this.starting = false; }
  }
  instructions(job) {
    const lines = [];
    if (job.parent) lines.push('这是连续编辑任务：以图1为当前版本，按本次需求修改，保留未要求改变的内容。');
    job.references.forEach((ref, i) => {
      lines.push(`图${i + 1}的用途：${ROLES[ref.role]}。${ref.note}`);
      if (ref.comments?.length) {
        lines.push(`图像 ${i + 1} 的位置评论（坐标以图片左上角为原点，x 向右、y 向下，均为图片宽高的百分比；按位置理解修改对象）：`);
        ref.comments.forEach((comment, index) => lines.push(`${index + 1}. (x: ${Number((comment.x * 100).toFixed(1))}%, y: ${Number((comment.y * 100).toFixed(1))}%) ${comment.text}`));
      }
    });
    if (ACTIONS[job.action]) lines.push(ACTIONS[job.action]);
    if (job.edit?.type === 'inpaint') lines.push('仅在图1的蒙版透明区域内进行修改，保持原有构图、光线和未选中区域。');
    if (job.edit?.type === 'outpaint') lines.push('图1是扩展后的画布，仅自然补全透明区域，与原图内容、透视和光线连续，保留原图。');
    if (job.background === 'transparent') lines.push('输出具有真实 alpha 通道的透明背景，不要棋盘格或纯色背景。');
    return lines.join('\n');
  }
  async run(job, config, controller) {
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), 10 * 60_000);
    const { signal } = controller;
    try {
      const context = this.instructions(job);
      if (!job.refinedPrompt) {
        const references = job.useVision && (job.optimize || job.mode === 'refine') ? await Promise.all(job.references.map(async ref => ({ roleLabel: ROLES[ref.role], note: ref.note, dataUrl: await this.assets.visionImage(ref.assetId) }))) : [];
        const refinedPrompt = job.optimize || job.mode === 'refine'
          ? await this.refine(config.promptConfig, `${context}\n用户本次要求：${job.prompt}`, { size: job.size, signal, references })
          : job.prompt;
        signal.throwIfAborted(); await this.update(job, { refinedPrompt });
      }
      if (job.mode === 'refine') { await this.update(job, { status: 'prepared' }); return; }
      signal.throwIfAborted(); await this.update(job, { status: 'generating' });
      const refs = await Promise.all(job.references.map(ref => this.assets.bytes(ref.assetId)));
      if (job.edit) refs[0] = await this.assets.bytes(job.edit.base.id);
      const mask = job.edit ? await this.assets.bytes(job.edit.mask.id) : undefined;
      const outputs = [], usages = [];
      // Gateways may silently ignore n>1. Request each selected variant exactly once,
      // persisting it immediately so a later failure/cancellation cannot discard it.
      for (let index = 0; index < job.count; index++) {
        signal.throwIfAborted();
        const result = await this.generate(config.imageConfig, context ? `${context}\n\n${job.refinedPrompt}` : job.refinedPrompt, {
          size: job.edit?.size || job.size, quality: job.quality, count: 1, format: job.format,
          compression: job.compression, background: job.background, references: refs, mask, signal,
        });
        signal.throwIfAborted();
        let image = result.images?.[0] || result.image;
        if (job.edit) image = await this.assets.preserveOutside(image, job.edit.base.id, job.edit.mask.id);
        outputs.push(await this.assets.save(image, { name: job.title, format: job.format, compression: job.compression }));
        usages.push(result.usage || null);
        await this.update(job, { outputs: [...outputs], imageUrl: outputs[0].url, usage: job.count === 1 ? usages[0] : { requests: [...usages] } });
        signal.throwIfAborted();
      }
      await this.update(job, {
        status: 'completed', outputs, imageUrl: outputs[0].url,
        warning: job.background === 'transparent' && outputs.some(asset => !asset.transparent) ? '部分结果没有透明像素，网关可能未执行透明背景要求。已保留实际图片。' : '',
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const cancelled = signal.aborted && signal.reason?.message !== 'timeout';
      await this.update(job, { status: cancelled ? 'cancelled' : 'failed', warning: job.outputs.length ? `已保留 ${job.outputs.length}/${job.count} 个方案。` : '', error: cancelled ? '' : signal.aborted ? '生成等待超过 10 分钟。上游可能仍在处理，请确认后再重试。' : error instanceof ProviderError ? error.message : '处理失败，请检查网关连接或输入图片后重试。' });
    } finally { clearTimeout(timeout); this.controllers.delete(job.id); }
  }
  cancel(id) {
    const job = this.get(id); if (!job) throw new ProviderError('找不到该任务。', 404);
    this.controllers.get(id)?.abort(new Error('cancelled')); return job;
  }
  close() { for (const controller of this.controllers.values()) controller.abort(new Error('shutdown')); }
}
