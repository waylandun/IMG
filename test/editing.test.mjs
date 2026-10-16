import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Jobs,isActive} from '../server/jobs.mjs';

const png=await sharp({create:{width:64,height:64,channels:4,background:'#ccebff'}}).png().toBuffer();
const config={model:'my-default',imageModel:'gpt-image-2.5-flare',error:''};
async function setup(t,options={}) {
 const directory=await mkdtemp(path.join(os.tmpdir(),'imageboard-editing-'));
 const jobs=new Jobs({directory,configLoader:async()=>config,refine:async()=>'optimized',generate:async(_c,_p,o)=>({images:Array.from({length:o.count},()=>png)}),...options});
 await jobs.init(); t.after(async()=>{jobs.close();await jobs.writeQueue;await rm(directory,{recursive:true,force:true});});
 return {jobs,directory};
}
async function done(jobs,job) { if(!isActive(job))return job;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('timeout')),3000);const listener=next=>{if(next.id===job.id&&!isActive(next)){clearTimeout(timeout);jobs.off('change',listener);resolve(next);}};jobs.on('change',listener);}); }

test('references, their roles and vision inputs survive prompt preview and generation',async t=>{
 let seenText,seenImages,seenPrompt;
 const {jobs}=await setup(t,{refine:async(_c,p,options)=>{seenText=options;assert.match(p,/配色参考/);return 'optimized';},generate:async(_c,p,options)=>{seenImages=options;seenPrompt=p;return {images:[png,png]};}});
 const a=await jobs.assets.save(png),b=await jobs.assets.save(png);
 const input={prompt:'change the background',references:[{assetId:a.id,role:'base'},{assetId:b.id,role:'color',note:'use this green'}],count:2,format:'webp',compression:80};
 const preview=await done(jobs,await jobs.create({...input,mode:'refine'}));
 assert.equal(preview.status,'prepared');assert.equal(seenImages,undefined);assert.equal(seenText.references.length,2);assert.match(seenText.references[0].dataUrl,/^data:image\/png;base64,/);
 const output=await done(jobs,await jobs.create({...input,refinedPrompt:preview.refinedPrompt}));
 assert.equal(output.status,'completed');assert.equal(output.outputs.length,2);assert.equal(output.outputs[0].format,'webp');
 assert.equal(seenImages.references.length,2);assert.match(seenPrompt,/use this green/);assert.equal(seenImages.count,1);assert.equal(seenImages.format,'webp');
});

test('continuous editing uses the selected actual output and preserves branching ancestry',async t=>{
 let seen;
 const {jobs}=await setup(t,{generate:async(_c,_p,options)=>{seen=options;return {images:Array.from({length:options.count},()=>png)};}});
 const original=await done(jobs,await jobs.create({prompt:'initial',count:2,optimize:false}));
 const child=await done(jobs,await jobs.create({prompt:'make it warm',parent:{jobId:original.id,outputIndex:1},optimize:false}));
 assert.equal(child.status,'completed');assert.equal(child.rootId,original.id);assert.equal(child.parent.assetId,original.outputs[1].id);assert.equal(child.references[0].assetId,original.outputs[1].id);assert.equal(seen.references[0].id,original.outputs[1].id);
 const branch=await done(jobs,await jobs.create({prompt:'different branch',parent:{jobId:original.id,outputIndex:0},optimize:false}));
 assert.equal(branch.rootId,original.id);assert.notEqual(branch.parent.assetId,child.parent.assetId);
});

test('optimization and visual understanding can each be turned off independently',async t=>{
 let calls=0;
 const {jobs}=await setup(t,{refine:async(_c,_p,o)=>{calls++;assert.deepEqual(o.references,[]);return 'words only';}});
 const asset=await jobs.assets.save(png);
 await done(jobs,await jobs.create({prompt:'raw prompt',references:[{assetId:asset.id}],optimize:false}));assert.equal(calls,0);
 await done(jobs,await jobs.create({prompt:'text only',references:[{assetId:asset.id}],useVision:false}));assert.equal(calls,1);
});

test('edit jobs send a matching base/mask and retain real transparent output',async t=>{
 let seen;
 const transparent=await sharp({create:{width:64,height:64,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
 const {jobs}=await setup(t,{generate:async(_c,_p,o)=>{seen=o;return {images:[transparent]};}});
 const base=await jobs.assets.save(png),mask=await jobs.assets.save(transparent,{mask:true});
 const masked=await done(jobs,await jobs.create({prompt:'replace selection',optimize:false,references:[{assetId:base.id,role:'base'}],edit:{type:'inpaint',maskId:mask.id}}));
 assert.equal(masked.status,'completed');assert.equal(seen.mask.width,seen.references[0].width);assert.equal(masked.outputs[0].width,64);assert.equal(seen.background,'opaque');
 const removed=await done(jobs,await jobs.create({prompt:'isolate',optimize:false,action:'remove-background',references:[{assetId:base.id,role:'base'}],format:'webp'}));
 assert.equal(removed.background,'transparent');assert.equal(seen.background,'transparent');
 const raw=await sharp((await jobs.assets.bytes(removed.outputs[0].id)).bytes).ensureAlpha().raw().toBuffer();assert.equal(raw[3],0);
 await assert.rejects(jobs.create({prompt:'x',format:'jpeg',background:'transparent'}),/透明背景/);
});

test('metadata, trash and restore persist while invalid edits are rejected',async t=>{
 const {jobs,directory}=await setup(t);const job=await done(jobs,await jobs.create({prompt:'work',optimize:false}));
 await jobs.manage(job.id,{title:'A new name',tags:['poster','poster','green'],favorite:true});
 await jobs.manage(job.id,{deleted:true});assert.ok(job.deletedAt);
 await assert.rejects(jobs.create({prompt:'edit deleted',parent:{jobId:job.id,outputIndex:0}}),/回收站/);
 await jobs.manage(job.id,{deleted:false});assert.equal(job.deletedAt,null);
 const saved=JSON.parse(await readFile(path.join(directory,'jobs.json'),'utf8'))[0];assert.deepEqual(saved.tags,['poster','green']);assert.equal(saved.favorite,true);assert.equal(saved.title,'A new name');
 await assert.rejects(jobs.manage(job.id,{tags:['x'.repeat(33)]}),/标签/);
 await assert.rejects(jobs.create({prompt:'bad reference',references:[{assetId:'../../secret'}]}),/图片标识/);
});

test('legacy pictures are migrated with a backup and remain usable as edit inputs',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'imageboard-migrate-'));t.after(()=>rm(directory,{recursive:true,force:true}));const id=randomUUID();
 await mkdir(path.join(directory,'images'));await writeFile(path.join(directory,'images',`${id}.png`),png);
 const original=[{id,prompt:'old image',status:'completed',createdAt:new Date().toISOString(),imageUrl:`/api/images/${id}.png`}];
 await writeFile(path.join(directory,'jobs.json'),JSON.stringify(original));const jobs=new Jobs({directory,configLoader:async()=>config});await jobs.init();
 assert.equal(jobs.get(id).outputs.length,1);assert.equal(jobs.get(id).rootId,id);assert.equal(jobs.get(id).outputs[0].width,64);
 assert.deepEqual(JSON.parse(await readFile(path.join(directory,'backups/jobs-before-v2.json'),'utf8')),original);
});

test('variants use individual requests and keep successful pictures when a later variant fails',async t=>{
 let calls=0;
 const {jobs}=await setup(t,{generate:async(_c,_p,o)=>{calls++;assert.equal(o.count,1);if(calls===2)throw Error('second variant failed');return {images:[png]};}});
 const job=await done(jobs,await jobs.create({prompt:'variants',count:4,optimize:false}));
 assert.equal(calls,2);assert.equal(job.status,'failed');assert.equal(job.outputs.length,1);assert.match(job.warning,/1\/4/);
});

test('cancellation after a saved variant stops further requests without losing it',async t=>{
 let calls=0;
 const {jobs}=await setup(t,{generate:async()=>{calls++;return {images:[png]};}});
 jobs.on('change',job=>{if(job.status==='generating'&&job.outputs.length===1)jobs.cancel(job.id);});
 const job=await done(jobs,await jobs.create({prompt:'cancel variants',count:4,optimize:false}));
 assert.equal(calls,1);assert.equal(job.status,'cancelled');assert.equal(job.outputs.length,1);
});

test('position comments survive prompt preview, generation and disk persistence without a text prompt',async t=>{
 let refinedInput,generatedInput;
 const {jobs,directory}=await setup(t,{refine:async(_c,p)=>{refinedInput=p;return 'follow the image comments';},generate:async(_c,p)=>{generatedInput=p;return {image:png};}});
 const asset=await jobs.assets.save(png);
 const comments=[{x:.537,y:.32,text:'背景颜色换成粉色'},{x:.365,y:.593,text:'衣服颜色换成绿色'}];
 const input={prompt:'',references:[{assetId:asset.id,role:'general',comments}]};
 const preview=await done(jobs,await jobs.create({...input,mode:'refine'}));
 assert.equal(preview.status,'prepared');assert.equal(generatedInput,undefined);
 assert.match(refinedInput,/x: 53\.7%, y: 32%/);assert.match(refinedInput,/衣服颜色换成绿色/);
 const generated=await done(jobs,await jobs.create({...input,refinedPrompt:preview.refinedPrompt}));
 assert.equal(generated.status,'completed');assert.match(generatedInput,/x: 36\.5%, y: 59\.3%/);
 assert.deepEqual(generated.references[0].comments,comments);assert.equal(generated.title,'背景颜色换成粉色');
 const saved=JSON.parse(await readFile(path.join(directory,'jobs.json'),'utf8')).find(job=>job.id===generated.id);
 assert.deepEqual(saved.references[0].comments,comments);
 const restored=new Jobs({directory,configLoader:async()=>config});await restored.init();t.after(()=>restored.close());
 assert.deepEqual(restored.get(generated.id).references[0].comments,comments);
});

test('comments remain attached to the right image when a continuation puts its original first',async t=>{
 let generatedInput;
 const {jobs}=await setup(t,{generate:async(_c,p)=>{generatedInput=p;return {image:png};}});
 const original=await done(jobs,await jobs.create({prompt:'original',optimize:false}));
 const extra=await jobs.assets.save(png);
 const baseComments=[{x:0,y:1,text:'修改原图左下角'}],extraComments=[{x:1,y:0,text:'参考右上角颜色'}];
 const next=await done(jobs,await jobs.create({prompt:'',optimize:false,parent:{jobId:original.id},references:[{assetId:extra.id,comments:extraComments},{assetId:original.outputs[0].id,comments:baseComments}]}));
 assert.equal(next.status,'completed');assert.deepEqual(next.references[0].comments,baseComments);assert.deepEqual(next.references[1].comments,extraComments);
 assert.match(generatedInput,/图像 1 的位置评论[^]*x: 0%, y: 100%[^]*修改原图左下角/);
 assert.match(generatedInput,/图像 2 的位置评论[^]*x: 100%, y: 0%[^]*参考右上角颜色/);
});

test('rejects invalid or oversized position comments before invoking a model',async t=>{
 let calls=0;
 const {jobs}=await setup(t,{refine:async()=>{calls++;return 'unused';}});const asset=await jobs.assets.save(png);
 const create=comments=>jobs.create({prompt:'edit',references:[{assetId:asset.id,comments}]});
 for(const comment of [{x:-.1,y:.5,text:'x'},{x:.5,y:1.1,text:'x'},{x:NaN,y:0,text:'x'},{x:'0.5',y:.5,text:'x'},{x:.5,y:.5,text:''},{x:.5,y:.5,text:'x'.repeat(301)},null]) await assert.rejects(create([comment]),/评论/);
 await assert.rejects(create({}),/评论/);
 await assert.rejects(create(Array.from({length:21},()=>({x:0,y:0,text:'x'}))),/20 条评论/);
 const extra=await jobs.assets.save(png);const many=Array.from({length:20},()=>({x:0,y:0,text:'字'.repeat(300)}));
 await assert.rejects(jobs.create({prompt:'edit',references:[{assetId:asset.id,comments:many},{assetId:extra.id,comments:many}]}),/总计不得超过 8000/);
 await assert.rejects(jobs.create({prompt:'',references:[{assetId:asset.id}]}),/生图需求/);
 assert.equal(calls,0);
});
