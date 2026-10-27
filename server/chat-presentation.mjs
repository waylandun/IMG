import path from 'node:path';

const terminalStates = ['completed', 'failed', 'cancelled'];
const labels = { refining: '正在理解需求', generating: '正在创建图像', completed: '图片已生成', failed: '生成失败', cancelled: '已停止' };

export function presentGeneration(data) {
  const terminal = terminalStates.includes(data.status);
  const images = (data.images || []).filter(image => typeof image.path === 'string' && path.isAbsolute(image.path));
  const markdown = terminal ? images.map((image, index) => {
    const target = image.path.replace(/[<>\r\n]/g, character => encodeURIComponent(character)).replace(/\\/g, '/');
    return `![Imageboard 生成图片${images.length > 1 ? ` ${index + 1}` : ''}](<${target}>)`;
  }).join('\n\n') : '';
  const started = Date.parse(data.createdAt), finished = Date.parse(data.completedAt || data.updatedAt);
  const elapsed = (terminal && Number.isFinite(finished) ? finished : Date.now()) - started;
  const display = {
    terminal, ready: !!markdown, label: data.status === 'completed' && !markdown ? '图片结果不可用' : labels[data.status] || '正在读取任务',
    elapsedSeconds: Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 1000)) : 0,
    completedCount: images.length, totalCount: 1, markdown,
  };
  const nextAction = !terminal ? '任务仍在进行。继续 get_generation 查询同一 jobId，不能宣称生成完成。'
    : markdown ? '必须在最终回复中直接插入 display.markdown，不要加代码围栏，也不要只说已保存。工具图片预览和 image() 输出不代表用户已在聊天看到图片。'
      : data.status === 'completed' ? '任务未返回可展示的图片，请说明结果异常，不要宣称图片已展示。'
        : '说明任务的失败或停止状态；不要自动重新生图。';
  return { ...data, display, nextAction };
}

export function generationText(data) {
  const lines = [`${data.display.label}。任务 ID：${data.jobId}`, data.nextAction];
  if (data.display.markdown) lines.push('请将下面的图片直接放进最终回复：', data.display.markdown);
  if (data.error) lines.push(`原因：${data.error}`);
  if (data.warning) lines.push(data.warning);
  if (data.previewError) lines.push(data.previewError);
  return lines.join('\n\n');
}
