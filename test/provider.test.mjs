import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { refinePrompt, generateImage, readSse } from '../server/provider.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII=', 'base64');
async function upstream(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push({ path: req.url, body, auth: req.headers.authorization });
    handler(req, res, body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, headers: { Authorization: 'Bearer test-key' }, model: 'configured-model', imageModel: 'gpt-image-2.5-flare', wireApi: 'responses' };
  return { config, calls };
}

test('SSE parser handles Unicode and CRLF split across transport chunks', async () => {
  const bytes = Buffer.from('event: message\r\ndata: {"delta":"你好"}\r\n\r\ndata: [DONE]\n\n');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const events = []; for await (const event of readSse(chunks())) events.push(event);
  assert.deepEqual(events, [{ delta: '你好' }]);
});

test('uses configured text model, then exact image model and PNG response contract', async t => {
  const { config, calls } = await upstream(t, (req, res) => {
    if (req.url === '/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"response.output_text.delta","delta":"蓝色的梦"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    } else res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  const prompt = await refinePrompt(config, '一个梦');
  assert.equal(prompt, '蓝色的梦');
  const { image } = await generateImage(config, prompt, { size: '1024x1024', quality: 'low' });
  assert.deepEqual(image, PNG);
  assert.equal(calls[0].body.model, 'configured-model');
  assert.equal(calls[1].body.model, 'gpt-image-2.5-flare');
  assert.equal(calls[1].body.prompt, prompt);
  assert.equal(calls[1].body.response_format, undefined);
  assert.equal(calls[0].auth, 'Bearer test-key');
});

test('only tries /v1 for missing root endpoints; does not retry 5xx generations', async t => {
  const { config, calls } = await upstream(t, (req, res) => {
    if (req.url === '/responses') { res.writeHead(404); res.end(); }
    else if (req.url === '/v1/responses') res.end(JSON.stringify({ output_text: 'ready' }));
    else { res.writeHead(500); res.end('private-test-key upstream stack trace'); }
  });
  assert.equal(await refinePrompt(config, 'hello'), 'ready');
  await assert.rejects(generateImage(config, 'hello', { size: 'auto', quality: 'auto' }), error => /HTTP 500/.test(error.message) && !error.message.includes('private-test-key'));
  assert.deepEqual(calls.map(call => call.path), ['/responses', '/v1/responses', '/images/generations']);
});

test('rejects truncated text streams instead of sending partial prompts to image API', async t => {
  const { config } = await upstream(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"type":"response.output_text.delta","delta":"unfinished"}\n\n'); });
  await assert.rejects(refinePrompt(config, 'hello'), /未完整生成/);
});

test('supports chat completion providers and rejects non-PNG image payloads', async t => {
  const { config } = await upstream(t, (req, res) => {
    res.end(JSON.stringify(req.url === '/chat/completions' ? { choices: [{ message: { content: 'ready' } }] } : { data: [{ b64_json: Buffer.from('<html>not an image</html>').toString('base64') }] }));
  });
  config.wireApi = 'chat';
  assert.equal(await refinePrompt(config, 'hello'), 'ready');
  await assert.rejects(generateImage(config, 'hello', { size: 'auto', quality: 'auto' }), /PNG/);
});

test('edit endpoint carries actual image files, mask and output controls in multipart form',async t=>{
  let fields;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    assert.equal(req.url,'/images/edits');assert.equal(req.headers.authorization,'Bearer test-key');
    fields=await new Request('http://local.test',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();
    res.end(JSON.stringify({data:[{b64_json:PNG.toString('base64')},{b64_json:PNG.toString('base64')}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const config={baseUrl:`http://127.0.0.1:${server.address().port}`,headers:{Authorization:'Bearer test-key'},imageModel:'gpt-image-2.5-flare'};
  const result=await generateImage(config,'edit these',{size:'1024x1024',quality:'low',count:2,format:'webp',compression:75,background:'transparent',references:[{bytes:PNG,mime:'image/png',format:'png'},{bytes:PNG,mime:'image/png',format:'png'}],mask:{bytes:PNG}});
  assert.equal(result.images.length,2);assert.equal(fields.get('model'),'gpt-image-2.5-flare');assert.equal(fields.getAll('image[]').length,2);assert.equal(fields.get('n'),'2');assert.equal(fields.get('output_format'),'webp');assert.equal(fields.get('output_compression'),'75');assert.equal(fields.get('background'),'transparent');assert.equal(fields.get('mask').type,'image/png');assert.deepEqual(Buffer.from(await fields.getAll('image[]')[0].arrayBuffer()),PNG);
});

test('vision prompt conversion uses the configured model and actual input_image content',async t=>{
  const {config,calls}=await upstream(t,(_req,res)=>res.end(JSON.stringify({output_text:'ready'})));
  await refinePrompt(config,'use the subject',{references:[{roleLabel:'主体外观',note:'保留衣服',dataUrl:'data:image/png;base64,aGVsbG8='}]});
  assert.equal(calls[0].body.model,'configured-model');const content=calls[0].body.input[0].content;
  assert.equal(content[2].type,'input_image');assert.equal(content[2].image_url,'data:image/png;base64,aGVsbG8=');assert.match(content[1].text,/保留衣服/);
});
