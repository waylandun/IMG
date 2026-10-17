import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runConversationAgents, validateImageCall } from './agents.mjs';
import { ProviderError } from './provider.mjs';
import { isActive, SIZES, QUALITIES, ROLES, ACTIONS } from './jobs.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const running = turn => ['thinking', 'generating'].includes(turn.status);
const bad = message => { throw new ProviderError(message, 400); };
const jobStatus = job => isActive(job) ? 'generating' : job.status === 'prepared' ? 'completed' : job.status;
const defaults = { size: 'auto', quality: 'auto', count: 1, format: 'png', background: 'auto', compression: 90, useVision: true, optimize: true };

export class Conversations {
  constructor({ directory, jobs, configLoader, respond = runConversationAgents }) {
    Object.assign(this, { directory, jobs, configLoader, respond });
    this.items = new Map(); this.controllers = new Map();
    this.writeQueue = Promise.resolve(); this.acceptQueue = Promise.resolve();
    this.onJob = job => {
      const conversation = this.items.get(job.conversationId);
      const turn = conversation?.turns.find(item => item.id === job.turnId);
      if (!turn) return;
      turn.jobId = job.id; turn.status = jobStatus(job);
      conversation.updatedAt = new Date().toISOString();
      void this.persist().catch(() => {});
    };
    jobs.on('change', this.onJob);
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(path.join(this.directory, 'conversations.json'), 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error();
      for (const conversation of saved.items) {
        if (!UUID.test(conversation.id) || !Array.isArray(conversation.turns)) throw new Error();
        for (const turn of conversation.turns) {
          // Jobs are persisted before contacting the image API. Reconcile that
          // durable record if shutdown happened before the conversation write.
          const job = this.jobs.get(turn.jobId || turn.id);
          if (job?.conversationId === conversation.id && job.turnId === turn.id) {
            turn.jobId = job.id; turn.status = jobStatus(job);
          } else if (running(turn)) {
            turn.status = 'failed'; turn.error = '服务已重启，本轮对话已中断。不会自动重复生图。';
          }
        }
        this.items.set(conversation.id, conversation);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本地对话记录，请检查 conversations.json。'); }
    await this.persist();
  }
  persist() {
    const snapshot = JSON.stringify({ version: 1, items: [...this.items.values()] }, null, 2);
    const file = path.join(this.directory, 'conversations.json');
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 }); await rename(`${file}.tmp`, file);
    });
    return this.writeQueue;
  }
  isBusy() { return this.controllers.size > 0 || [...this.items.values()].some(c => c.turns.some(running)); }
  summary(conversation) {
    const last = conversation.turns.at(-1);
    const latestJob = [...conversation.turns].reverse().map(t => this.jobs.get(t.jobId)).find(j => j && !j.deletedAt && j.outputs?.length);
    return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
      status: last?.status || 'completed', preview: latestJob?.outputs[0] || null };
  }
  list() { return [...this.items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => this.summary(c)); }
  get(id) {
    const conversation = this.items.get(id);
    if (!conversation) throw new ProviderError('找不到该对话。', 404);
    return { ...this.summary(conversation), turns: conversation.turns.map(turn => {
      const { requestHash, ...visible } = turn;
      const job = this.jobs.get(turn.jobId);
      return { ...visible, job: job && !job.deletedAt ? job : null, imageUnavailable: !!job?.deletedAt };
    }) };
  }
  send(id, input) {
    const accepted = this.acceptQueue.catch(() => {}).then(() => this.accept(id, input));
    this.acceptQueue = accepted;
    return accepted;
  }
  async normalize(input) {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt.length > 8000) bad('消息不得超过 8000 字。');
    const mode = input.mode || 'auto';
    if (!['auto', 'generate', 'refine'].includes(mode)) bad('对话操作无效。');
    if (input.action !== undefined && !Object.hasOwn(ACTIONS, input.action)) bad('图片编辑操作无效。');
    if (input.refinedPrompt !== undefined && (typeof input.refinedPrompt !== 'string' || input.refinedPrompt.length > 16000)) bad('提示词无效。');
    const settings = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, input[key] ?? fallback]));
    if (!SIZES.includes(settings.size) || !QUALITIES.includes(settings.quality) || ![1, 2, 4].includes(settings.count) || !['png', 'jpeg', 'webp'].includes(settings.format) || !['auto', 'opaque', 'transparent'].includes(settings.background) || !Number.isInteger(settings.compression) || settings.compression < 0 || settings.compression > 100 || typeof settings.useVision !== 'boolean' || typeof settings.optimize !== 'boolean') bad('生成设置无效。');
    if (input.references !== undefined && (!Array.isArray(input.references) || input.references.length > 16)) bad('最多添加 16 张参考图。');
    let totalComments = 0;
    const references = await Promise.all((input.references || []).map(async ref => {
      if (!ref || !UUID.test(ref.assetId) || !Object.hasOwn(ROLES, ref.role || 'general') || (ref.note !== undefined && (typeof ref.note !== 'string' || ref.note.length > 300))) bad('参考图无效。');
      const asset = await this.jobs.assets.get(ref.assetId);
      if (asset.mask) bad('蒙版不能作为普通参考图。');
      if (ref.comments !== undefined && (!Array.isArray(ref.comments) || ref.comments.length > 20)) bad('每张参考图最多添加 20 条评论。');
      const comments = (ref.comments || []).map(comment => {
        if (!comment || !Number.isFinite(comment.x) || !Number.isFinite(comment.y) || comment.x < 0 || comment.x > 1 || comment.y < 0 || comment.y > 1 || typeof comment.text !== 'string' || !comment.text.trim() || comment.text.trim().length > 300) bad('图片评论无效。');
        totalComments += comment.text.trim().length;
        return { x: comment.x, y: comment.y, text: comment.text.trim() };
      });
      return { assetId: asset.id, asset, role: ref.role || 'general', note: ref.note || '', comments };
    }));
    if (totalComments > 8000 || new Set(references.map(ref => ref.assetId)).size !== references.length) bad('图片评论过长或参考图重复。');
    let parent = null;
    if (input.parent) {
      const previous = this.jobs.get(input.parent.jobId), index = input.parent.outputIndex ?? 0;
      const asset = previous?.outputs?.[index];
      if (!previous || previous.deletedAt || !Number.isInteger(index) || !asset) bad('要继续编辑的图片不存在。');
      parent = { jobId: previous.id, outputIndex: index, assetId: asset.id };
      const old = references.find(ref => ref.assetId === asset.id);
      if (old) old.role = 'base'; else references.unshift({ assetId: asset.id, asset, role: 'base', note: '当前选中的作品', comments: [] });
    }
    if (references.length > 16) bad('包括编辑原图在内最多 16 张图片。');
    if (!prompt && !references.length) bad('请输入消息或添加参考图。');
    let edit = null;
    if (input.edit) {
      const sourceId = input.edit.sourceId || references[0]?.assetId;
      if (!references.some(ref => ref.assetId === sourceId)) bad('编辑选区缺少对应原图。');
      if (input.edit.type === 'inpaint' && UUID.test(input.edit.maskId)) edit = { type: 'inpaint', sourceId, maskId: input.edit.maskId };
      else if (input.edit.type === 'outpaint' && input.edit.margins && typeof input.edit.margins === 'object') edit = { type: 'outpaint', sourceId, margins: Object.fromEntries(['top', 'right', 'bottom', 'left'].map(key => [key, input.edit.margins[key]])) };
      else bad('编辑选区无效。');
    }
    return { prompt, mode, settings, references, parent, edit, action: input.action || 'none', refinedPrompt: input.refinedPrompt || '' };
  }
  async accept(id, input) {
    if (this.closing) throw new ProviderError('服务正在退出，请重新连接。', 503);
    if (!UUID.test(id) || !UUID.test(input.requestId)) bad('消息标识无效，请刷新页面。');
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    let conversation = this.items.get(id);
    const existing = conversation?.turns.find(t => t.requestId === input.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ProviderError('这条消息的标识已使用，请重新发送新消息。', 409);
      return this.get(id);
    }
    if (this.isBusy() || this.jobs.starting || this.jobs.list().some(isActive)) throw new ProviderError('请等待当前回复或图片完成，也可以先停止。', 409);
    if (conversation?.turns.length >= 100) bad('当前对话已达 100 轮，请新建对话继续。');
    const draft = await this.normalize(input);
    const config = await this.configLoader();
    if (this.closing) throw new ProviderError('服务正在退出，请重新连接。', 503);
    if (draft.mode !== 'generate' && config.promptConfig.error) throw new ProviderError(`聊天模型不可用：${config.promptConfig.error}`, 422);
    const now = new Date().toISOString();
    conversation ||= { id, title: (draft.prompt || '图片讨论').slice(0, 100), createdAt: now, updatedAt: now, turns: [] };
    const turn = { id: randomUUID(), requestId: input.requestId, requestHash, ...draft, status: 'thinking', assistant: '', error: '', jobId: null, createdAt: now };
    conversation.turns.push(turn); conversation.updatedAt = now; this.items.set(id, conversation);
    const controller = new AbortController(); this.controllers.set(id, controller);
    try { await this.persist(); }
    catch (error) { conversation.turns.pop(); this.controllers.delete(id); throw error; }
    void this.run(conversation, turn, config, controller).catch(() => {});
    return this.get(id);
  }
  async context(conversation, turn, config) {
    const messages = [], available = new Map();
    const remember = (ref, parent) => { const origin = parent ?? available.get(ref.assetId)?.parent ?? null; available.delete(ref.assetId); available.set(ref.assetId, { ...ref, parent: origin }); };
    for (const entry of conversation.turns) {
      const notes = entry.references.map((ref, i) => `图${i + 1} ID=${ref.assetId}，用途=${ROLES[ref.role]}，说明=${ref.note}${ref.comments?.length ? `，位置评论=${JSON.stringify(ref.comments.map(c => ({ x: `${c.x * 100}%`, y: `${c.y * 100}%`, text: c.text })))}` : ''}`).join('\n');
      messages.push({ role: 'user', content: [entry.prompt || '请结合附图理解我的需求。', notes].filter(Boolean).join('\n\n') });
      for (const ref of entry.references) remember(ref);
      if (entry.assistant) messages.push({ role: 'assistant', content: entry.assistant });
      const job = this.jobs.get(entry.jobId);
      if (job) {
        messages.push({ role: 'assistant', content: `图片工具执行记录：${JSON.stringify({ status: job.status, prompt: job.refinedPrompt, outputs: job.deletedAt ? [] : job.outputs.map((asset, index) => ({ id: asset.id, option: index + 1 })), error: job.error || null, deleted: !!job.deletedAt })}` });
        if (!job.deletedAt) job.outputs.forEach((asset, outputIndex) => remember({ assetId: asset.id, asset, role: 'general', note: `生成方案${outputIndex + 1}`, comments: [] }, { jobId: job.id, outputIndex, assetId: asset.id }));
      } else if (entry !== turn && ['failed', 'cancelled'].includes(entry.status)) messages.push({ role: 'assistant', content: entry.status === 'cancelled' ? '本轮已被用户停止，没有完成生图。' : '本轮处理失败，没有完成生图。' });
    }
    // Prioritize this turn's selected images without losing output ancestry.
    for (const ref of turn.references) remember(ref, turn.parent?.assetId === ref.assetId ? turn.parent : available.get(ref.assetId)?.parent);
    const candidates = new Map([...available].slice(-16));
    const info = {
      settings: turn.settings, currentImageId: turn.parent?.assetId || turn.references.find(ref => ref.role === 'base')?.assetId || null,
      currentImagePrompt: turn.parent ? this.jobs.get(turn.parent.jobId)?.refinedPrompt : null,
      edit: turn.edit ? { type: turn.edit.type, sourceId: turn.edit.sourceId, margins: turn.edit.margins } : null,
      imageServiceAvailable: !config.imageConfig.error,
      availableImages: [...candidates.values()].map(ref => ({ id: ref.assetId, description: ref.note, width: ref.asset.width, height: ref.asset.height })),
      visionEnabled: turn.settings.useVision,
    };
    const last = messages.at(-1);
    last.content += `\n\n应用提供的当前上下文（参数为默认值，可按用户明确要求覆盖；图片 ID 只能从 availableImages 选择；局部编辑必须保留对应原图和选区）：\n${JSON.stringify(info)}`;
    if (messages.reduce((sum, message) => sum + message.content.length, 0) > 120000) throw new ProviderError('对话内容过长，请新建对话并带上需要保留的要求。', 400);
    if (turn.settings.useVision && candidates.size) last.images = await Promise.all([...candidates.values()].map(async ref => ({ label: `图片 ID=${ref.assetId}，${ref.note}`, dataUrl: await this.jobs.assets.visionImage(ref.assetId) })));
    return { messages, candidates };
  }
  imageInput(turn, call, candidates) {
    // Validate injected/test adapters too; the model cannot select arbitrary
    // assets or pass executable URLs, credentials or provider configuration.
    const checked = validateImageCall({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }).arguments;
    const references = checked.referenceIds.map(id => {
      const ref = candidates.get(id);
      if (!ref) throw new ProviderError('模型选择了不在本轮上下文中的图片，请重新指定参考图。');
      return { assetId: id, role: id === checked.baseImageId ? 'base' : ref.role === 'base' ? 'general' : ref.role, note: ref.note, comments: ref.comments };
    });
    if (turn.edit && checked.baseImageId !== turn.edit.sourceId) throw new ProviderError('生图原图与当前选区不一致，请指定要修改的图片。');
    const options = { ...turn.settings };
    for (const key of ['size', 'quality', 'count', 'format', 'background']) if (checked[key] !== null) options[key] = checked[key];
    if (options.background === 'transparent' && options.format === 'jpeg') options.format = 'png';
    return { ...options, prompt: turn.prompt || '根据图片与对话创作', refinedPrompt: checked.prompt, mode: 'generate', optimize: false,
      references, parent: checked.baseImageId ? candidates.get(checked.baseImageId)?.parent : null, edit: turn.edit, action: 'none' };
  }
  async run(conversation, turn, config, controller) {
    const { signal } = controller;
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), 3 * 60_000);
    try {
      let input;
      if (turn.mode === 'auto') {
        const { messages, candidates } = await this.context(conversation, turn, config);
        signal.throwIfAborted();
        const result = await this.respond(config.promptConfig, messages, { signal, imageReady: !config.imageConfig.error, onText: text => { if (!signal.aborted) turn.assistant = text; } });
        signal.throwIfAborted(); turn.assistant = result.text;
        if (!result.toolCall) { turn.status = 'completed'; return; }
        if (config.imageConfig.error) throw new ProviderError(`生图不可用：${config.imageConfig.error}`, 422);
        input = this.imageInput(turn, result.toolCall, candidates);
        turn.toolCall = result.toolCall;
      } else {
        input = { ...turn.settings, ...Object.fromEntries(['prompt', 'references', 'parent', 'edit', 'action', 'refinedPrompt', 'mode'].map(key => [key, turn[key]])) };
        if (turn.mode === 'refine' && !turn.refinedPrompt) {
          const { messages } = await this.context(conversation, turn, config);
          signal.throwIfAborted();
          input.refinedPrompt = await this.jobs.refine(config.promptConfig, `结合以下会话整理本次创作提示词，保留前文已经确定的要求：\n${messages.map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`).join('\n\n')}`, {
            signal, size: turn.settings.size, references: (messages.at(-1).images || []).map(image => ({ roleLabel: image.label, note: '', dataUrl: image.dataUrl })),
          });
          input.prompt ||= '结合对话整理图片提示词';
        }
      }
      signal.throwIfAborted();
      turn.jobId = turn.id;
      await this.persist();
      signal.throwIfAborted();
      const job = await this.jobs.create(input, { jobId: turn.id, conversationId: conversation.id, turnId: turn.id, config, signal });
      turn.status = jobStatus(job);
    } catch (error) {
      turn.status = signal.aborted && signal.reason?.message !== 'timeout' ? 'cancelled' : 'failed';
      turn.error = signal.aborted ? signal.reason?.message === 'timeout' ? '理解需求超时，请重试。未自动重发生图请求。' : '' : error instanceof ProviderError ? error.message : '对话处理失败，请检查模型连接后重试。';
    } finally {
      clearTimeout(timeout); this.controllers.delete(conversation.id);
      conversation.updatedAt = new Date().toISOString(); await this.persist();
    }
  }
  cancel(id) {
    const conversation = this.items.get(id);
    if (!conversation) throw new ProviderError('找不到该对话。', 404);
    this.controllers.get(id)?.abort(new Error('cancelled'));
    const turn = conversation.turns.at(-1), job = this.jobs.get(turn?.jobId);
    if (job && isActive(job)) this.jobs.cancel(job.id);
    return this.get(id);
  }
  close() { this.closing = true; for (const controller of this.controllers.values()) controller.abort(new Error('shutdown')); }
}
