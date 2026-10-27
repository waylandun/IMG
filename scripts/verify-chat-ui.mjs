// Isolated, simulated MCP host. All images are local fixtures, never paid requests.
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../server/index.mjs';
import { ProviderError } from '../server/provider.mjs';

const root = path.resolve(import.meta.dirname, '..');
const directory = await mkdtemp(path.join(os.tmpdir(), 'imageboard-card-ui-'));
const output = path.join(root, 'work/chat-card'); await mkdir(output, { recursive: true });
const token = randomBytes(32).toString('hex');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#182434"/><stop offset="1" stop-color="#456f89"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="900" cy="180" r="260" fill="#d9c4a3"/><path d="M0 700 410 280 900 800H0" fill="#8fa9b3"/><path d="M440 800 790 390 1200 800" fill="#708d92"/><text x="90" y="130" fill="#fff" font-family="sans-serif" font-size="36" letter-spacing="8">IMAGEBOARD</text><text x="90" y="190" fill="#d6e4eb" font-family="sans-serif" font-size="22">CHAT PREVIEW · LOCAL TEST IMAGE</text></svg>';
const png = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(path.join(output, 'fixture.png'), png);
let pending, current, calls = 0, failImageRead = false;
const service = await createServer({ directory, accessToken: token,
  configLoader: async () => ({ imageModel: 'local-ui-fixture', error: '', public: { ready: true } }),
  generate: (_config, _prompt, { signal }) => new Promise((resolve, reject) => {
    calls++; pending = { resolve: () => resolve({ image: png }), reject: () => reject(new ProviderError('模拟生成失败，请调整需求后再试。')) };
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }),
});
await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(directory, 'native-runtime.json'), JSON.stringify({ origin: `http://127.0.0.1:${service.server.address().port}`, token, pid: process.pid }));
const client = new Client({ name: 'imageboard-card-verification', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/mcp.mjs')], env: { ...process.env, IMAGEBOARD_DATA_DIR: directory }, stderr: 'pipe' }));
const { tools } = await client.listTools();
const tool = tools.find(item => item.name === 'generate_image');
const { contents: [resource] } = await client.readResource({ uri: tool._meta.ui.resourceUri });
const json = (res, result, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 30 * 1024 * 1024) throw Error('Too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks));
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/card') {
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
      res.end(resource.text); return;
    }
    if (url.pathname === '/fixture/state') { json(res, { calls, status: current && service.jobs.get(current)?.status, jobId: current }); return; }
    if (req.method === 'POST' && url.pathname === '/fixture/new') {
      current = randomUUID(); pending = undefined;
      const result = await client.callTool({ name: 'generate_image', arguments: { requestId: current, prompt: 'Local chat UI verification', size: '1536x1024' } });
      json(res, result); return;
    }
    if (req.method === 'POST' && ['/fixture/complete', '/fixture/fail'].includes(url.pathname)) {
      if (!pending) throw Error('No active fixture');
      url.pathname.endsWith('complete') ? pending.resolve() : pending.reject(); pending = undefined;
      json(res, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/fixture/image-error') { failImageRead = true; json(res, { ok: true }); return; }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const params = await body(req), args = params.arguments || {};
      if (params.name === '__download') {
        const bytes = Buffer.from(args.blob, 'base64'); await writeFile(path.join(output, 'download.png'), bytes);
        json(res, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); return;
      }
      const query = params.name === 'get_generation' && args.jobId === current;
      const asset = params.name === 'imageboard_request' && args.method === 'GET' && /^\/api\/assets\/[a-f0-9-]{36}$/.test(args.route);
      const binary = params.name === 'imageboard_transfer' && ['read_chunk', 'release'].includes(args.action);
      if (!query && !asset && !binary) throw Error('Only fixture reads are allowed');
      if (asset && failImageRead) {
        failImageRead = false;
        json(res, { structuredContent: { status: 503, json: { error: 'Simulated read error' } }, content: [{ type: 'text', text: 'Simulated read error' }] }); return;
      }
      json(res, await client.callTool(params)); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Imageboard 聊天卡片验证</title>
      <style>body{font:14px system-ui;background:#171717;color:#eee;margin:0;padding:24px}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}button,select{font:inherit;padding:7px 10px}iframe{display:block;width:640px;max-width:100%;height:550px;border:0;margin:auto}output{display:block;margin:18px auto;max-width:640px;font-size:12px}</style>
      <nav><button id="new" disabled>开始模拟生成</button><button id="complete" disabled>完成生成</button><button id="fail" disabled>模拟失败</button><button id="image-error">下次读图失败</button><select id="theme" aria-label="主题"><option value="dark">深色</option><option value="light">浅色</option></select><select id="width" aria-label="宽度"><option value="640">640px</option><option value="360">360px</option></select></nav>
      <iframe id="app" title="图片创作卡片" sandbox="allow-scripts allow-downloads" src="/card"></iframe><output id="status">等待卡片连接</output>
      <script>
      const frame=document.getElementById('app'), status=document.getElementById('status');let ready=false;
      const send=(method,params)=>frame.contentWindow.postMessage({jsonrpc:'2.0',method,params},'*');
      async function post(route,data){return fetch(route,{method:'POST',body:JSON.stringify(data||{})}).then(r=>r.json());}
      let displayMode='inline';
      addEventListener('message',async event=>{
        if(event.source!==frame.contentWindow||event.origin!=='null')return;
        const message=event.data;
        if(message.method==='ui/notifications/initialized'){ready=true;document.getElementById('new').disabled=false;status.textContent='卡片已连接';return;}
        if(message.method==='ui/notifications/size-changed'){if(message.params.height)frame.style.height=Math.min(1000,Math.max(180,message.params.height))+'px';return;}
        if(message.id===undefined)return;let result;
        try{
          if(message.method==='ui/initialize')result={protocolVersion:message.params.protocolVersion,hostInfo:{name:'Imageboard inline verification',version:'1'},hostCapabilities:{serverTools:{},downloadFile:{}},hostContext:{displayMode,availableDisplayModes:['inline','fullscreen'],theme:document.getElementById('theme').value,platform:'desktop'}};
          else if(message.method==='ui/request-display-mode'){displayMode=['inline','fullscreen'].includes(message.params.mode)?message.params.mode:displayMode;frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode,availableDisplayModes:['inline','fullscreen']}},'*');result={mode:displayMode};}
          else if(message.method==='tools/call')result=await post('/rpc',message.params);
          else if(message.method==='ui/download-file'){const saved=await post('/rpc',{name:'__download',arguments:message.params.contents[0].resource});status.textContent='已下载 '+saved.bytes+' 字节';result={};}
          else result={};
          frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result},'*');
        }catch(error){frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Fixture request failed'}},'*');}
      });
      document.getElementById('new').onclick=async()=>{if(!ready)return;const result=await post('/fixture/new');if(result.isError){status.textContent='创建失败';return;}const id=result.structuredContent.jobId;send('ui/notifications/tool-input',{arguments:{requestId:id}});send('ui/notifications/tool-result',result);document.getElementById('complete').disabled=false;document.getElementById('fail').disabled=false;status.textContent='模拟任务已创建';};
      for(const action of ['complete','fail'])document.getElementById(action).onclick=async()=>{await post('/fixture/'+action);document.getElementById('complete').disabled=true;document.getElementById('fail').disabled=true;status.textContent=action==='complete'?'已返回模拟图片':'已返回模拟失败';};
      document.getElementById('image-error').onclick=async()=>{await post('/fixture/image-error');status.textContent='下一次读图将失败，可测试重新读取';};
      document.getElementById('theme').onchange=event=>{document.body.style.background=event.target.value==='dark'?'#171717':'#fff';document.body.style.color=event.target.value==='dark'?'#eee':'#222';send('ui/notifications/host-context-changed',{theme:event.target.value});};
      document.getElementById('width').onchange=event=>frame.style.width=event.target.value+'px';
      </script></html>`);
  } catch (error) { if (!res.headersSent) json(res, { error: error.message }, 400); else res.end(); }
});
await new Promise(resolve => server.listen(47826, '127.0.0.1', resolve));
console.log('Chat UI verification: http://127.0.0.1:47826');
let closing = false;
async function close() {
  if (closing) return; closing = true;
  service.jobs.close(); service.conversations.close();
  await client.close(); server.closeAllConnections(); service.server.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => service.server.close(resolve))]);
  const deadline = Date.now() + 3000;
  while (service.jobs.controllers.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  await service.jobs.writeQueue; await service.conversations.writeQueue;
  await rm(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
