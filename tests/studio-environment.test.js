import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createEnvironmentManager} from '../server/environment.js';
import {videoEnvironmentFixture} from './video-environment-fixture.js';
import {settleInstall} from './environment-fixtures.js';
import {DEFAULT_VIDEO_MODELS} from '../shared/photo-video.js';
import {videoUiTemplate} from '../server/video-workflow.js';
import {createApp} from '../server/index.js';
import {adminFetch} from './auth-client.js';

const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
test('one studio installation fills both environments, skips installed weights, and makes no download on repetition',async t=>{
  const f=videoEnvironmentFixture(),manager=createEnvironmentManager(f);t.after(()=>{manager.close();f.cleanup();});
  const clip=f.videoResources.find(r=>r.fileName===DEFAULT_VIDEO_MODELS.clip);write(path.join(f.root,clip.target),f.model);
  const plan=manager.plan(f.root,{purpose:'studio'});assert.ok(plan.resources.some(r=>r.section==='photo'));assert.ok(plan.resources.some(r=>r.section==='video'));assert.equal(plan.resources.find(r=>r.role==='clip').status,'installed');
  assert.equal(new Set(plan.resources.map(r=>r.target)).size,plan.resources.length);
  manager.start(f.root,{purpose:'studio'});assert.equal((await settleInstall(manager)).status,'completed');
  assert.equal(f.controls.videoRequests.length,3);assert.equal(manager.plan(f.root,{purpose:'studio'}).missingModelBytes,0);
  const downloads=f.controls.videoRequests.length+f.controls.requests.filter(r=>r.url.startsWith('https://models.test/')).length;
  manager.start(f.root,{purpose:'studio'});const repeated=await settleInstall(manager);assert.equal(repeated.resourceCount,0);assert.equal(repeated.totalBytes,0);
  assert.equal(f.controls.videoRequests.length+f.controls.requests.filter(r=>r.url.startsWith('https://models.test/')).length,downloads);
});
test('studio repair preserves edited usable workflows and repairs malformed workflows with a backup',async t=>{
  const f=videoEnvironmentFixture(),manager=createEnvironmentManager(f);t.after(()=>{manager.close();f.cleanup();});
  const target=path.join(f.root,f.videoManifest.resources[0].target),ui=videoUiTemplate();ui.nodes.find(n=>n.properties?.photocreate_role==='resolution').widgets_values[1]=1.7;
  const bytes=JSON.stringify(ui);write(target,bytes);
  let row=manager.plan(f.root,{purpose:'studio'}).resources.find(r=>r.kind==='workflow' && r.section==='video');assert.equal(row.customized,true);assert.equal(row.status,'installed');
  manager.start(f.root,{purpose:'studio'});await settleInstall(manager);assert.equal(fs.readFileSync(target,'utf8'),bytes);
  write(target,'broken JSON');row=manager.plan(f.root,{purpose:'studio'}).resources.find(r=>r.kind==='workflow' && r.section==='video');assert.equal(row.status,'different');
  manager.start(f.root,{purpose:'studio'});const result=await settleInstall(manager);assert.equal(result.status,'completed');assert.ok(JSON.parse(fs.readFileSync(target)).nodes.length>0);
  assert.equal(fs.readFileSync(path.join(f.root,'.photocreate-backups',result.id,f.videoManifest.resources[0].target),'utf8'),'broken JSON');
});

test('the unified API installs, verifies and binds both environments while preserving edited H3 parameters',async t=>{
  const f=videoEnvironmentFixture(),instance=createApp({...f,environmentOptions:f,photoVideoOptions:{intervalMs:0}}),server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));instance.store.close();f.cleanup();});
  const base='http://127.0.0.1:'+server.address().port,request=async(route,body,method=body ? 'POST' : 'GET')=>{const r=await adminFetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});return {status:r.status,data:await r.json()};};
  await request('/environment/settings',{comfyUrl:'http://127.0.0.1:8188',comfyDirectory:f.root,cameraVersion:'2511'},'PUT');
  const ui=videoUiTemplate();ui.nodes.find(n=>n.properties?.photocreate_role==='resolution').widgets_values[1]=1.7;write(path.join(f.root,f.videoManifest.resources[0].target),JSON.stringify(ui));
  const plan=await request('/environment/plan?purpose=studio');assert.equal(plan.status,200);assert.ok(plan.data.videoChoices.unet.length);assert.ok(plan.data.resources.some(r=>r.section==='photo'));
  assert.equal((await request('/environment/install',{purpose:'studio',directory:f.root})).status,202);await settleInstall(instance.environment);
  assert.equal((await request('/environment/activate',{purpose:'studio'})).status,200);
  assert.equal((await request('/photo-videos/parameters')).data.megapixels,1.7);assert.equal(instance.store.read().settings.connectionMode,'directory');
  const downloads=f.controls.videoRequests.length;assert.equal((await request('/environment/install',{purpose:'studio',directory:f.root})).status,202);await settleInstall(instance.environment);assert.equal(instance.environment.status().resourceCount,0);assert.equal(f.controls.videoRequests.length,downloads);
});
