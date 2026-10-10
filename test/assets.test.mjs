import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { Assets } from '../server/assets.mjs';

const solid = color => sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
async function setup(t) { const directory = await mkdtemp(path.join(os.tmpdir(),'imageboard-assets-')); t.after(()=>rm(directory,{recursive:true,force:true})); const assets=new Assets(directory);await assets.init();return assets; }

test('validates image content, dimensions and output formats',async t=>{
  const assets=await setup(t);
  await assert.rejects(assets.save(Buffer.from('<svg>not a bitmap</svg>')),/无法读取/);
  await assert.rejects(assets.get('../secret'),/标识/);
  for(const format of ['png','jpeg','webp']) {
    const asset=await assets.save(await solid('#00ff0088'),{format,compression:80});
    assert.equal(asset.format,format);assert.equal(asset.width,64);
    const metadata=await sharp((await assets.bytes(asset.id)).bytes).metadata();
    assert.equal(metadata.format,format);if(format!=='jpeg')assert.ok(metadata.hasAlpha);
  }
});

test('mask alpha controls editing and unselected pixels remain identical',async t=>{
  const assets=await setup(t),original=await solid('#ff0000'),base=await assets.save(original);
  const pixels=Buffer.alloc(64*64*4,0);for(let i=0;i<pixels.length;i+=4)pixels[i+3]=255;
  for(let y=16;y<32;y++)for(let x=16;x<32;x++)pixels[(y*64+x)*4+3]=0;
  const mask=await assets.save(await sharp(pixels,{raw:{width:64,height:64,channels:4}}).png().toBuffer(),{mask:true});
  await assets.prepare({type:'inpaint',sourceId:base.id,maskId:mask.id});
  const result=await assets.preserveOutside(await solid('#0000ff'),base.id,mask.id);
  const raw=await sharp(result).raw().toBuffer();
  assert.deepEqual([...raw.subarray(0,4)],[255,0,0,255]);
  assert.deepEqual([...raw.subarray((20*64+20)*4,(20*64+20)*4+4)],[0,0,255,255]);
  const full=await assets.save(await solid('#000000'),{mask:true});
  await assert.rejects(assets.prepare({type:'inpaint',sourceId:base.id,maskId:full.id}),/先涂抹/);
});

test('outpainting expands canvas, protects original and validates bounds',async t=>{
  const assets=await setup(t),base=await assets.save(await solid('#ffaa00'));
  const edit=await assets.prepare({type:'outpaint',sourceId:base.id,margins:{left:25,right:25,top:0,bottom:0}});
  assert.equal(edit.base.width,96);assert.equal(edit.base.height,64);assert.equal(edit.size,'auto');
  const mask=await sharp((await assets.bytes(edit.mask.id)).bytes).ensureAlpha().raw().toBuffer();
  assert.equal(mask[3],0);assert.equal(mask[16*4+3],255);
  const result=await assets.preserveOutside(await solid('#0000ff'),edit.base.id,edit.mask.id);
  const raw=await sharp(result).raw().toBuffer();
  assert.deepEqual([...raw.subarray(0,4)],[0,0,255,255]);
  assert.deepEqual([...raw.subarray(16*4,16*4+4)],[255,170,0,255]);
  await assert.rejects(assets.prepare({type:'outpaint',sourceId:base.id,margins:{left:101,right:0,top:0,bottom:0}}),/边距/);
});

test('grayscale references are composited as RGBA rather than corrupting protected pixels',async t=>{
 const assets=await setup(t);
 const gray=await sharp(await solid('#808080')).greyscale().png().toBuffer();
 const base=await assets.save(gray),mask=await assets.save(await solid('#000000'),{mask:true});
 const result=await assets.preserveOutside(await solid('#0000ff'),base.id,mask.id);
 const raw=await sharp(result).ensureAlpha().raw().toBuffer();assert.deepEqual([...raw.subarray(0,4)],[128,128,128,255]);
});
