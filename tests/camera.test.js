import {adminFetch as fetch} from './auth-client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAMERA_ANGLE, CAMERA_MIN_VERTICAL, CAMERA_VERTICAL, cameraControlAngle, cameraPreset, cameraPrompt, normalizeCameraAngle, REFINE_PROMPT } from '../shared/camera.js';
import { buildShotPlans } from '../shared/domain.js';
import { buildRemakePlans } from '../shared/remakes.js';
import { buildCameraPipeline,buildCameraStage } from '../server/camera-workflow.js';
import { createApp } from '../server/index.js';
import { DRAFT, TEMPLATE, PNG, fixtureState } from './fixtures.js';
import { CAMERA_TEMPLATE } from './camera-fixtures.js';

const newShot = () => buildShotPlans(fixtureState(),{...DRAFT,cameraMode:'multiangle',angleSteps:20,refineDenoise:0.2,aspectRatio:'16:9'})[0];
const types = (graph,type) => Object.values(graph).filter(node => node.class_type === type);

test('新鏡頭控制下限 -70，載入舊 -90 鏡位時同步調整控制值，不改歷史數據',()=>{
  const historical={horizontalAngle:90,verticalAngle:-90,zoom:8};
  const current=cameraControlAngle(historical);
  assert.deepEqual(current,{horizontalAngle:90,verticalAngle:-70,zoom:8});
  assert.deepEqual(normalizeCameraAngle(historical),historical);
  assert.equal(historical.verticalAngle,-90);
  assert.equal(CAMERA_MIN_VERTICAL,-70);
  assert.ok(CAMERA_VERTICAL.every(([value])=>value>=CAMERA_MIN_VERTICAL));
  const shot={...newShot(),jobKind:'angle-edit',camera:{angle:current}};
  const graph=buildCameraStage(TEMPLATE,CAMERA_TEMPLATE,shot,'angle',{source:'original.png'});
  const encoder=Object.values(graph).find(node=>node._meta?.cameraAngle);
  assert.deepEqual(encoder._meta.cameraAngle,current);
  assert.match(encoder.inputs.prompt,/camera elevation: -70 degrees/);
  assert.deepEqual(cameraControlAngle(DEFAULT_CAMERA_ANGLE),DEFAULT_CAMERA_ANGLE);
});

test('Zoom 分五個級距，同組採用相同取景，預設為正常取景 5',()=>{
  assert.equal(DEFAULT_CAMERA_ANGLE.zoom,5);
  const prompts=[];
  for(const [first,second] of [[1,2],[3,4],[5,6],[7,8],[9,10]]) {
    const angle={horizontalAngle:90,verticalAngle:-30,zoom:first};
    const prompt=cameraPrompt(angle);
    assert.equal(prompt,cameraPrompt({...angle,zoom:second}),`Zoom ${first}/${second} must share a framing level`);
    assert.match(prompt,/right side view low-angle shot/);
    prompts.push(prompt);
  }
  assert.equal(new Set(prompts).size,5,'All five framing levels must differ');
  assert.match(prompts[3],/Half-body framing/);
  assert.match(prompts[4],/Extreme close-up/);
  assert.match(prompts[4],/center of the reference/);
  assert.doesNotMatch(prompts[4],/tightly frame the face|0 front, 90 right side, 180 back/);
});

test('局部大特寫的仰角以局部取景中心為目標，距離限制進入負面編碼並保留自訂內容',()=>{
  const template=structuredClone(CAMERA_TEMPLATE);
  const sampler=types(template,'KSampler')[0];
  template[sampler.inputs.negative[0]].inputs.prompt='custom quality failure';
  for(const zoom of [8,9,10]) {
    const angle={horizontalAngle:90,verticalAngle:-70,zoom};
    const shot={...newShot(),jobKind:'angle-edit',camera:{angle}};
    const graph=buildCameraStage(TEMPLATE,template,shot,'angle',{source:'original.png'});
    const cameraSampler=types(graph,'KSampler')[0];
    const positive=graph[cameraSampler.inputs.positive[0]].inputs.prompt;
    const negative=graph[cameraSampler.inputs.negative[0]].inputs.prompt;
    assert.match(negative,/custom quality failure/);
    if(zoom>=9) {
      assert.doesNotMatch(positive,/eye level|far below the subject/);
      assert.match(positive,/below the level of the same small local detail/);
      assert.match(positive,/fills all four edges/);
      assert.match(negative,/wide shot, full-body framing, distant subject/);
    } else {
      assert.match(positive,/below eye level/);
      assert.doesNotMatch(negative,/distant subject/);
    }
  }
  assert.equal(template[sampler.inputs.negative[0]].inputs.prompt,'custom quality failure');
});

test('微調相機角度保留實際生成條件，不能與零角度完全相同',()=>{
  const conditioning=angle=>{
    const shot={...newShot(),jobKind:'angle-edit',camera:{angle}};
    const graph=buildCameraPipeline(TEMPLATE,CAMERA_TEMPLATE,shot,{source:'original.png'});
    return Object.values(graph).find(node=>node._meta?.cameraAngle).inputs.prompt;
  };
  for(const angle of [{horizontalAngle:0,verticalAngle:7,zoom:10},{horizontalAngle:0,verticalAngle:-9,zoom:10},{horizontalAngle:12,verticalAngle:0,zoom:0}]) {
    assert.notEqual(conditioning(angle),conditioning({horizontalAngle:0,verticalAngle:0,zoom:angle.zoom}),JSON.stringify(angle));
  }
});

test('高 Zoom 保留模型生成的完整鏡位，避免中央裁切把人物與仰拍線索切掉',()=>{
  for(const zoom of [8,8.5,9,10]) {
    const shot={...newShot(),jobKind:'angle-edit',camera:{angle:{horizontalAngle:10,verticalAngle:-75,zoom}}};
    const angle=buildCameraStage(TEMPLATE,CAMERA_TEMPLATE,shot,'angle',{source:'original.png'});
    assert.equal(types(angle,'ImageCrop').length,0,`Zoom ${zoom} must not crop the model's camera view`);
    assert.equal(angle[angle.angle_save.inputs.images[0]].class_type,'VAEDecode');
    const pipeline=buildCameraPipeline(TEMPLATE,CAMERA_TEMPLATE,shot,{source:'original.png'});
    assert.deepEqual(pipeline.refine_size.inputs.image,angle.angle_save.inputs.images);
    assert.equal(types(pipeline,'ImageCrop').length,0);
    const refine=buildCameraStage(TEMPLATE,CAMERA_TEMPLATE,shot,'refine',{source:'full-angle.png'});
    assert.equal(types(refine,'ImageCrop').length,0);
    assert.deepEqual(refine.refine_size.inputs.image,['source',0]);
    assert.deepEqual(refine.refine_latent.inputs.pixels,['refine_size',0]);
    assert.deepEqual(refine.refine_7.inputs.latent_image,['refine_latent',0]);
  }
});

test('加強鏡位保留 -90/-60、Zoom 9/10，命名與角度分開保存',() => {
  for(const verticalAngle of [-90,-60]) for(const zoom of [9,10]) {
    const angle = {horizontalAngle:133,verticalAngle,zoom};
    assert.deepEqual(normalizeCameraAngle(angle),angle);
    assert.match(cameraPrompt(angle),/back-right quarter view low-angle shot close-up/);
    assert.match(cameraPrompt(angle),verticalAngle === -90 ? /vertically straight up/ : /steeply upward/);
    assert.match(cameraPrompt(angle),/Extreme close-up/);
  }
  assert.throws(() => normalizeCameraAngle({horizontalAngle:0,verticalAngle:-91,zoom:5}));
  assert.throws(() => normalizeCameraAngle({horizontalAngle:0,verticalAngle:61,zoom:5}));
  assert.throws(() => normalizeCameraAngle({horizontalAngle:0,verticalAngle:0,zoom:11}));
  const preset = cameraPreset({id:'camera-low-side',name:'低角度側面',prompt:'legacy lens prose'});
  assert.equal(preset.name,'低角度側面');assert.equal(preset.prompt,'legacy lens prose');
  assert.deepEqual(preset.angle,{horizontalAngle:90,verticalAngle:-40,zoom:5});
  assert.ok(cameraPreset({id:'camera-mirror',name:'鏡中反射'}).mappingNote);
});

test('新拍攝先產原圖、再換角度與修復；高清只有一張圖及固定保留內容指令',() => {
  const shot = newShot();
  assert.ok(!shot.prompt.includes('Camera and composition:'));
  const graph = buildCameraPipeline(TEMPLATE,CAMERA_TEMPLATE,shot,{character:'person.png',garment:'outfit.png'});
  assert.equal(types(graph,'KSampler').length,3);assert.equal(types(graph,'SaveImage').length,1);
  assert.equal(types(graph,'LoadImage').length,2);
  const encoders = types(graph,'TextEncodeQwenImage21');assert.equal(encoders.length,2);
  const refine = encoders.find(node => node.inputs.prompt === REFINE_PROMPT);
  assert.ok(refine);assert.deepEqual(Object.keys(refine.inputs).filter(key => key.startsWith('images.')),['images.image_1']);
  assert.deepEqual(refine.inputs['images.image_1'],['refine_size',0]);
  assert.equal(graph.refine_size.inputs.width,2048);assert.equal(graph.refine_size.inputs.height,1152);
  assert.equal(graph.refine_size.inputs.crop,'disabled');
  assert.equal(graph.refine_7.inputs.denoise,0.2);assert.deepEqual(graph.refine_7.inputs.latent_image,['refine_latent',0]);
  assert.equal(graph.refine_latent.class_type,'VAEEncode');
  assert.equal(graph.angle_13.inputs.steps,20);assert.equal(graph['7'].inputs.steps,40);
  assert.equal(graph.refine_7.inputs.steps,20);
  for(const node of Object.values(graph)) for(const value of Object.values(node.inputs)) if(Array.isArray(value)) assert.ok(graph[String(value[0])]);
});

test('已完成圖換角度只用成果，重製保留模型快照且不疊加新階段',() => {
  const source = {...newShot(),status:'completed',images:[{filename:'old.png'}],batchId:'batch',workflowSnapshot:TEMPLATE,cameraWorkflowSnapshot:CAMERA_TEMPLATE};
  source.apiPrompt = buildCameraPipeline(TEMPLATE,CAMERA_TEMPLATE,source,{character:'person.png',garment:'outfit.png'});
  const [remake] = buildRemakePlans({jobs:[source]},[source.id],{requestId:'stable'});
  assert.deepEqual(remake.workflowSnapshot,TEMPLATE);assert.deepEqual(remake.cameraWorkflowSnapshot,CAMERA_TEMPLATE);
  assert.equal(types(buildCameraPipeline(remake.workflowSnapshot,remake.cameraWorkflowSnapshot,remake,{character:'person.png',garment:'outfit.png'}),'KSampler').length,3);
  const edit = {...remake,jobKind:'angle-edit',camera:{name:'測試角度',angle:{horizontalAngle:315,verticalAngle:-90,zoom:10}}};
  const graph = buildCameraPipeline(TEMPLATE,CAMERA_TEMPLATE,edit,{source:'source-result.png'});
  assert.equal(types(graph,'KSampler').length,2);assert.equal(types(graph,'LoadImage').length,1);
  assert.equal(types(graph,'LoadImage')[0].inputs.image,'source-result.png');
  assert.equal(types(graph,'TextEncodeQwenImage21')[0].inputs.prompt,REFINE_PROMPT);
  assert.deepEqual(graph.angle_10._meta.cameraAngle,edit.camera.angle);
  assert.match(graph.angle_10.inputs.prompt,/Extreme close-up/);
});

for(const releaseGpuMemory of [false,true]) test(`換角度可重試、不重複排隊、完成後才刪除舊圖（釋放記憶體：${releaseGpuMemory}）`,async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-camera-'));
  const outputDir = path.join(dataDir,'output'),photoDir = path.join(outputDir,'PhotoCreate');fs.mkdirSync(photoDir,{recursive:true});
  fs.writeFileSync(path.join(photoDir,'old.png'),PNG);
  const submitted = new Map(),finishedPrompts = new Set(),views = [];let complete = false,uploads = 0;
  const mock = async (url,options = {}) => {
    const pathname = new URL(url).pathname;
    if(pathname === '/view') {views.push(new URL(url));return new Response(PNG,{headers:{'content-type':'image/png'}});}
    if(pathname === '/upload/image') {uploads++;return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});}
    if(pathname === '/prompt') {const body = JSON.parse(options.body);submitted.set(body.prompt_id,body.prompt);return Response.json({prompt_id:body.prompt_id});}
    if(pathname === '/queue') return Response.json({queue_running:[],queue_pending:complete ? [] : [...submitted.keys()].filter(id => !finishedPrompts.has(id)).map(id => [0,id])});
    if(pathname.startsWith('/history/')) {
      if(!complete) return Response.json({});
      const id = pathname.split('/').at(-1);finishedPrompts.add(id);fs.writeFileSync(path.join(photoDir,'new.png'),PNG);
      return Response.json({[id]:{status:{status_str:'success'},outputs:{refine_9:{images:[{filename:'new.png',subfolder:'PhotoCreate',type:'output'}]}}}});
    }
    return Response.json({});
  };
  const {app,store} = createApp({dataDir,fetchImpl:mock,comfyOutputDir:outputDir});
  const source = {...newShot(),status:'completed',createdAt:new Date().toISOString(),batchId:'batch',images:[{filename:'old.png',subfolder:'PhotoCreate',type:'output'}],apiPrompt:TEMPLATE};
  store.mutate(state => {state.workflow = TEMPLATE;state.cameraWorkflow = CAMERA_TEMPLATE;state.jobs = [source];state.batches = [{id:'batch',name:'test',createdAt:source.createdAt}];});
  store.mutate(state=>{state.settings.releaseGpuMemory=releaseGpuMemory;});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
  t.after(() => {server.close();store.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route,body) => {const response = await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const options = {requestId:'angle-request',name:'正下方極近細節',angle:{horizontalAngle:90,verticalAngle:-90,zoom:10},imageIndex:0,deleteSourceOnComplete:true};
  const first = await request(`/jobs/${source.id}/angle`,options);assert.equal(first.status,201);
  const repeated = await request(`/jobs/${source.id}/angle`,options);assert.equal(repeated.data.job.id,first.data.job.id);
  assert.equal((await request(`/jobs/${source.id}/angle`,{...options,angle:{...options.angle,zoom:9}})).status,409);
  assert.equal((await request(`/jobs/${source.id}/angle`,{...options,requestId:'another'})).status,400);
  assert.ok(fs.existsSync(path.join(photoDir,'old.png')));
  const result = await request('/jobs/submit',{ids:[first.data.job.id]});assert.ok(result.data.results[0].ok);assert.equal(uploads,1);
  assert.equal(types([...submitted.values()][0],'KSampler').length,releaseGpuMemory ? 0 : 1);
  assert.equal((await request('/jobs/submit',{ids:[first.data.job.id]})).status,400);assert.equal(submitted.size,1);
  await request('/jobs/sync',{});assert.ok(fs.existsSync(path.join(photoDir,'old.png')));
  complete = true;for(let step = 0;step < 3;step++) await request('/jobs/sync',{});
  assert.ok(!fs.existsSync(path.join(photoDir,'old.png')));assert.ok(fs.existsSync(path.join(photoDir,'new.png')));
  assert.equal(store.read().jobs.find(row => row.id === source.id).images.length,0);
  const saved = store.read().jobs.find(row => row.id === first.data.job.id);assert.ok(saved.sourceInput);assert.equal(saved.status,'completed');
  assert.deepEqual(saved.camera.angle,options.angle);
  // After old output cleanup, rehosting a retry still reads its saved input.
  const next = await request('/jobs/remake',{requestId:'rehost-camera',ids:[saved.id],deleteSourceOnComplete:false});
  assert.equal(next.status,201);
  store.mutate(state => {state.settings.comfyUrl = 'http://another-comfy:8188';});
  complete = false;
  const retry = await request('/jobs/submit',{ids:[next.data.jobs[0].id]});
  assert.ok(retry.data.results[0].ok);assert.equal(uploads,2);
  assert.equal(views.at(-1).searchParams.get('type'),'input');
  assert.equal(views.at(-1).searchParams.get('filename'),`angle-source-${saved.id}.png`);
  assert.equal(views.at(-1).origin,'http://127.0.0.1:8188');
});
