import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {relatedPresetPhotos,removePreviewDirectory} from '../server/preset-previews.js';
import {CATEGORIES,buildShotPlans} from '../shared/domain.js';
import {DRAFT,fixtureState,PNG} from './fixtures.js';
import {adminFetch,login} from './auth-client.js';
import {previewFixture,until} from './preset-preview-fixture.js';

const bound=category=>fixtureState().presets.find(row=>row.category===category);
const journal=f=>JSON.parse(fs.readFileSync(path.join(f.dataDir,'preset-previews.json'),'utf8'));
async function fixture(t,options) {const f=await previewFixture(options);t.after(()=>f.close());return f;}
const historyJob=(id,extras={})=>({...buildShotPlans(fixtureState(),{...DRAFT,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1})[0],id,status:'completed',createdAt:'2026-10-11T00:00:00Z',images:[{filename:`${id}.png`,subfolder:'PhotoCreate',type:'output'}],...extras});

test('關聯成果依保存的提詞 ID 查找，隨機最多五張，包含版本與每張輸出，排除未完成、已刪除與顧客照片',()=>{
  const state=fixtureState(),id='pose-standing';
  state.presets.find(row=>row.id===id).name='已改名';
  state.jobs=Array.from({length:7},(_,i)=>historyJob(`photo-${i}`));
  state.jobs[0].images.push({filename:'second.png',subfolder:'PhotoCreate',type:'output'});
  state.jobs[1].remakeVersion=2;
  state.jobs.push(historyJob('private',{visitorId:'customer'}),historyJob('deleted',{outputsDeletedAt:'today'}),historyJob('pending',{status:'queued'}),historyJob('unrelated',{pose:{id:'other',prompt:bound('pose').prompt}}));
  const sample=relatedPresetPhotos(state,id,{sample:true});
  assert.equal(sample.total,8);assert.equal(sample.items.length,5);assert.equal(new Set(sample.items.map(row=>row.id)).size,5);
  const all=relatedPresetPhotos(state,id,{limit:4}),rest=relatedPresetPhotos(state,id,{offset:4,limit:4});
  assert.equal(all.items.length,4);assert.equal(rest.items.length,4);assert.equal(new Set([...all.items,...rest.items].map(row=>row.id)).size,8);
  assert.ok([...all.items,...rest.items].some(row=>row.version===2));
  state.jobs=state.jobs.slice(0,1);assert.equal(relatedPresetPhotos(state,id,{sample:true}).items.length,2);
  state.jobs=[];assert.deepEqual(relatedPresetPhotos(state,id,{sample:true}).items,[]);
  assert.throws(()=>relatedPresetPhotos(state,id,{limit:0}),/分頁/);
});

for(const category of Object.keys(CATEGORIES).filter(category=>category!=='video')) test(`臨時試拍固定 ${category} 的未保存內容，只生成原圖，獨立於正式照片與草稿`,async t=>{
  const f=await fixture(t),preset=bound(category),id=await f.open(preset.id),before=f.store.read();
  const edited={...preset,name:'未保存的試拍設定',prompt:'UNSAVED PRESET TEST',...(category==='camera' ? {angle:{horizontalAngle:135,verticalAngle:-70,zoom:8}} : {})};
  const requestId=randomUUID();
  const result=await f.shoot(id,edited,requestId);assert.equal(result.status,202);
  const repeated=await f.shoot(id,edited,requestId);assert.equal(repeated.status,202);assert.equal(repeated.data.jobs.length,1);
  await until(()=>f.submitted.length===1);
  const trial=(await f.request(`/preset-previews/${id}`)).data.jobs[0];
  assert.ok(trial.presets.some(row=>row.id===preset.id && row.name===edited.name));assert.equal(trial.presets.length,9);
  const prompt=f.submitted[0].prompt,encoder=Object.values(prompt).find(node=>node.class_type==='TextEncodeQwenImage21');
  assert.equal(encoder.inputs.resolution,1024);assert.equal(prompt['7'].inputs.steps,30);
  assert.ok(encoder.inputs.prompt.includes(edited.prompt));
  if(category!=='camera') assert.equal(encoder.inputs.prompt.includes('Camera and composition:'),false,'Other trials retain the original camera');
  assert.ok(Object.values(prompt).filter(node=>node.class_type==='SaveImage').every(node=>node.inputs.filename_prefix.startsWith(`PhotoCreate/_previews/${id}/`)));
  assert.deepEqual(f.store.read().jobs,before.jobs);assert.deepEqual(f.store.read().batches,before.batches);assert.deepEqual(f.store.read().draft,before.draft);assert.deepEqual(f.store.read().presets,before.presets);
  const blocked=await f.shoot(id,edited);assert.equal(blocked.status,409);
  f.complete(f.submitted[0].id);await f.presetPreviews.sync();await f.presetPreviews.sync();
  const completed=(await f.request(`/preset-previews/${id}`)).data.jobs[0];
  assert.equal(completed.status,'completed');assert.equal(completed.images.length,1);
  assert.equal(f.submitted.length,1,'Even with a camera workflow installed, completion must not queue angle or refine');
  assert.ok(Object.values(prompt).filter(node=>node.class_type==='SaveImage').every(node=>node.inputs.filename_prefix.endsWith('/base')));
  assert.equal(f.calls.includes('/free'),false);
});

for(const [aspectRatio,width,height] of [['9:16',864,1536],['16:9',1536,864],['1:1',1024,1024],['reference',undefined,undefined]]) test(`試拍獨立選擇 ${aspectRatio}，輸出尺寸送入 ComfyUI 並保留各次結果比例`,async t=>{
  const f=await fixture(t),preset=bound('pose'),id=await f.open(preset.id),requestId=randomUUID(),before=f.store.read();
  const result=await f.request(`/preset-previews/${id}/shots`,{preset,requestId,aspectRatio});assert.equal(result.status,202);
  const job=result.data.jobs[0];assert.equal(job.aspectRatio,aspectRatio);assert.equal(job.outputWidth,width);assert.equal(job.outputHeight,height);
  const repeated=await f.request(`/preset-previews/${id}/shots`,{preset,requestId,aspectRatio:'1:1'});
  assert.equal(repeated.data.jobs.length,1);assert.equal(repeated.data.jobs[0].aspectRatio,aspectRatio,'A repeated request keeps the original selection');
  await until(()=>f.submitted.length===1);
  const graph=f.submitted[0].prompt,size=Object.entries(graph).find(([,node])=>node.class_type==='LatentUpscale');
  if(width) {
    assert.equal(size[1].inputs.width*2,width);assert.equal(size[1].inputs.height*2,height);
    assert.equal(size[1].inputs.crop,'disabled');assert.deepEqual(graph['7'].inputs.latent_image,[size[0],0]);
  } else {assert.equal(size,undefined);assert.deepEqual(graph['7'].inputs.latent_image,['12',2]);}
  f.complete(f.submitted[0].id);await f.presetPreviews.sync();await f.presetPreviews.sync();
  const completed=(await f.request(`/preset-previews/${id}`)).data.jobs[0];
  assert.equal(completed.status,'completed');assert.equal(completed.aspectRatio,aspectRatio);assert.equal(f.submitted.length,1);
  assert.deepEqual(f.store.read().draft,before.draft);assert.deepEqual(f.store.read().jobs,before.jobs);assert.deepEqual(f.store.read().presets,before.presets);
});

test('試拍拒絕無效比例，未指定比例的舊請求仍沿用工作檯',async t=>{
  const f=await fixture(t),preset=bound('pose'),id=await f.open(preset.id);
  for(const aspectRatio of ['3:4','',null,123,{}]) {
    const result=await f.request(`/preset-previews/${id}/shots`,{preset,requestId:randomUUID(),aspectRatio});
    assert.equal(result.status,400);assert.match(result.data.error,/試拍比例/);
  }
  assert.equal(f.submitted.length,0);assert.equal((await f.request(`/preset-previews/${id}`)).data.jobs.length,0);
  const result=await f.shoot(id,preset);assert.equal(result.status,202);assert.equal(result.data.jobs[0].aspectRatio,'9:16');
});

test('原圖完成即可讀取，關閉視窗清除臨時原圖，但保留正式照片與參考圖',async t=>{
  const f=await fixture(t),preset=bound('pose'),id=await f.open(preset.id);
  const foreign=path.join(f.outputDir,'PhotoCreate','regular.png');fs.mkdirSync(path.dirname(foreign),{recursive:true});fs.writeFileSync(foreign,PNG);
  await f.shoot(id,preset);await until(()=>f.submitted.length===1);
  f.complete(f.submitted[0].id);await f.presetPreviews.sync();await f.presetPreviews.sync();assert.equal(f.submitted.length,1);
  const status=(await f.request(`/preset-previews/${id}`)).data,job=status.jobs[0];
  assert.equal(job.status,'completed');assert.equal(job.images.length,1);
  const response=await adminFetch(f.base+job.images[0].src);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),PNG);
  const directory=path.join(f.outputDir,'PhotoCreate','_previews',id);assert.equal(fs.readdirSync(path.join(directory,job.id)).length,1);
  assert.equal((await f.request(`/jobs/${job.id}/image/0`)).status,404);
  assert.equal((await f.request(`/presets/${preset.id}/photos`)).data.total,0);
  assert.equal((await f.request(`/preset-previews/${id}`,{},'DELETE')).status,200);
  assert.equal(fs.existsSync(directory),false);assert.equal(fs.existsSync(foreign),true);assert.equal(fs.existsSync(path.join(f.dataDir,'uploads','character.png')),true);
  assert.equal((await f.request(`/preset-previews/${id}`)).status,410);
  assert.equal((await adminFetch(f.base+job.images[0].src)).status,410);
});

test('關閉只取消自己的單一任務，接受回應遺失也能取消，並保留其他 ComfyUI 任務',async t=>{
  const f=await fixture(t),foreign=randomUUID();f.pending.add(foreign);f.control.loseReply=true;
  const preset=bound('pose'),id=await f.open(preset.id);await f.shoot(id,preset);
  await until(async()=>((await f.request(`/preset-previews/${id}`)).data.jobs[0]?.status)==='uncertain');
  const own=f.submitted[0].id;assert.ok(journal(f).sessions.find(row=>row.id===id).promptIds.includes(own));
  await f.request(`/preset-previews/${id}`,{},'DELETE');await until(()=>f.cancelled.includes(own));
  assert.equal(f.pending.has(foreign),true);assert.equal(f.cancelled.includes(foreign),false);assert.equal(f.calls.includes('/interrupt'),false);
});

test('ComfyUI 回傳錯誤任務 ID 時保留原始識別碼與待確認狀態，服務仍能關閉及取消試拍',async t=>{
  const f=await fixture(t),preset=bound('pose'),id=await f.open(preset.id);f.control.invalidReply=true;
  await f.shoot(id,preset);await until(async()=>((await f.request(`/preset-previews/${id}`)).data.jobs[0]?.status)==='uncertain');
  const own=f.submitted[0].id;assert.deepEqual(journal(f).sessions.find(row=>row.id===id).promptIds,[own]);
  await f.request(`/preset-previews/${id}`,{},'DELETE');await until(()=>f.cancelled.includes(own));assert.equal(f.pending.has(own),false);
});

test('上傳途中關閉並回收 session，不會在上傳回來後再提交試拍',async t=>{
  let timestamp=Date.now();const f=await fixture(t,{presetPreviewOptions:{clock:()=>timestamp,cleanupGrace:0}});
  let release;f.control.uploadGate=new Promise(resolve=>{release=resolve;});
  const preset=bound('pose'),id=await f.open(preset.id);await f.shoot(id,preset);await until(()=>f.calls.includes('/upload/image'));
  await f.request(`/preset-previews/${id}`,{},'DELETE');timestamp+=1000;await f.presetPreviews.tick();
  release();await new Promise(resolve=>setTimeout(resolve,30));await f.presetPreviews.tick();
  assert.equal(f.submitted.length,0);assert.equal((await f.request(`/preset-previews/${id}`)).status,410);
});

test('提交途中關閉保留預先寫入的 prompt ID，回應較晚到達也取消，不進入下一階段',async t=>{
  let timestamp=Date.now();const f=await fixture(t,{presetPreviewOptions:{clock:()=>timestamp,cleanupGrace:0}});
  let release;f.control.promptGate=new Promise(resolve=>{release=resolve;});
  const preset=bound('pose'),id=await f.open(preset.id);await f.shoot(id,preset);await until(()=>f.submitted.length===1);
  const promptId=f.submitted[0].id;assert.ok(journal(f).sessions[0].promptIds.includes(promptId));
  await f.request(`/preset-previews/${id}`,{},'DELETE');timestamp+=1000;await f.presetPreviews.tick();
  assert.ok(journal(f).sessions.some(row=>row.id===id),'Keep journal until in-flight submission returns');
  release();await until(()=>f.cancelled.includes(promptId));await new Promise(resolve=>setTimeout(resolve,30));await f.presetPreviews.tick();
  assert.equal(f.pending.has(promptId),false);assert.equal(f.submitted.length,1);assert.equal((await f.request(`/preset-previews/${id}`)).status,410);
});

test('取消暫時失敗會重試清理，關閉後才寫入的圖片也會清除',async t=>{
  const f=await fixture(t),preset=bound('pose'),id=await f.open(preset.id);await f.shoot(id,preset);await until(()=>f.submitted.length===1);
  f.control.cancelUnavailable=true;await f.request(`/preset-previews/${id}`,{},'DELETE');
  await until(()=>f.cancelled.length>0);assert.ok(journal(f).sessions.some(row=>row.id===id));
  const directory=path.join(f.outputDir,'PhotoCreate','_previews',id);f.complete(f.submitted[0].id);assert.equal(fs.existsSync(directory),true);
  f.control.cancelUnavailable=false;await f.presetPreviews.tick();assert.equal(fs.existsSync(directory),false);
});

test('服務重開清理崩潰前的試拍紀錄、取消佇列，不恢復生成，也不碰正式照片',async t=>{
  const id=randomUUID(),promptId=randomUUID(),foreign=randomUUID();
  const f=await fixture(t,{beforeStart:({dataDir,outputDir,pending})=>{
    const directory=path.join(outputDir,'PhotoCreate','_previews',id);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'late.png'),PNG);
    fs.writeFileSync(path.join(outputDir,'PhotoCreate','keep.png'),PNG);
    fs.writeFileSync(path.join(dataDir,'preset-previews.json'),JSON.stringify({version:1,sessions:[{id,presetId:'pose-standing',createdAt:Date.now()-10000,promptIds:[promptId],outputDir,comfyUrl:'http://127.0.0.1:8188'}]}));
    pending.add(promptId);pending.add(foreign);
  }});
  await until(()=>f.cancelled.includes(promptId));await until(()=>!fs.existsSync(path.join(f.outputDir,'PhotoCreate','_previews',id)));
  assert.equal(f.pending.has(promptId),false);assert.equal(f.pending.has(foreign),true);assert.equal(f.submitted.length,0);assert.equal(f.store.read().jobs.length,0);
  assert.equal(fs.existsSync(path.join(f.outputDir,'PhotoCreate','keep.png')),true);assert.equal((await f.request(`/preset-previews/${id}`)).status,410);
});

test('關閉先於開啟與閒置逾時，都不能繼續使用原 session',async t=>{
  let timestamp=Date.now();const f=await fixture(t,{presetPreviewOptions:{clock:()=>timestamp,sessionTtl:5000}}),id=randomUUID();
  await f.request(`/preset-previews/${id}`,{},'DELETE');assert.equal((await f.request(`/preset-previews/${id}`,{presetId:'pose-standing'},'PUT')).status,410);
  const opened=await f.open('pose-standing');timestamp+=6000;await f.presetPreviews.tick();
  assert.equal((await f.request(`/preset-previews/${opened}`)).status,410);
});

test('重開服務時 ComfyUI 離線仍立即清除本機臨時圖，恢復連線後再取消殘留任務',async t=>{
  const id=randomUUID(),promptId=randomUUID();
  const f=await fixture(t,{beforeStart:({dataDir,outputDir,pending,control})=>{
    control.cancelUnavailable=true;pending.add(promptId);
    const directory=path.join(outputDir,'PhotoCreate','_previews',id);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'old.png'),PNG);
    fs.writeFileSync(path.join(dataDir,'preset-previews.json'),JSON.stringify({version:1,sessions:[{id,createdAt:Date.now()-10000,promptIds:[promptId],outputDir,comfyUrl:'http://127.0.0.1:8188'}]}));
  }});
  assert.equal(fs.existsSync(path.join(f.outputDir,'PhotoCreate','_previews',id)),false);assert.equal(f.pending.has(promptId),true);
  assert.ok(journal(f).sessions.some(row=>row.id===id));f.control.cancelUnavailable=false;await f.presetPreviews.tick();assert.equal(f.pending.has(promptId),false);
});

test('缺少本機輸出目錄或使用遠端 ComfyUI 會阻止臨時試拍；攝影提詞也只產原圖，不需相機工作流',async t=>{
  const f=await fixture(t,{camera:false}),preset=bound('pose'),id=await f.open(preset.id);
  assert.equal((await f.shoot(id,preset)).status,202);await until(()=>f.submitted.length===1);
  f.complete(f.submitted[0].id);await f.presetPreviews.sync();assert.equal((await f.request(`/preset-previews/${id}`)).data.jobs[0].status,'completed');
  const camera=bound('camera'),cameraId=await f.open(camera.id);assert.equal((await f.shoot(cameraId,camera)).status,202);
  await until(()=>f.submitted.length===2);
  const encoder=Object.values(f.submitted[1].prompt).find(node=>node.class_type==='TextEncodeQwenImage21');assert.ok(encoder.inputs.prompt.includes(camera.prompt));
  f.complete(f.submitted[1].id);await f.presetPreviews.sync();await f.presetPreviews.sync();
  const trial=(await f.request(`/preset-previews/${cameraId}`)).data.jobs[0];assert.equal(trial.status,'completed');assert.ok(trial.presets.some(row=>row.id===camera.id));assert.equal(f.submitted.length,2);
  f.store.mutate(state=>{state.settings.comfyUrl='http://example.test:8188';});
  const other=await f.open(preset.id);assert.match((await f.shoot(other,preset)).data.error,/本機/);
  f.store.mutate(state=>{state.settings.comfyUrl='http://127.0.0.1:8188';});
  const missing=path.join(f.dataDir,'moved-output');
  assert.equal(path.dirname(path.resolve(f.outputDir)),path.resolve(f.dataDir));assert.equal(path.dirname(path.resolve(missing)),path.resolve(f.dataDir));
  fs.renameSync(f.outputDir,missing);
  assert.match((await f.shoot(other,preset)).data.error,/本機/);
});

test('管理員 API 保護所有關聯與臨時成果路由，不洩漏顧客角色、服裝、照片',async t=>{
  const f=await fixture(t),id=await f.open('pose-standing');
  f.store.mutate(state=>{
    state.characters.unshift({...state.characters[0],id:'private-character',name:'PRIVATE CHARACTER',visitorId:'customer'});
    state.garments.unshift({...state.garments[0],id:'private-garment',name:'PRIVATE GARMENT',visitorId:'customer'});
    state.jobs.push(historyJob('private-photo',{visitorId:'customer'}));
  });
  const result=await f.shoot(id,bound('pose'));assert.equal(result.status,202);
  assert.equal(result.data.jobs[0].character,'角色');assert.notEqual(result.data.jobs[0].garment,'PRIVATE GARMENT');
  assert.equal((await f.request('/presets/pose-standing/photos')).data.total,0);
  await f.request('/accounts',{username:'preview-customer',password:'customer-secret',name:'Customer'});
  const customer=await login(f.base,'preview-customer','customer-secret');
  for(const [route,method] of [[`/presets/pose-standing/photos`,'GET'],[`/preset-previews/${id}`,'GET'],[`/preset-previews/${id}`,'PUT'],[`/preset-previews/${id}/shots`,'POST'],[`/preset-previews/${id}`,'DELETE'],[`/preset-previews/${id}/jobs/${randomUUID()}/image/0`,'GET']]) {
    const response=await fetch(f.base+'/api'+route,{method,headers:{cookie:customer.cookie,'content-type':'application/json'},...(method==='GET' ? {} : {body:'{}'})});assert.equal(response.status,403);
  }
});

test('清理拒絕路徑穿越與 junction，不刪除連結指向的照片',async t=>{
  const f=await fixture(t),id=randomUUID(),target=path.join(f.outputDir,'PhotoCreate','_previews',id),outside=path.join(f.dataDir,'keep');
  fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'original.png'),PNG);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.symlinkSync(outside,target,'junction');
  assert.throws(()=>removePreviewDirectory(f.outputDir,id),/連結/);assert.equal(fs.existsSync(path.join(outside,'original.png')),true);
  assert.throws(()=>removePreviewDirectory(f.outputDir,'../keep'),/識別碼/);
  // Unlink the checked junction itself before the fixture's recursive teardown.
  assert.equal(fs.lstatSync(target).isSymbolicLink(),true);fs.unlinkSync(target);
});
