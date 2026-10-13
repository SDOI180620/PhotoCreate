import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createEnvironmentManager,BUNDLE_DIR,environmentPath} from '../server/environment.js';
import {createApp} from '../server/index.js';
import {defaultVideoSettings,DEFAULT_VIDEO_MODELS} from '../shared/photo-video.js';
import {adminFetch} from './auth-client.js';
import {settleInstall} from './environment-fixtures.js';
import {videoEnvironmentFixture} from './video-environment-fixture.js';
import {videoTemplate} from '../server/video-workflow.js';

const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
test('shipped H3 catalog has pinned verified sources and every default, while the photo bundle remains optional',()=> {
  const manifest=JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR,'video-manifest.json'),'utf8'));
  for(const [role,fileName] of Object.entries(DEFAULT_VIDEO_MODELS)) assert.ok(manifest.resources.some(row=>row.role===role && row.fileName===fileName));
  for(const row of manifest.resources) if(row.kind==='model') {
    assert.match(row.url,new RegExp('/resolve/'+row.revision+'/'));assert.match(row.sha256,/^[a-f0-9]{64}$/);assert.ok(row.size>0);
    assert.equal(new URL(row.url).hostname,'huggingface.co');assert.ok(row.target.startsWith('models/'));
  } else {const bytes=fs.readFileSync(environmentPath(BUNDLE_DIR,row.source));assert.equal(bytes.length,row.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);}
});

test('H3 installer downloads selected variants only, skips installed models and never installs the photo environment',async t=> {
  const f=videoEnvironmentFixture(),manager=createEnvironmentManager(f);t.after(()=>{manager.close();f.cleanup();});
  const videoModels={...DEFAULT_VIDEO_MODELS,videoVae:'minimax_h3_video_vae_fp16.safetensors'};
  const existing=f.videoResources.find(row=>row.fileName===DEFAULT_VIDEO_MODELS.clip);write(path.join(f.root,existing.target),f.model);
  const plan=manager.plan(f.root,{purpose:'video',videoModels});
  assert.equal(plan.resources.length,5);assert.equal(plan.missingModelBytes,3*f.model.length);assert.equal(plan.modelsReady,false);
  manager.start(f.root,{purpose:'video',videoModels});const job=await settleInstall(manager);
  assert.equal(job.status,'completed');assert.equal(job.purpose,'video');assert.equal(job.restartRequired,false);assert.deepEqual(job.videoModels,videoModels);
  assert.equal(f.controls.videoRequests.length,3);assert.equal(f.controls.requests.length,0);
  assert.equal(manager.plan(f.root,{purpose:'video',videoModels}).modelsReady,true);
  assert.equal(fs.existsSync(path.join(f.root,f.manifest.resources[0].target)),false);
  assert.equal(fs.existsSync(path.join(f.root,f.videoResources.find(row=>row.fileName===DEFAULT_VIDEO_MODELS.videoVae).target)),false);
  manager.start(f.root,{purpose:'video',videoModels});await settleInstall(manager);assert.equal(f.controls.videoRequests.length,3);
});

test('H3 pause survives restart and resumes the same verified models from their partial size',async t=> {
  const f=videoEnvironmentFixture();f.controls.delay=7;
  let manager=createEnvironmentManager(f);t.after(()=>{manager.close();f.cleanup();});
  manager.start(f.root,{purpose:'video'});
  for(let i=0;i<200 && (manager.status().currentBytes || 0)<16384;i++) await new Promise(resolve=>setTimeout(resolve,5));
  manager.pause();assert.equal((await settleInstall(manager)).status,'paused');
  const target=path.join(f.root,f.videoResources[0].target),partial=fs.statSync(target+'.photocreate.part').size;
  assert.ok(partial>=16384 && partial<f.model.length);manager.close();
  manager=createEnvironmentManager(f);assert.equal(manager.status().purpose,'video');assert.deepEqual(manager.status().videoModels,DEFAULT_VIDEO_MODELS);
  manager.start(f.root,{purpose:'video',videoModels:manager.status().videoModels});assert.equal((await settleInstall(manager)).status,'completed');
  assert.equal(f.controls.videoRequests[1].offset,partial);assert.deepEqual(fs.readFileSync(target),f.model);
});

test('H3 bad downloads preserve old weights and unmanaged model selections cannot cause guessed downloads or traversal',async t=> {
  const f=videoEnvironmentFixture(),manager=createEnvironmentManager(f);t.after(()=>{manager.close();f.cleanup();});
  const target=path.join(f.root,f.videoResources[0].target);write(target,'old protected weights');f.controls.corrupt=true;
  manager.start(f.root,{purpose:'video'});assert.equal((await settleInstall(manager)).status,'failed');
  assert.equal(fs.readFileSync(target,'utf8'),'old protected weights');assert.equal(fs.statSync(target+'.photocreate.part').size,0);
  const models={...DEFAULT_VIDEO_MODELS,videoVae:'MiniMax-H3-video_vae.safetensors'};
  assert.deepEqual(manager.plan(f.root,{purpose:'video',videoModels:models}).manualModels,['影片 VAE']);
  assert.throws(()=>manager.start(f.root,{purpose:'video',videoModels:models}),/無法自動下載/);
  write(path.join(f.root,'models/vae',models.videoVae),f.model);assert.deepEqual(manager.plan(f.root,{purpose:'video',videoModels:models}).manualModels,[]);
  assert.throws(()=>manager.plan(f.root,{purpose:'video',videoModels:{unet:'../outside.safetensors'}}),/檔名無效/);
  assert.throws(()=>manager.start(f.root,{purpose:'unknown'}),/類型無效/);
});

test('admin H3 plan/save/download uses the selected environment and preserves prompt preferences; stale pause and busy installs are rejected',async t=> {
  const f=videoEnvironmentFixture(),instance=createApp({...f,environmentOptions:f,photoVideoOptions:{intervalMs:0}}),server=instance.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));instance.store.close();f.cleanup();});
  const request=async(route,body,method=body===undefined ? 'GET' : 'POST')=>{const r=await adminFetch(base+'/api'+route,{method,headers:{'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
  const preferences={...defaultVideoSettings(),defaultDuration:7,defaultAspectRatio:'9:16'};await request('/photo-videos/settings',preferences,'PUT');
  assert.equal((await request('/environment/pause',undefined,'POST')).status,200);
  assert.equal((await request('/photo-videos/models',undefined,'PATCH')).status,400);
  const videoModels={...DEFAULT_VIDEO_MODELS,videoVae:'minimax_h3_video_vae_fp16.safetensors'};
  assert.equal((await request('/photo-videos/models',{models:videoModels},'PATCH')).status,200);
  assert.equal(instance.photoVideos.settings().defaultDuration,7);assert.equal(instance.photoVideos.settings().defaultAspectRatio,'reference');
  const {models,...withoutModels}=preferences;withoutModels.defaultDuration=10;
  await request('/photo-videos/settings',withoutModels,'PUT');assert.deepEqual(instance.photoVideos.settings().models,videoModels);
  const query=new URLSearchParams({directory:f.root,url:'http://draft-comfy.test:8188'});
  const result=await request('/environment/video/plan?'+query);assert.equal(result.status,200);assert.equal(result.data.resources.length,5);assert.equal(result.data.active,false);
  assert.ok(result.data.choices.videoVae.includes(videoModels.videoVae));assert.equal(result.data.availability.ready,false);
  const remote=await request('/environment/video/plan?local=false&url=http%3A%2F%2Fremote.test%3A8188');assert.equal(remote.data.resources.length,0);
  assert.equal((await request('/environment/video/plan?models=bad')).status,400);
  assert.equal((await fetch(base+'/api/environment/video/plan')).status,401);
  assert.equal((await request('/environment/install',{directory:f.root,purpose:'video'})).status,400);
  await request('/environment/settings',{comfyDirectory:f.root,comfyUrl:'http://draft-comfy.test:8188'},'PUT');
  f.controls.foreignQueue=true;assert.equal((await request('/environment/install',{purpose:'video'})).status,409);f.controls.foreignQueue=false;
  f.controls.delay=7;const start=await request('/environment/install',{purpose:'video',videoModels});assert.equal(start.status,202);
  assert.equal((await request('/photo-videos/models',{models:DEFAULT_VIDEO_MODELS},'PATCH')).status,409);
  assert.equal((await request('/environment/pause',{jobId:'old-install'})).status,409);
  assert.equal((await request('/environment/pause',{jobId:start.data.job.id})).status,200);assert.equal((await settleInstall(instance.environment)).status,'paused');
  assert.equal((await request('/environment/install',{purpose:'video',videoModels:DEFAULT_VIDEO_MODELS})).status,409);
  f.controls.delay=0;assert.equal((await request('/environment/install',{purpose:'video',videoModels})).status,202);assert.equal((await settleInstall(instance.environment)).status,'completed');
  f.controls.missingVideoNode=true;const incomplete=await request('/environment/video/plan?'+query);assert.deepEqual(incomplete.data.availability.missingNodes,[videoTemplate().encode.class_type]);
  f.controls.missingVideoNode=false;assert.equal((await request('/environment/video/plan?'+query)).data.availability.ready,true);
  assert.deepEqual(instance.photoVideos.settings().models,videoModels);assert.equal(instance.photoVideos.settings().defaultDuration,10);
  assert.notEqual(instance.store.read().settings.comfyUrl,'http://draft-comfy.test:8188');
});
