import sharp from 'sharp';
import { generationInput, UUID } from './chat-generations.mjs';
import { SIZES, QUALITIES } from './jobs.mjs';
import { createBridge } from './mcp-bridge.mjs';
import { presentGeneration, generationText } from './chat-presentation.mjs';

export const chatTools = [
  {
    name: 'generate_image', title: 'Imageboard 聊天生图',
    description: '用户指定 Imageboard 生图或将其设为默认时创建一张图片，并在支持的宿主显示进度卡片。仅讨论或索要提示词时不要调用。返回后继续 get_generation 直到终态；最终回复必须直接插入返回的 display.markdown 图片。不能只说已保存到作品库。同一次请求重试沿用 requestId 和参数。',
    inputSchema: { type: 'object', properties: {
      requestId: { type: 'string', pattern: UUID.source, description: '本次创作的小写 UUID，也是 jobId。重试沿用原值；只有新的创作使用新 UUID。' },
      prompt: { type: 'string', minLength: 1, maxLength: 8000, description: '结合当前聊天要求整理的完整生图提示词，直接发送给生图模型。' },
      size: { type: 'string', enum: SIZES, default: 'auto' },
      quality: { type: 'string', enum: QUALITIES, default: 'auto' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], default: 'png' },
      background: { type: 'string', enum: ['auto', 'opaque', 'transparent'], default: 'auto' },
    }, required: ['requestId', 'prompt'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_generation', title: '获取 Imageboard 生图结果',
    description: '查询聊天生图任务，可等待最多 20 秒，不触发生图。display.terminal=false 时继续查询同一任务；完成后必须把 display.markdown 原样插入最终回复，不加代码围栏，不能只回复已保存。工具内的图片和 image() 输出不是最终聊天消息。创建响应丢失时可用原 requestId 查询。',
    inputSchema: { type: 'object', properties: {
      jobId: { type: 'string', pattern: UUID.source },
      waitSeconds: { type: 'integer', minimum: 0, maximum: 20, default: 20 },
      includeImage: { type: 'boolean', default: true, description: '完成后是否附带图片预览；原图路径始终返回。' },
    }, required: ['jobId'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const response = (data, extra = []) => {
  const presented = data.jobId && data.status ? presentGeneration(data) : data;
  return { content: [{ type: 'text', text: presented.display ? generationText(presented) : JSON.stringify(presented) }, ...extra], structuredContent: presented };
};
const failure = (message, details = {}) => ({ ...response({ error: message, ...details }), isError: true });

export function createChatTools({ bridge = createBridge() } = {}) {
  async function json(args) {
    const result = await bridge.request(args);
    if (result.status === 404 && result.json?.error === '页面不存在。') return failure('当前图片服务尚未加载聊天生图接口。等待现有任务完成，关闭工作室并等旧服务空闲退出后再连接。', {
      statusCode: 404, code: 'service_upgrade_required', nextAction: '先完成图片服务升级，再恢复本次请求；不要更换 requestId 或反复提交。',
    });
    if (result.status >= 400) return failure(result.json?.error || 'Imageboard 请求失败。', { statusCode: result.status });
    if (!result.json) throw new Error('Imageboard 返回了无效的任务结果。');
    return response(result.json);
  }
  return {
    async generate(args) {
      let input;
      try { input = generationInput(args); }
      catch (error) { return failure(error.message); }
      try {
        return await json({ method: 'POST', route: '/api/chat/generations', body: input });
      } catch {
        return failure('未能确认任务是否创建。先使用 get_generation 查询；不要换 requestId 重发生图。', {
          jobId: input.requestId, requestId: input.requestId,
          nextAction: '使用原 requestId 查询；若确认不存在，可保持全部参数及 requestId 不变重试 generate_image。',
        });
      }
    },
    async get(args) {
      if (!args || Object.keys(args).some(key => !['jobId', 'waitSeconds', 'includeImage'].includes(key)) || typeof args.jobId !== 'string' || !UUID.test(args.jobId)) return failure('请提供有效的 jobId，且只使用支持的查询参数。');
      const { jobId, waitSeconds = 20, includeImage = true } = args;
      if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 20 || typeof includeImage !== 'boolean') return failure('waitSeconds 应为 0–20 的整数，includeImage 应为布尔值。');
      let result;
      try { result = await json({ route: `/api/chat/generations/${jobId}?waitSeconds=${waitSeconds}` }); }
      catch { return failure('暂时无法查询 Imageboard，请稍后使用同一个 jobId 继续查询。', { jobId }); }
      if (result.isError || !includeImage || ['refining', 'generating'].includes(result.structuredContent.status)) return result;
      const previews = [];
      try {
        for (const asset of result.structuredContent.images) {
          // Use the authenticated bridge; never accept arbitrary paths or URLs from a tool caller.
          if (!UUID.test(asset.assetId)) throw new Error('Invalid asset');
          const downloaded = await bridge.request({ route: `/api/assets/${asset.assetId}` });
          if (downloaded.status !== 200 || !downloaded.binary) throw new Error('Image unavailable');
          const binary = downloaded.binary, chunks = [];
          try {
            for (let offset = 0; offset < binary.size;) {
              const part = await bridge.transfer({ action: 'read_chunk', id: binary.id, offset });
              chunks.push(Buffer.from(part.data, 'base64')); offset = part.nextOffset;
            }
          } finally { await bridge.transfer({ action: 'release', id: binary.id }); }
          const preview = await sharp(Buffer.concat(chunks)).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
          previews.push({ type: 'image', data: preview.toString('base64'), mimeType: 'image/webp' });
        }
      } catch {
        return response({ ...result.structuredContent, previewError: '图片预览暂时无法读取，可使用原图路径展示，或用同一 jobId 重新查询；无需重新生图。' }, previews);
      }
      return response(result.structuredContent, previews);
    },
  };
}
