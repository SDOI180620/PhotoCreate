import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {createStore} from '../server/store.js';
import {buildShotPlans,normalizePresetImport} from '../shared/domain.js';
import {buildCameraStage} from '../server/camera-workflow.js';
import {upgradeCameraMapping,inferLegacyCameraAngle,REFINE_PROMPT} from '../shared/camera.js';
import {productionPreview,productionProgress,productionStatus} from '../shared/production.js';
import {DRAFT,TEMPLATE,fixtureState,PNG} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';

const types = (graph,type) => Object.values(graph).filter(node => node.class_type === type);
const plan = () => buildShotPlans(fixtureState(),{...DRAFT,cameraMode:'multiangle',aspectRatio:'16:9'})[0];

test('每階段只載入自己的模型，高清保留單一圖像 latent 與內容指令',() => {
  const job = plan();
  for(const stage of ['base','angle','refine']) {
    const graph = buildCameraStage(TEMPLATE,CAMERA_TEMPLATE,job,stage,stage === 'base' ? {character:'person.png',garment:'outfit.png'} : {source:'saved.png [output]'});
    assert.equal(types(graph,'KSampler').length,1);assert.equal(types(graph,'SaveImage').length,1);
    assert.equal(types(graph,'UNETLoader').length,1);
    assert.equal(types(graph,'TextEncodeQwenImage21').length,stage === 'angle' ? 0 : 1);
    assert.equal(types(graph,'QwenMultiangleCameraNode').length,stage === 'angle' ? 1 : 0);
    assert.equal(types(graph,'LoadImage').length,stage === 'base' ? 2 : 1);
    if(stage === 'refine') {
      assert.equal(types(graph,'TextEncodeQwenImage21')[0].inputs.prompt,REFINE_PROMPT);
      assert.equal(graph.refine_7.inputs.denoise,0.2);assert.deepEqual(graph.refine_7.inputs.latent_image,['refine_latent',0]);
    }
    for(const node of Object.values(graph)) for(const value of Object.values(node.inputs)) if(Array.isArray(value)) assert.ok(graph[String(value[0])]);
  }
});

async function fixture(t,count = 3) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-stages-'));
  const outputDir = path.join(dataDir,'output');fs.mkdirSync(outputDir);
  const pending = new Set(),history = new Map(),submitted = [],events = [],cancelled = [],views = [];
  let loseReply = false;
  const mock = async (url,options = {}) => {
    const route = new URL(url).pathname;
    if(route === '/system_stats') return Response.json({system:{ram_free:20e9},devices:[{name:'Test GPU',vram_total:32e9,vram_free:events.at(-1) === 'checkpoint' ? 29e9 : 2e9}]});
    if(route === '/view') {views.push(new URL(url));return new Response(PNG,{headers:{'content-type':'image/png'}});}
    if(route === '/upload/image') return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
    if(route === '/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id => [0,id])});
    if(route === '/free') {events.push('free');assert.deepEqual(JSON.parse(options.body),{unload_models:true,free_memory:true});return new Response(null,{status:200});}
    if(route === '/prompt') {
      const {prompt,prompt_id} = JSON.parse(options.body);
      const stage = !types(prompt,'KSampler').length ? 'checkpoint' : types(prompt,'QwenMultiangleCameraNode').length ? 'angle' : prompt.refine_size ? 'refine' : 'base';
      pending.add(prompt_id);submitted.push({id:prompt_id,stage,prompt});events.push(stage);
      if(loseReply) {loseReply = false;throw new Error('Lost reply after accepting the prompt');}
      return Response.json({prompt_id});
    }
    if(route.startsWith('/history/')) {const id = route.split('/').at(-1);return Response.json(history.has(id) ? {[id]:history.get(id)} : {});}
    if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) {const id = route.split('/')[3];cancelled.push(id);return Response.json({cancelled:pending.delete(id)});}
    return Response.json({});
  };
  const f = createApp({dataDir,fetchImpl:mock,comfyOutputDir:outputDir});
  f.store.mutate(state => Object.assign(state,fixtureState(),{workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE}));
  for(const asset of [...f.store.read().characters,...f.store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  const server = f.app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
  const request = async (route,body = {},method = 'POST') => {const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`,{method,headers:{'content-type':'application/json'},...(method === 'GET' ? {} : {body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
  const imageRequest = route => fetch(`http://127.0.0.1:${server.address().port}/api${route}`);
  const jobs = (await request('/jobs',{...DRAFT,cameraMode:'multiangle',garmentIds:['garment-a'],poseIds:['pose-standing'],copies:count})).data;
  const complete = id => {
    const entry = submitted.find(row => row.id === id);assert.ok(entry);
    pending.delete(id);
    let outputs = {};
    const save = types(entry.prompt,'SaveImage')[0];
    if(save) {
      const file = `${save.inputs.filename_prefix}_00001_.png`,absolute = path.join(outputDir,file);
      fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,PNG);
      outputs = {save:{images:[{filename:path.posix.basename(file),subfolder:path.posix.dirname(file),type:'output'}]}};
    }
    history.set(id,{status:{status_str:'success'},outputs});
  };
  t.after(() => {server.close();f.store.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {...f,dataDir,request,imageRequest,views,jobs,pending,history,submitted,events,cancelled,complete,loseNext:() => {loseReply = true;}};
}

test('整組原圖完成才轉視角，整組角度完成才高清；兩次釋放不打斷其他佇列',async t => {
  const f = await fixture(t),ids = f.jobs.map(job => job.id);
  await f.request('/jobs/submit',{ids});assert.deepEqual(f.events,['base','base','base']);
  f.submitted.slice(0,2).forEach(row => f.complete(row.id));await f.stageRunner.tick();
  assert.deepEqual(f.events,['base','base','base']);
  assert.equal(productionProgress(f.store.read().jobs).completed,2);
  assert.ok(f.store.read().jobs.every(job => !job.images.length));
  const firstPreview = f.store.read().jobs.find(job => job.stageResults?.base?.completed);
  assert.equal(productionPreview(firstPreview).stage,'base');
  assert.equal(productionPreview(f.store.read().jobs.find(job => !job.stageResults?.base)),null);
  const baseResponse = await f.imageRequest(`/jobs/${firstPreview.id}/image/0?stage=base`);
  assert.equal(baseResponse.status,200);assert.deepEqual(Buffer.from(await baseResponse.arrayBuffer()),PNG);
  assert.match(f.views.at(-1).searchParams.get('filename'),/^base_/);
  assert.equal((await f.imageRequest(`/jobs/${firstPreview.id}/image/0`)).status,404);
  assert.equal((await f.imageRequest(`/jobs/${firstPreview.id}/image/0?stage=angle`)).status,404);
  assert.equal((await f.imageRequest(`/jobs/${firstPreview.id}/image/0?stage=refine`)).status,400);
  f.complete(f.submitted[2].id);f.pending.add('foreign');await f.stageRunner.tick();
  assert.equal(f.events.includes('free'),false);f.pending.delete('foreign');
  await f.stageRunner.tick();assert.deepEqual(f.events,['base','base','base','free','checkpoint']);
  f.complete(f.submitted.at(-1).id);await f.stageRunner.tick();
  assert.deepEqual(f.events.slice(-3),['angle','angle','angle']);
  const cameras = f.submitted.filter(row => row.stage === 'angle');
  f.complete(cameras[0].id);await f.stageRunner.tick();assert.equal(f.events.includes('refine'),false);
  assert.equal(productionPreview(f.store.read().jobs.find(job => job.stageResults?.angle)).stage,'angle');
  cameras.slice(1).forEach(row => f.complete(row.id));await f.stageRunner.tick();
  assert.deepEqual(f.events.slice(-2),['free','checkpoint']);
  f.complete(f.submitted.at(-1).id);await f.stageRunner.tick();
  assert.deepEqual(f.events.slice(-3),['refine','refine','refine']);
  f.submitted.filter(row => row.stage === 'refine').forEach(row => f.complete(row.id));await f.stageRunner.tick();
  assert.ok(f.store.read().jobs.every(job => job.status === 'completed' && job.images.length === 1 && Object.keys(job.stageResults).length === 3));
  assert.equal(f.events.filter(event => event === 'free').length,2);
  const releases = f.store.read().pipelineRuns[0].modelReleases;
  assert.equal(releases.length,2);
  assert.deepEqual(releases.map(row => row.toStage),['angle','refine']);
  assert.ok(releases.every(row => row.requestedAt && row.checkpointPromptId && row.checkpointConfirmedAt && row.memoryAfter.devices[0].vramFree > row.memoryBefore.devices[0].vramFree));
  assert.ok(f.store.read().jobs.every(job => job.images[0].subfolder.includes('_stages') === false));
  assert.equal(productionPreview(f.store.read().jobs[0]).stage,null);
});

test('暫停或失敗仍可看中間圖，讀取原階段主機；刪除成果後不再回退到中間圖',async t => {
  const f = await fixture(t,1),id = f.jobs[0].id;
  const saved = {completed:true,images:[{filename:'base.png',subfolder:`PhotoCreate/_stages/${id}`,type:'output'}],comfyUrl:'http://prior-host:8188'};
  f.store.mutate(state => Object.assign(state.jobs[0],{executionMode:'staged',pipelineStage:'angle',status:'failed',stageResults:{base:saved},comfyUrl:'http://current-host:8188'}));
  assert.equal(productionPreview(f.store.read().jobs[0]).stage,'base');
  assert.equal((await f.imageRequest(`/jobs/${id}/image/0?stage=base`)).status,200);
  assert.equal(f.views.at(-1).hostname,'prior-host');
  f.store.mutate(state => {state.jobs[0].status = 'stopped';});
  assert.equal(productionPreview(f.store.read().jobs[0]).stage,'base');
  f.store.mutate(state => Object.assign(state.jobs[0],{status:'completed',images:saved.images,outputsDeletedAt:new Date().toISOString()}));
  assert.equal(productionPreview(f.store.read().jobs[0]),null);
  for(const query of ['', '?stage=base','?stage=angle']) assert.equal((await f.imageRequest(`/jobs/${id}/image/0${query}`)).status,404);
});

test('原圖後暫停與重開資料庫會保留中間圖，重新生成只接續角度與高清',async t => {
  const f = await fixture(t,1),id = f.jobs[0].id;
  await f.request('/jobs/submit',{ids:[id]});f.complete(f.submitted[0].id);
  f.pending.add('foreign');await f.stageRunner.tick();
  await f.request('/jobs/stop',{ids:[id]});assert.equal(f.store.read().jobs[0].status,'stopped');
  assert.equal(productionStatus(f.store.read().jobs[0]),'已停止 · 產原圖完成');
  assert.equal(f.cancelled.length,0);
  const reopened = createStore(f.dataDir);assert.equal(reopened.read().jobs[0].stageResults.base.completed,true);reopened.close();
  f.pending.delete('foreign');await f.request('/jobs/submit',{ids:[id]});
  assert.deepEqual(f.events,['base','free','checkpoint']);
  f.complete(f.submitted.at(-1).id);await f.stageRunner.tick();
  assert.equal(f.submitted.at(-1).stage,'angle');assert.equal(f.events.filter(event => event === 'base').length,1);
  assert.match(types(f.submitted.at(-1).prompt,'LoadImage')[0].inputs.image,/base_00001_\.png \[output\]$/);
});

test('階段回應遺失不得重送，確認完成後才能釋放與接續',async t => {
  const f = await fixture(t,1),id = f.jobs[0].id;f.loseNext();
  await f.request('/jobs/submit',{ids:[id]});assert.equal(f.store.read().jobs[0].status,'uncertain');
  assert.equal((await f.request('/jobs/submit',{ids:[id]})).status,400);
  await f.stageRunner.tick();assert.equal(f.submitted.length,1);
  f.complete(f.submitted[0].id);await f.stageRunner.tick();
  assert.deepEqual(f.events,['base','free','checkpoint']);assert.equal(f.store.read().jobs[0].stageResults.base.completed,true);
});

test('肩後與背面分開設計，局部特寫有俯仰偏轉，升級保留手改角度與既有拍攝',() => {
  const old = {id:'camera-shoulder-closeup',name:'回眸特寫',category:'camera',prompt:'saved prose',tags:[]};
  old.angle = inferLegacyCameraAngle(old).angle;
  const improved = upgradeCameraMapping(old);assert.deepEqual(improved.angle,{horizontalAngle:133,verticalAngle:31,zoom:10});
  assert.equal(improved.id,old.id);assert.equal(improved.prompt,old.prompt);
  assert.equal(upgradeCameraMapping({id:'custom-back',name:'背後'}).angle.horizontalAngle,180);
  for(const id of ['camera-chest-closeup','camera-neckline','camera-side-breast','camera-macro-chest']) {
    const preset = upgradeCameraMapping({id,name:'局部特寫'});assert.notEqual(preset.angle.horizontalAngle,0);assert.ok(preset.angle.verticalAngle >= 28);
  }
  const manual = {horizontalAngle:209,verticalAngle:-72,zoom:10};
  assert.deepEqual(upgradeCameraMapping({...old,angle:manual}).angle,manual);
  const imported = normalizePresetImport([{...old,angle:manual}])[0];assert.equal(imported.mappingSource,'manual');assert.deepEqual(imported.angle,manual);
  assert.deepEqual(upgradeCameraMapping(improved),improved);
});
