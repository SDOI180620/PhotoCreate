import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {previewFixture,until} from './preset-preview-fixture.js';
import {login} from './auth-client.js';
import {DRAFT,PNG} from './fixtures.js';
import {buildShotPlans} from '../shared/domain.js';
import {buildCameraStage} from '../server/camera-workflow.js';
import {REFINE_PROMPT,REFINE_NEGATIVE,REFINE_STEPS,cameraPrompt} from '../shared/camera.js';
import {productionStages,productionProgress,PHOTO_REFINEMENT_VERSION} from '../shared/production.js';
import {withSingleSubjectPrompt} from '../shared/subject.js';

const nodes=(graph,type)=>Object.values(graph).filter(node=>node.class_type===type);
async function fixture(t,{camera=false,allowModelRelease=false}={}) {
  const f=await previewFixture({camera,allowModelRelease});t.after(()=>f.close());
  f.store.mutate(state=>{
    const [plan]=buildShotPlans(state,{...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing'],cameraMode:'multiangle',cameraEnabled:false,aspectRatio:'9:16'});
    state.settings.releaseGpuMemory=false;
    state.jobs=[{...plan,id:'original',seed:123,status:'completed',createdAt:new Date().toISOString(),images:[{filename:'first.png',subfolder:'PhotoCreate',type:'output'},{filename:'second.png',subfolder:'PhotoCreate',type:'output'}]}];
  });
  fs.mkdirSync(path.join(f.outputDir,'PhotoCreate'),{recursive:true});for(const file of ['first.png','second.png'])fs.writeFileSync(path.join(f.outputDir,'PhotoCreate',file),PNG);
  f.source=()=>f.store.read().jobs.find(job=>job.id==='original');
  f.finish=async()=>{f.complete(f.submitted.at(-1).id);await f.stageRunner.tick();};
  f.customer=async(name)=>{
    const username=`refine-${name}`,user=await f.authentication.createCustomer({username,password:'fixture-pass'});
    const db=new DatabaseSync(path.join(f.dataDir,'accounts.sqlite'),{readOnly:true}),ownerId=db.prepare('SELECT owner_id FROM accounts WHERE id=?').get(user.id).owner_id;db.close();
    const {cookie}=await login(f.base,username,'fixture-pass');
    return {ownerId,request:async(route,body)=>{const response=await fetch(f.base+'/api/studio'+route,{method:body===undefined ? 'GET' : 'POST',headers:{Cookie:cookie,'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}};
  };
  return f;
}

test('畫質優化只執行20步細節修復，以選取輸出為來源且保留照片比例與原照',async t=>{
  const f=await fixture(t),source=structuredClone(f.source());
  const body={requestId:'refine-selected-output',imageIndex:1,refineDenoise:1,steps:99};
  const created=await f.request('/jobs/original/refine',body);assert.equal(created.status,201);
  const job=created.data.job;assert.deepEqual(productionStages(job),['refine']);assert.equal(job.sourceImage.filename,'second.png');assert.equal(job.sourceImageIndex,1);assert.equal(job.deleteSourceOnComplete,false);assert.equal(job.cameraEnabled,false);
  assert.equal((await f.request('/jobs/submit',{ids:[job.id]})).status,200);assert.equal(f.submitted.length,1);
  const graph=f.submitted[0].prompt,sampler=nodes(graph,'KSampler')[0],encoder=nodes(graph,'TextEncodeQwenImage21')[0];
  assert.equal(nodes(graph,'KSampler').length,1);assert.equal(nodes(graph,'LoadImage').length,1);assert.equal(nodes(graph,'TextEncodeQwenImageEditPlus').length,0);assert.equal(nodes(graph,'QwenMultiangleCameraNode').length,0);
  assert.equal(sampler.inputs.steps,REFINE_STEPS);assert.equal(sampler.inputs.denoise,0.2);assert.equal(sampler.inputs.seed,source.seed+2);assert.deepEqual(sampler.inputs.latent_image,['refine_latent',0]);
  assert.equal(encoder.inputs.prompt,REFINE_PROMPT);assert.equal(encoder.inputs.negative_prompt,REFINE_NEGATIVE);assert.equal(graph.refine_size.inputs.width,source.outputWidth);assert.equal(graph.refine_size.inputs.height,source.outputHeight);
  const exported=await f.request(`/jobs/${job.id}/prompt`);assert.deepEqual(exported.data.stages.map(row=>row.stage),['refine']);assert.ok(nodes(exported.data.stages[0].prompt,'LoadImage')[0].inputs.image.includes('angle-source-'));
  await f.finish();const complete=f.store.read().jobs.find(row=>row.id===job.id);assert.equal(complete.status,'completed');assert.deepEqual(Object.keys(complete.stageResults),['refine']);assert.equal(complete.images.length,1);assert.deepEqual(f.source(),source);assert.ok(fs.existsSync(path.join(f.outputDir,'PhotoCreate','second.png')));
  const details=(await f.request(`/jobs/${job.id}/prompts`)).data;assert.equal(details.defaultStage,'refine');assert.deepEqual(details.stages.map(row=>row.id),['base','refine']);assert.equal(details.stages[0].label,'拍攝來源');assert.match(details.stages[0].image,/original\/image\/1$/);assert.equal(details.stages[1].label,'畫質優化');assert.equal(details.stages[1].settings.steps,20);assert.equal(details.stages[1].positive,REFINE_PROMPT);
});

test('畫質優化請求可安全重送，拒絕來源變更、錯誤索引與同一照片的重複任務',async t=>{
  const f=await fixture(t),body={requestId:'idempotent-refine',imageIndex:0};
  const first=await f.request('/jobs/original/refine',body);assert.equal(first.status,201);
  const again=await f.request('/jobs/original/refine',body);assert.equal(again.status,200);assert.equal(again.data.created,false);assert.equal(again.data.job.id,first.data.job.id);
  assert.equal((await f.request('/jobs/original/refine',{...body,imageIndex:1})).status,409);
  assert.equal((await f.request('/jobs/original/refine',{requestId:'another-refine'})).status,400);
  for(const imageIndex of [-1,0.5,100,'0'])assert.equal((await f.request('/jobs/original/refine',{requestId:randomUUID(),imageIndex})).status,400);
  assert.equal((await f.request('/jobs/original/refine',{requestId:randomUUID(),imageIndex:2})).status,400);
  assert.equal(f.store.read().jobs.length,2);assert.equal(f.submitted.length,0);
});

test('顧客可獨立優化自己的照片，不需要相機或服裝候選，拒絕跨帳號與回收照片',async t=>{
  const f=await fixture(t),alice=await f.customer('alice'),bob=await f.customer('bob');
  f.store.mutate(state=>{state.jobs[0].visitorId=alice.ownerId;state.customerRecipe=null;state.garments=[];state.presets=[];});
  const state=(await alice.request('/state')).data;assert.equal(state.photoRefinement,PHOTO_REFINEMENT_VERSION);assert.equal(state.refineReady,true);assert.equal(state.ready,false);assert.equal(state.cameraReady,false);
  assert.equal((await bob.request('/jobs/original/refine',{requestId:randomUUID()})).status,404);
  assert.equal((await f.request('/jobs/original/refine',{requestId:randomUUID()})).status,404);
  const body={requestId:randomUUID(),imageIndex:1},created=await alice.request('/jobs/original/refine',body);assert.equal(created.status,202);await until(()=>f.submitted.length===1);
  const job=f.store.read().jobs.find(row=>row.id===created.data.job.id);assert.equal(job.visitorId,alice.ownerId);assert.equal(job.sourceImage.filename,'second.png');
  assert.equal((await alice.request('/jobs/original/refine',body)).data.created,false);assert.equal(f.submitted.length,1);
  await f.finish();assert.equal((await alice.request('/state')).data.jobs.filter(row=>row.rootId==='original').length,2);
  f.store.mutate(state=>{state.jobs.find(row=>row.id==='original').visitorDeletedAt=new Date().toISOString();});
  assert.equal((await alice.request('/jobs/original/refine',{requestId:randomUUID()})).status,404);
});

test('單獨優化沿用既有模型釋放屏障，不中斷其他佇列並只生成一張優化版本',async t=>{
  const f=await fixture(t,{allowModelRelease:true});f.store.mutate(state=>{state.settings.releaseGpuMemory=true;});f.pending.add('foreign-task');
  const created=await f.request('/jobs/original/refine',{requestId:'refine-with-release'});await f.request('/jobs/submit',{ids:[created.data.job.id]});
  assert.equal(f.submitted.length,0);assert.equal(f.calls.includes('/free'),false);
  f.pending.delete('foreign-task');await f.stageRunner.tick();assert.equal(f.submitted.length,1);assert.equal(nodes(f.submitted[0].prompt,'KSampler').length,0);assert.equal(f.calls.filter(route=>route==='/free').length,1);
  await f.finish();assert.equal(f.submitted.length,2);assert.equal(nodes(f.submitted[1].prompt,'KSampler')[0].inputs.steps,20);assert.equal(productionProgress(f.store.read().jobs).stage,'refine');
  await f.finish();assert.equal(f.store.read().jobs.find(row=>row.id===created.data.job.id).status,'completed');assert.equal(f.calls.filter(route=>route==='/free').length,1);assert.equal(f.source().images.length,2);
});

test('換角度版本可直接優化目前輸出，之後自訂拍攝仍沿用原本完整設定',async t=>{
  const f=await fixture(t,{camera:true}),original=structuredClone(f.source()),angle={horizontalAngle:225,verticalAngle:31,zoom:7};
  const angled={...original,id:'angled-version',rootJobId:'original',sourceJobId:'original',remakeVersion:1,jobKind:'angle-edit',cameraEnabled:true,camera:{id:'changed-camera',name:'自訂角度',angle,prompt:cameraPrompt(angle)},sourceInput:'PhotoCreate/old-angle-input.png',sourceInputComfyUrl:'http://old-engine:8188',images:[{filename:'angle.png',subfolder:'PhotoCreate',type:'output'}],prompt:cameraPrompt(angle)};
  fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','angle.png'),PNG);f.store.mutate(state=>state.jobs.unshift(angled));
  const created=await f.request('/jobs/angled-version/refine',{requestId:'refine-angle-version'});assert.equal(created.status,201);assert.equal(created.data.job.sourceImage.filename,'angle.png');assert.equal(created.data.job.sourceInput,undefined);assert.equal(created.data.job.sourceInputComfyUrl,undefined);
  await f.request('/jobs/submit',{ids:[created.data.job.id]});await f.finish();
  const refined=f.store.read().jobs.find(row=>row.id===created.data.job.id);assert.equal(refined.rootJobId,'original');assert.equal(refined.remakeVersion,2);
  const custom=await f.request(`/jobs/${refined.id}/custom`,{requestId:'custom-after-refine',customization:{preserveOriginal:true}});assert.equal(custom.status,201);assert.equal(custom.data.job.prompt,original.prompt);assert.equal(custom.data.job.cameraEnabled,true);assert.deepEqual(custom.data.job.camera.angle,angle);assert.deepEqual(productionStages(custom.data.job),['base','angle','refine']);
});

test('換角度版本重新拍攝會將保存鏡位帶入實際換角度提詞與新Seed',async t=>{
  const f=await fixture(t,{camera:true}),angle={horizontalAngle:300,verticalAngle:51,zoom:9};
  const created=await f.request('/jobs/original/angle',{requestId:'angle-before-remake',angle,deleteSourceOnComplete:false});await f.request('/jobs/submit',{ids:[created.data.job.id]});await f.finish();await f.finish();
  const source=f.store.read().jobs.find(row=>row.id===created.data.job.id);assert.equal(source.status,'completed');
  const details=(await f.request(`/jobs/${source.id}/prompts`)).data;assert.equal(details.defaultStage,'angle');assert.deepEqual(details.stages.find(row=>row.id==='angle').angle,angle);
  const remake=await f.request('/jobs/remake',{ids:[source.id],requestId:'remake-angled-version'});const job=remake.data.jobs[0];assert.deepEqual(job.camera.angle,angle);assert.notEqual(job.seed,source.seed);
  await f.request('/jobs/submit',{ids:[job.id]});const graph=f.submitted.at(-1).prompt,encoder=nodes(graph,'TextEncodeQwenImageEditPlus')[0];assert.deepEqual(encoder._meta.cameraAngle,angle);assert.equal(encoder.inputs.prompt,cameraPrompt(angle));assert.deepEqual(productionStages(job),['angle','refine']);
  const exported=buildCameraStage(job.workflowSnapshot,job.cameraWorkflowSnapshot,job,'angle',{source:'saved-original.png'});assert.equal(nodes(exported,'TextEncodeQwenImageEditPlus')[0].inputs.prompt,encoder.inputs.prompt);
});

test('換角度後沿用原設定拍新版本仍執行保存的鏡位，後續重拍也保留角度流程',async t=>{
  const f=await fixture(t,{camera:true}),angle={horizontalAngle:0,verticalAngle:1,zoom:3.2};
  const turned=await f.request('/jobs/original/angle',{requestId:'angle-before-custom',angle,deleteSourceOnComplete:false});await f.request('/jobs/submit',{ids:[turned.data.job.id]});await f.finish();await f.finish();
  const customized=await f.request(`/jobs/${turned.data.job.id}/custom`,{requestId:'preserve-angle-custom',customization:{preserveOriginal:true}});assert.equal(customized.status,201);
  const job=customized.data.job;assert.equal(job.cameraEnabled,true,'沿用原設定不可跳過目前照片的換角度階段');assert.deepEqual(productionStages(job),['base','angle','refine']);assert.deepEqual(job.camera.angle,angle);assert.equal(job.prompt,f.source().prompt);
  await f.request('/jobs/submit',{ids:[job.id]});await f.finish();const encoder=nodes(f.submitted.at(-1).prompt,'TextEncodeQwenImageEditPlus')[0];assert.deepEqual(encoder._meta.cameraAngle,angle);assert.equal(encoder.inputs.prompt,withSingleSubjectPrompt(cameraPrompt(angle)));await f.finish();await f.finish();
  const remake=await f.request('/jobs/remake',{requestId:'remake-custom-angle',ids:[job.id]});assert.equal(remake.status,201);assert.deepEqual(productionStages(remake.data.jobs[0]),['base','angle','refine']);assert.deepEqual(remake.data.jobs[0].camera.angle,angle);
});

test('舊自訂版本曾漏跑鏡位，直接重拍會從保存的來源恢復角度流程且保留舊紀錄',async t=>{
  const f=await fixture(t,{camera:true}),angle={horizontalAngle:90,verticalAngle:-16,zoom:3.2};
  const turned=await f.request('/jobs/original/angle',{requestId:'legacy-angle-source',angle,deleteSourceOnComplete:false});await f.request('/jobs/submit',{ids:[turned.data.job.id]});await f.finish();await f.finish();
  const source=f.store.read().jobs.find(row=>row.id===turned.data.job.id),legacy={...structuredClone(f.source()),id:'legacy-custom-version',jobKind:'photo-edit',rootJobId:'original',sourceJobId:source.id,remakeVersion:2,cameraEnabled:false,camera:structuredClone(source.camera),photoCustomization:{preserveOriginal:true},photoSource:{jobId:source.id,stage:'source',imageIndex:0,image:source.images[0]},images:[{filename:'legacy.png',subfolder:'PhotoCreate',type:'output'}]};
  fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','legacy.png'),PNG);f.store.mutate(state=>state.jobs.unshift(legacy));
  const created=await f.request('/jobs/remake',{requestId:'remake-legacy-custom',ids:[legacy.id]});assert.equal(created.status,201);const job=created.data.jobs[0];assert.equal(job.cameraEnabled,true,'重拍舊自訂版本也必須恢復漏掉的換角度流程');assert.deepEqual(productionStages(job),['base','angle','refine']);assert.deepEqual(job.camera.angle,angle);assert.deepEqual(f.store.read().jobs.find(row=>row.id===legacy.id),legacy);
  await f.request('/jobs/submit',{ids:[job.id]});await f.finish();const encoder=nodes(f.submitted.at(-1).prompt,'TextEncodeQwenImageEditPlus')[0];assert.deepEqual(encoder._meta.cameraAngle,angle);assert.equal(encoder.inputs.prompt,withSingleSubjectPrompt(cameraPrompt(angle)));
});
