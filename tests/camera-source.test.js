import {adminFetch as fetch} from './auth-client.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveCameraSource,resolveSelectedPhotoSource} from '../shared/camera-source.js';
import {buildRemakePlans} from '../shared/remakes.js';
import {buildShotPlans} from '../shared/domain.js';
import {createApp} from '../server/index.js';
import {DRAFT,TEMPLATE,fixtureState,PNG} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';

const image = filename => ({filename,subfolder:'PhotoCreate/original-test',type:'output'});
const original = () => ({...buildShotPlans(fixtureState(),{...DRAFT,cameraMode:'multiangle'})[0],status:'completed',createdAt:new Date().toISOString(),images:[image('final.png')],comfyUrl:'http://original-comfy:8188',stageResults:{base:{completed:true,images:[image('original-base.png')],comfyUrl:'http://original-comfy:8188'}}});

test('不同角度拍攝使用所選版本與圖片索引，不追溯原圖或偷偷換成另一張',() => {
  const root=original(),edit={...root,id:'selected-version',jobKind:'angle-edit',rootJobId:root.id,sourceJobId:root.id,images:[image('version-2.png'),image('version-2-second.png')],comfyUrl:'http://selected-comfy:8188'};
  const state={jobs:[edit,root]};
  const selected=resolveSelectedPhotoSource(state,edit,1);
  assert.equal(selected.image.filename,'version-2-second.png');assert.equal(selected.imageIndex,1);
  assert.equal(selected.jobId,edit.id);assert.equal(selected.comfyUrl,edit.comfyUrl);
  assert.equal(resolveSelectedPhotoSource(state,root).image.filename,'final.png');
  assert.throws(()=>resolveSelectedPhotoSource(state,edit,2),/選取/);
  assert.throws(()=>resolveSelectedPhotoSource(state,{...edit,outputsDeletedAt:new Date().toISOString()}),/選取/);
  assert.throws(()=>resolveSelectedPhotoSource(state,edit,-1),/索引/);
  selected.image.filename='changed.png';assert.equal(edit.images[1].filename,'version-2-second.png');
});

test('換角度追溯首次原圖；原成果刪除後仍可取原圖，正常重製使用自己的新原圖',() => {
  const root = original();root.images = [];root.outputsDeletedAt = new Date().toISOString();
  const first = {...root,id:'first-edit',jobKind:'angle-edit',rootJobId:root.id,sourceJobId:root.id,images:[image('crop-first.png')],stageResults:{},sourceImage:image('final.png'),sourceInput:'PhotoCreate/cropped-input.png',sourceInputComfyUrl:'http://crop-comfy:8188'};
  const second = {...first,id:'second-edit',sourceJobId:first.id,images:[image('crop-second.png')],sourceImage:first.images[0]};
  const state = {jobs:[second,first,root]};
  assert.equal(resolveCameraSource(state,second).image.filename,'original-base.png');
  assert.equal(resolveCameraSource(state,second).comfyUrl,root.comfyUrl);
  const fresh = {...root,id:'fresh-remake',rootJobId:root.id,sourceJobId:root.id,stageResults:{base:{completed:true,images:[image('fresh-base.png')]}}};
  state.jobs.push(fresh);assert.equal(resolveCameraSource(state,fresh).image.filename,'fresh-base.png');
});

test('固定原圖快照可在原拍攝紀錄移除後重用；角度重製不繼承舊裁切輸入',() => {
  const root = original(),source = resolveCameraSource({jobs:[root]},root);
  const edit = {...root,id:'anchored-edit',jobKind:'angle-edit',stageResults:{},rootJobId:root.id,sourceJobId:root.id,cameraSource:source,sourceInput:'PhotoCreate/old-crop.png',sourceInputComfyUrl:'http://crop-comfy:8188',images:[image('cropped.png')]};
  const state = {jobs:[edit]};
  assert.equal(resolveCameraSource(state,edit).image.filename,'original-base.png');
  const [retry] = buildRemakePlans(state,[edit.id]);
  assert.equal(retry.sourceImage.filename,'original-base.png');assert.equal(retry.sourceComfyUrl,root.comfyUrl);
  assert.equal(retry.sourceInput,undefined);assert.equal(retry.sourceJobId,edit.id);
  assert.deepEqual(retry.cameraSource,source);
});

test('舊版首次轉角輸入副本保留原圖；無法追溯時拒絕拿裁切成果代替',() => {
  const root = {...original(),stageResults:{},images:[],outputsDeletedAt:new Date().toISOString()};
  const edit = {...root,id:'legacy-edit',jobKind:'angle-edit',rootJobId:root.id,sourceJobId:root.id,sourceInput:'PhotoCreate/original-copy.png',sourceInputComfyUrl:'http://prior-comfy:8188',images:[image('cropped.png')]};
  const source = resolveCameraSource({jobs:[edit,root]},edit);
  assert.equal(source.image.filename,'original-copy.png');assert.equal(source.image.type,'input');
  assert.equal(source.comfyUrl,'http://prior-comfy:8188');
  const lost = {...edit,id:'lost-edit',sourceJobId:'removed-earlier-edit',sourceImage:image('cropped-again.png')};
  assert.throws(() => resolveCameraSource({jobs:[lost]},lost),/首次生成的原圖/);
  assert.throws(() => resolveCameraSource({jobs:[edit]},edit,-1),/索引/);
});

test('舊版同圖工作流未保存原圖時，不拿轉角後的成果冒充原圖',() => {
  const combined = {...original(),stageResults:{},apiPrompt:{angle:{class_type:'QwenMultiangleCameraNode',inputs:{}}}};
  const edit = {...combined,id:'old-combined-edit',jobKind:'angle-edit',rootJobId:combined.id,sourceJobId:combined.id,sourceImage:combined.images[0],sourceInput:'PhotoCreate/final-copy.png',sourceInputComfyUrl:combined.comfyUrl};
  assert.throws(() => resolveCameraSource({jobs:[combined]},combined),/未保存轉角前的原圖/);
  assert.throws(() => resolveCameraSource({jobs:[combined,edit]},edit),/未保存轉角前的原圖/);
  const plain = {...combined,apiPrompt:TEMPLATE};
  assert.equal(resolveCameraSource({jobs:[plain]},plain).image.filename,'final.png');
});

test('相機預覽與上傳使用選取的成果，舊的三階段成果也可直接拍攝不同角度',async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-camera-original-'));
  const views = [],uploads = [],prompts = new Map(),pending = new Set(),history = new Map();
  const fetchImpl = async (url,options = {}) => {
    const parsed = new URL(url);
    if(parsed.pathname === '/view') {views.push(parsed);return new Response(PNG,{headers:{'Content-Type':'image/png'}});}
    if(parsed.pathname === '/upload/image') {uploads.push(options.body.get('image').name);return Response.json({name:uploads.at(-1),subfolder:'PhotoCreate'});}
    if(parsed.pathname === '/prompt') {const body = JSON.parse(options.body);prompts.set(body.prompt_id,body.prompt);if(Object.values(body.prompt).some(node=>node.class_type==='KSampler')) pending.add(body.prompt_id);else history.set(body.prompt_id,{status:{status_str:'success'},outputs:{}});return Response.json({prompt_id:body.prompt_id});}
    if(parsed.pathname === '/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id => [0,id])});
    if(parsed.pathname.startsWith('/history/')) {const id=parsed.pathname.split('/').at(-1);return Response.json(history.has(id) ? {[id]:history.get(id)} : {});}
    return Response.json({});
  };
  const {app,store} = createApp({dataDir,fetchImpl}),root = original();
  store.mutate(state => Object.assign(state,{workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE,jobs:[root]}));
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
  t.after(() => {server.close();store.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (route,body) => {const response = await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const preview = await fetch(`${base}/jobs/${root.id}/angle-source?index=0`);
  assert.equal(preview.status,200);assert.deepEqual(Buffer.from(await preview.arrayBuffer()),PNG);
  assert.equal(views.at(-1).searchParams.get('filename'),'final.png');
  assert.equal(views.at(-1).origin,root.comfyUrl);
  const options = {requestId:'original-angle-1',angle:{horizontalAngle:133,verticalAngle:31,zoom:10},deleteSourceOnComplete:true};
  const first = await post(`/jobs/${root.id}/angle`,options);assert.equal(first.status,201);
  assert.equal(first.data.job.sourceImage.filename,'final.png');assert.equal(first.data.job.sourceJobId,root.id);
  assert.equal((await post('/jobs/submit',{ids:[first.data.job.id]})).status,200);
  assert.equal(views.at(-1).searchParams.get('filename'),'final.png');assert.equal(uploads.length,1);
  pending.clear();store.mutate(state => {const job = state.jobs.find(row => row.id === first.data.job.id);job.status = 'completed';job.images = [image('first-cropped-final.png')];state.jobs.find(row => row.id === root.id).images = [];state.jobs.find(row => row.id === root.id).outputsDeletedAt = new Date().toISOString();});
  const second = await post(`/jobs/${first.data.job.id}/angle`,{...options,requestId:'original-angle-2'});assert.equal(second.status,201);
  assert.equal(second.data.job.sourceImage.filename,'first-cropped-final.png');assert.equal(second.data.job.sourceJobId,first.data.job.id);
  store.mutate(state => {state.jobs = state.jobs.filter(job => job.id !== root.id && job.id !== first.data.job.id);});
  const anchoredPreview = await fetch(`${base}/jobs/${second.data.job.id}/angle-source`);
  assert.equal(anchoredPreview.status,400,'A pending angle has no selected output to preview yet');
  assert.equal((await post('/jobs/submit',{ids:[second.data.job.id]})).status,200);
  assert.equal(views.at(-1).searchParams.get('filename'),'first-cropped-final.png');
  assert.equal((await fetch(`${base}/jobs/${second.data.job.id}/angle-source?index=-1`)).status,400);
  const legacy = {...root,id:'legacy-combined',stageResults:{},apiPrompt:{camera:{class_type:'QwenMultiangleCameraNode',inputs:{}}}};
  store.mutate(state => state.jobs.push(legacy));
  assert.equal((await fetch(`${base}/jobs/${legacy.id}/angle-source`)).status,200);
  const rejected = await post(`/jobs/${legacy.id}/angle`,{...options,requestId:'legacy-missing-original'});
  assert.equal(rejected.status,201);assert.equal(rejected.data.job.sourceImage.filename,'final.png');
  assert.equal(store.read().jobs.length,3);
});
