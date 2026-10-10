// Read-only browser fixture with the same resource CSP as the real MCP App.
// No generation or metadata write tools are forwarded.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dataDirectory } from '../server/runtime.mjs';

const client = new Client({ name: 'imageboard-ui-verification', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['server/mcp.mjs'], env: { ...process.env, IMAGEBOARD_DATA_DIR: dataDirectory() }, stderr: 'pipe' }));
const { tools } = await client.listTools();
const entry = tools.find(tool => tool.name === 'open_imageboard');
const { contents: [resource] } = await client.readResource({ uri: entry._meta.ui.resourceUri });
await mkdir('work/image-loading', { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/studio') {
      const resources = url.searchParams.has('legacy') ? [] : resource._meta.ui.csp.resourceDomains;
      const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: ${resources.join(' ')}; connect-src 'none'; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'`;
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(resource.text); return;
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 30 * 1024 * 1024) throw Error('Request too large'); chunks.push(chunk); }
      const params = JSON.parse(Buffer.concat(chunks)); let result;
      if (params.name === '__download') {
        const blob = Buffer.from(params.arguments.blob, 'base64');
        await writeFile('work/image-loading/download.png', blob);
        result = { bytes: blob.length, sha256: createHash('sha256').update(blob).digest('hex') };
      } else {
        const args = params.arguments || {};
        const read = params.name === 'imageboard_request' && (!args.method || args.method === 'GET');
        const binary = params.name === 'imageboard_transfer' && ['read_chunk', 'release'].includes(args.action);
        if (!read && !binary) throw Error('Read-only verification: mutation denied');
        result = await client.callTool(params);
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
    }
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(`<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}output{position:fixed;right:8px;bottom:8px;background:#fff;color:#111;font:12px system-ui;z-index:100;padding:4px}</style><iframe id="app" sandbox="allow-scripts allow-downloads" src="/studio${url.searchParams.has('legacy') ? '?legacy=1' : ''}"></iframe><output id="download-status" hidden></output><script>
      addEventListener('message',async event=>{
        const frame=document.getElementById('app');if(event.source!==frame.contentWindow||event.origin!=='null')return;
        const message=event.data;if(message.id===undefined)return;let result;
        if(message.method==='ui/initialize')result={protocolVersion:message.params.protocolVersion,hostInfo:{name:'Imageboard CSP verification',version:'1'},hostCapabilities:{serverTools:{},downloadFile:{}},hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen'],theme:'dark',platform:'desktop'}};
        else if(message.method==='tools/call')result=await fetch('/rpc',{method:'POST',body:JSON.stringify(message.params)}).then(r=>r.json());
        else if(message.method==='ui/download-file'){const saved=await fetch('/rpc',{method:'POST',body:JSON.stringify({name:'__download',arguments:message.params.contents[0].resource})}).then(r=>r.json());const status=document.getElementById('download-status');status.hidden=false;status.textContent='下载验证：'+saved.bytes+' 字节';result={};}
        else result={};frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result},'*');
      });</script>`);
  } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Verification request rejected' }] })); }
});
await new Promise(resolve => server.listen(47825, '127.0.0.1', resolve));
console.log('Imageboard CSP verification: http://127.0.0.1:47825 (add ?legacy=1 to reproduce the old policy)');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { server.closeAllConnections(); server.close(); await client.close(); });
