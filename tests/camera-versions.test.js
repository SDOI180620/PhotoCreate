import {adminFetch as fetch} from './auth-client.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {cameraPrompt,CAMERA_HORIZONTAL,CAMERA_VERTICAL} from '../shared/camera.js';
import {cameraVersion,cameraWorkflowVersion,cameraBundlePath} from '../shared/camera-version.js';
import {buildCameraStage,buildCameraPipeline,validateCameraWorkflow} from '../server/camera-workflow.js';
import {testComfyConnection} from '../server/connection.js';
import {convertWorkflow} from '../server/workflow.js';
import {createApp} from '../server/index.js';
import {createStore} from '../server/store.js';
import {createEnvironmentManager,BUNDLE_DIR} from '../server/environment.js';
import {environmentFixture} from './environment-fixtures.js';
import {CAMERA_TEMPLATE,CAMERA_21_TEMPLATE,CAMERA_21_LORA} from './camera-fixtures.js';
import {TEMPLATE,DRAFT,fixtureState} from './fixtures.js';

const nodes=(graph,type)=>Object.values(graph).filter(node=>node.class_type===type);
const shot=angle=>({id:'camera-version-test',jobKind:'angle-edit',cameraMode:'multiangle',cameraEnabled:true,camera:{angle},seed:42,angleSteps:20,refineDenoise:0.2,resolution:1536,steps:40});

test('2.1 grammar keeps all previous angles, exact coordinates and five framing levels',()=>{
  for(const [horizontalAngle] of CAMERA_HORIZONTAL) for(const [verticalAngle] of [...CAMERA_VERTICAL,[-90,'historical']]) for(const zoom of [0,1,3,5,7,9,10]) {
    const prompt=cameraPrompt({horizontalAngle,verticalAngle,zoom},'2.1');
    assert.match(prompt,/^<mva> /);assert.doesNotMatch(prompt,/<sks>/);
    assert.match(prompt,new RegExp(`Requested camera azimuth: ${horizontalAngle} degrees`));
    assert.match(prompt,new RegExp(`Requested camera elevation: ${verticalAngle} degrees`));
    if(verticalAngle<0) {assert.match(prompt,/negative elevation overrides/);assert.match(prompt.split('\n')[0],/eye-level shot/);}
  }
  const angle={horizontalAngle:90,verticalAngle:-70};
  const prompts=[1,3,5,7,9].map(zoom=>cameraPrompt({...angle,zoom},'2.1'));
  assert.equal(new Set(prompts).size,5);assert.match(prompts[4],/fills all four edges/);
  assert.doesNotMatch(prompts[4],/far below the subject|below eye level/);
  assert.match(cameraPrompt({...angle,zoom:5}),/^<sks>/);
  assert.match(cameraPrompt({horizontalAngle:330,verticalAngle:30,zoom:5},'2.1'),/^<mva> front-left view, elevated shot/);
  assert.throws(()=>cameraVersion('wrong'),/版本無效/);
});

test('2.1 angle stage routes one reference through its encoder and LoRA; refinement stays independent',()=>{
  const original=structuredClone(CAMERA_21_TEMPLATE);
  const job=shot({horizontalAngle:133,verticalAngle:-90,zoom:10});
  validateCameraWorkflow(original);
  assert.equal(cameraWorkflowVersion(original),'2.1');assert.equal(cameraWorkflowVersion(CAMERA_TEMPLATE),'2511');
  const graph=buildCameraStage(TEMPLATE,original,job,'angle',{source:'selected.png'});
  assert.equal(nodes(graph,'KSampler').length,1);assert.equal(nodes(graph,'LoadImage').length,1);
  assert.equal(nodes(graph,'LoadImage')[0].inputs.image,'selected.png');
  assert.equal(nodes(graph,'TextEncodeQwenImageEditPlus').length,0);
  const encoder=nodes(graph,'TextEncodeQwenImage21')[0],sampler=nodes(graph,'KSampler')[0];
  assert.match(encoder.inputs.prompt,/^<mva> back-right quarter view, eye-level shot close-up/);
  assert.match(encoder.inputs.prompt,/Worm's-eye view/);assert.match(encoder.inputs.negative_prompt,/distant subject/);
  assert.deepEqual(encoder._meta.cameraAngle,job.camera.angle);assert.equal(encoder._meta.cameraVersion,'2.1');
  assert.deepEqual(encoder.inputs['images.image_1'],['source',0]);
  assert.equal(sampler.inputs.cfg,1);assert.equal(sampler.inputs.steps,20);
  assert.equal(nodes(graph,'LoraLoaderModelOnly')[0].inputs.lora_name,CAMERA_21_LORA);
  const refine=buildCameraStage(TEMPLATE,original,job,'refine',{source:'angle.png'});
  assert.equal(nodes(refine,'LoraLoaderModelOnly').length,0);assert.equal(nodes(refine,'KSampler').length,1);
  assert.equal(nodes(refine,'KSampler')[0].inputs.denoise,0.2);
  assert.deepEqual(refine.refine_size.inputs.image,['source',0]);
  assert.equal(nodes(buildCameraPipeline(TEMPLATE,original,job,{source:'selected.png'}),'KSampler').length,2);
  assert.deepEqual(original,CAMERA_21_TEMPLATE);
  const invalid=structuredClone(CAMERA_TEMPLATE);invalid['13'].inputs.positive=['1',0];
  assert.throws(()=>validateCameraWorkflow(invalid),/正面提詞編碼器/);
});

test('shipped 2.1 workflow converts with real widget ordering and shares the browser prompt source',()=>{
  const fixture=environmentFixture();
  try {
    const ui=JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR,cameraBundlePath('2.1')),'utf8'));
    const graph=convertWorkflow(ui,fixture.schemas,{validate:validateCameraWorkflow});
    assert.equal(cameraWorkflowVersion(graph),'2.1');
    assert.equal(nodes(graph,'KSampler')[0].inputs.steps,40);
    assert.equal(nodes(graph,'KSampler')[0].inputs.cfg,1);
    assert.equal(nodes(graph,'TextEncodeQwenImage21')[0].inputs.resolution,1024);
    assert.equal(nodes(graph,'QwenMultiangleCameraNode')[0].inputs.model_version,'2.1');
    const stage=buildCameraStage(TEMPLATE,graph,shot({horizontalAngle:45,verticalAngle:-60,zoom:9}),'angle',{source:'original.png'});
    assert.match(nodes(stage,'TextEncodeQwenImage21')[0].inputs.prompt,/Requested camera azimuth: 45 degrees/);
    assert.equal(fs.readFileSync(new URL('../shared/camera-21.js',import.meta.url),'utf8'),fs.readFileSync(path.join(BUNDLE_DIR,'custom_nodes/ComfyUI-qwenmultiangle/js/camera-21.js'),'utf8'));
  } finally {fs.rmSync(fixture.temporary,{recursive:true,force:true});}
});

test('2.1 connection checks its LoRA and rejects a mismatched saved workflow',async()=>{
  const fixture=environmentFixture(),comfyJson=async(endpoint,options,url)=>(await fixture.fetchImpl(url+endpoint,options)).json();
  try {
    const candidate={comfyUrl:'http://fixture.test:8188',cameraVersion:'2.1'};
    assert.equal((await testComfyConnection(candidate,comfyJson,fixture)).ready,true);
    fixture.controls.missingAngles21=true;
    const missing=await testComfyConnection(candidate,comfyJson,fixture);
    assert.equal(missing.ready,false);assert.ok(missing.stages.flatMap(row=>row.errors).some(error=>error.includes('lora_name')));
    fixture.controls.missingAngles21=false;
    const saved=path.join(fixture.root,'user/default/workflows/old-camera.json');fs.mkdirSync(path.dirname(saved),{recursive:true});fs.writeFileSync(saved,JSON.stringify(fixture.cameraUi));
    const mismatch=await testComfyConnection({...candidate,cameraWorkflowPath:'old-camera.json'},comfyJson,fixture);
    assert.equal(mismatch.ready,false);assert.match(mismatch.error,/相符的拍攝版本/);
  } finally {fs.rmSync(fixture.temporary,{recursive:true,force:true});}
});

test('camera version switching is checked, persistent and leaves existing job snapshots intact',async t=>{
  const fixture=environmentFixture(),instance=createApp({...fixture,environmentOptions:fixture}),{app,store}=instance;
  store.mutate(state=>{Object.assign(state,fixtureState());state.workflow=TEMPLATE;state.cameraWorkflow=CAMERA_TEMPLATE;});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{instance.environment.close();server.close();store.close();fs.rmSync(fixture.temporary,{recursive:true,force:true});});
  const request=async(route,body,method='PUT')=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api${route}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const draft={...DRAFT,cameraMode:'multiangle'};
  const old=await request('/jobs',draft,'POST');assert.equal(old.status,201);assert.equal(old.data[0].cameraVersion,'2511');
  const before=store.read();fixture.controls.missingAngles21=true;
  const rejected=await request('/camera-workflow/version',{cameraVersion:'2.1'});
  assert.equal(rejected.status,400);assert.deepEqual(store.read().settings,before.settings);assert.deepEqual(store.read().cameraWorkflow,before.cameraWorkflow);
  fixture.controls.missingAngles21=false;
  assert.equal((await request('/camera-workflow/version',{cameraVersion:'2.1'})).status,200);
  assert.equal(store.read().settings.cameraVersion,'2.1');assert.equal(cameraWorkflowVersion(store.read().cameraWorkflow),'2.1');
  const reopened=createStore(fixture.dataDir);
  try {assert.equal(reopened.read().settings.cameraVersion,'2.1');assert.equal(cameraWorkflowVersion(reopened.read().cameraWorkflow),'2.1');} finally {reopened.close();}
  assert.deepEqual(store.read().workflow,TEMPLATE);
  const prior=store.read().jobs.find(job=>job.id===old.data[0].id);assert.equal(cameraWorkflowVersion(prior.cameraWorkflowSnapshot),'2511');
  const next=await request('/jobs',draft,'POST');assert.equal(next.data[0].cameraVersion,'2.1');
  assert.equal(cameraWorkflowVersion(store.read().jobs.find(job=>job.id===next.data[0].id).cameraWorkflowSnapshot),'2.1');
  assert.equal((await request('/camera-workflow/version',{cameraVersion:'wrong'})).status,400);
  assert.equal((await request('/camera-workflow/version',{})).status,400);
  store.mutate(state=>{state.jobs[0].status='running';});
  assert.equal((await request('/camera-workflow/version',{cameraVersion:'2511'})).status,409);
  store.mutate(state=>{state.jobs[0].status='draft';});
  assert.equal((await request('/camera-workflow/version',{cameraVersion:'2511'})).status,200);
  assert.equal(cameraWorkflowVersion(store.read().jobs.find(job=>job.id===next.data[0].id).cameraWorkflowSnapshot),'2.1');
  assert.ok(fixture.controls.requests.every(row=>row.method==='GET'));
});

test('2.1 installation needs its own LoRA and shared 2.1 models, without requiring 2511 models',()=>{
  const fixture=environmentFixture(),manager=createEnvironmentManager({...fixture,bundleDir:BUNDLE_DIR,manifest:JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR,'manifest.json'),'utf8'))});
  try {
    const current=manager.plan(fixture.root,{cameraVersion:'2.1'}),legacy=manager.plan(fixture.root,{cameraVersion:'2511'});
    const models=current.resources.filter(row=>row.kind==='model');
    assert.equal(models.length,4);assert.equal(legacy.resources.filter(row=>row.kind==='model').length,7);
    assert.ok(models.some(row=>row.target==='models/loras/'+CAMERA_21_LORA));
    assert.ok(models.every(row=>!row.target.includes('2511') && !row.target.includes('qwen_2.5')));
    assert.equal(current.resources.filter(row=>row.kind==='workflow').length,3);
  } finally {manager.close();fs.rmSync(fixture.temporary,{recursive:true,force:true});}
});
