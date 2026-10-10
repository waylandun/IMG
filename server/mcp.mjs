import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './mcp-bridge.mjs';
import { mcpDocument } from './embed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const resourceUri = `ui://imageboard/studio-${version}.html`;
const mimeType = 'text/html;profile=mcp-app';
const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#808080" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 16 5-5 5 5 4-4 4 4"/></svg>');
const icons = [{ src: icon, mimeType: 'image/svg+xml' }];
const appOnly = { ui: { resourceUri, visibility: ['app'] }, 'openai/widgetAccessible': true };
const tools = [
  { name: 'open_imageboard', title: 'Imageboard', description: '打开 Imageboard 生图工作室，使用用户自己的 Codex API 配置。', icons,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri }, 'openai/ui': { entrypoints: [{ type: 'global' }] }, 'openai/outputTemplate': resourceUri } },
  { name: 'imageboard_request', description: 'Imageboard 界面请求本地作品、配置或用户明确触发的创作操作。',
    inputSchema: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PATCH'] }, route: { type: 'string' }, body: { type: 'object' } }, required: ['route'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, _meta: appOnly },
  { name: 'imageboard_transfer', description: 'Imageboard 界面分片上传参考图或读取已生成图片。',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['begin_upload', 'upload_chunk', 'finish_upload', 'read_chunk', 'release'] }, id: { type: 'string' }, offset: { type: 'integer' }, size: { type: 'integer' }, type: { type: 'string' }, name: { type: 'string' }, mask: { type: 'boolean' }, data: { type: 'string' } }, required: ['action'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: appOnly },
];
const bridge = createBridge();
const server = new Server({ name: 'imageboard', title: 'Imageboard', version, icons }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: resourceUri, name: 'Imageboard', mimeType }] }));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  if (params.uri !== resourceUri) throw new Error('Unknown Imageboard resource');
  return { contents: [{ uri: resourceUri, mimeType, text: await mcpDocument(root), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }] };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    let result;
    if (params.name === 'open_imageboard') result = { app: 'Imageboard', ready: true };
    else if (params.name === 'imageboard_request') result = await bridge.request(params.arguments || {});
    else if (params.name === 'imageboard_transfer') result = await bridge.transfer(params.arguments || {});
    else throw new Error('Unknown Imageboard tool');
    return { content: [{ type: 'text', text: params.name === 'open_imageboard' ? 'Imageboard 已打开。' : '操作完成。' }], structuredContent: result };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
