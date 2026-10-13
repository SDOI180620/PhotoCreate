import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.js';
import {createStore} from '../server/store.js';
import {adminFetch as fetch,login} from './auth-client.js';
import {fixtureState,TEMPLATE,PNG,DRAFT} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';
import {buildCameraStage} from '../server/camera-workflow.js';
import {cameraPrompt,REFINE_PROMPT,REFINE_NEGATIVE} from '../shared/camera.js';
import {SINGLE_SUBJECT_NEGATIVE,withSingleSubjectPrompt} from '../shared/subject.js';
import {DEFAULT_DRAFT} from '../shared/draft.js';
import {buildShotPlans,getOutputSize} from '../shared/domain.js';
import {createCustomerPrompts} from '../server/customer-prompts.js';
import {PHOTO_CHANGE_FIELDS} from '../shared/photo-customization.js';

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-visitors-'));
  const outputDir=path.join(dataDir,'comfy-output');fs.mkdirSync(path.join(outputDir,'PhotoCreate','test-output'),{recursive:true});
  const prompts=[],pending=new Set(),history=new Map(),views=[],cancellations=[];
  let cancelError=false;
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname;
    if(route==='/view') {views.push(new URL(url));return new Response(PNG,{headers:{'content-type':'image/png'}});}
    if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) {
      if(cancelError) return Response.json({error:'Unavailable'},{status:503});
      const id=route.split('/')[3];cancellations.push(id);return Response.json({cancelled:pending.delete(id)});
    }
    if(route==='/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id=>[0,id])});
    if(route==='/system_stats') return Response.json({devices:[]});
    if(route==='/upload/image') return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
    if(route==='/prompt') {const data=JSON.parse(options.body);prompts.push(data);pending.add(data.prompt_id);return Response.json({prompt_id:data.prompt_id});}
    if(route.startsWith('/history/')) {const id=route.split('/').at(-1);return Response.json(history.has(id) ? {[id]:history.get(id)} : {});}
    return Response.json({});
  };
  const instance=createApp({dataDir,fetchImpl,comfyOutputDir:outputDir,publicUrl:'http://203.0.113.10:8764'});
  instance.store.mutate(state=>Object.assign(state,fixtureState(),{workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE}));
  for(const asset of [...instance.store.read().characters,...instance.store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const visitor=()=>{
    let cookie='',session,sessionHeaders;
    const username='visitor-'+randomUUID().slice(0,12);
    return {get cookie(){return cookie;},get sessionHeaders(){return sessionHeaders;},request:async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
      session ||= (async()=>{await instance.authentication.createCustomer({username,password:'visitor-pass'});const loggedIn=await login(base,username,'visitor-pass');cookie=loggedIn.cookie;sessionHeaders=loggedIn.headers;})();
      await session;
      const form=body instanceof FormData;
      const response=await fetch(base+'/api/studio'+route,{method,headers:{...(cookie ? {Cookie:cookie} : {}),...(form ? {} : {'content-type':'application/json'})},...(body===undefined ? {} : {body:form ? body : JSON.stringify(body)})});
      if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
      const type=response.headers.get('content-type') || '';
      return {status:response.status,headers:response.headers,data:type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())};
    }};
  };
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));instance.store.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const completePending=()=>{
    for(const id of pending) {
      const {prompt}=prompts.find(row=>row.prompt_id===id),outputs={};
      for(const [nodeId,node] of Object.entries(prompt)) if(node.class_type==='SaveImage') outputs[nodeId]={images:[{filename:`${id}.png`,subfolder:'PhotoCreate/test-output',type:'output'}]};
      history.set(id,{status:{status_str:'success'},outputs});
    }
    pending.clear();
  };
  return {...instance,dataDir,outputDir,base,visitor,prompts,views,completePending,pending,cancellations,setCancelError:value=>{cancelError=value;}};
}
const upload=async(client,name)=>{const form=new FormData();form.append('image',new Blob([PNG],{type:'image/png'}),name+'.png');return client.request('/characters',form);};

test('顧客的九類提詞收藏依帳號保存，跨重開仍可使用，拒絕他人修改與無效資料',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),official=f.store.read(state=>state.presets);
  const bodies=Object.keys(PHOTO_CHANGE_FIELDS).map(field=>({field,name:`我的 ${field}`,prompt:`My saved ${field} direction.`,ownerId:'forged-owner'}));
  const saved=[];
  for(const body of bodies) {const result=await alice.request('/prompts',body);assert.equal(result.status,201);assert.equal(result.data.ownerId,undefined);saved.push(result.data);}
  assert.deepEqual((await alice.request('/state')).data.customerPrompts.map(row=>row.id).sort(),saved.map(row=>row.id).sort());
  assert.deepEqual((await bob.request('/prompts')).data,[]);
  assert.deepEqual((await bob.request('/state')).data.customerPrompts,[]);
  assert.equal((await bob.request(`/prompts/${saved[0].id}`,bodies[0],'PATCH')).status,404);
  assert.equal((await bob.request(`/prompts/${saved[0].id}`,undefined,'DELETE')).status,404);
  assert.equal((await alice.request('/prompts',bodies[0])).status,200);
  assert.equal((await alice.request('/prompts')).data.length,9);
  const updated=await alice.request(`/prompts/${saved[0].id}`,{...bodies[0],name:'  我的新搭配  ',prompt:'  Edited saved direction.  '},'PATCH');
  assert.equal(updated.status,200);assert.equal(updated.data.name,'我的新搭配');assert.equal(updated.data.prompt,'Edited saved direction.');
  for(const body of [null,[],{...bodies[0],field:'__proto__'},{...bodies[0],field:'camera'},{...bodies[0],name:''},{...bodies[0],name:'x'.repeat(81)},{...bodies[0],prompt:' '},{...bodies[0],prompt:'x'.repeat(2001)}]) assert.equal((await alice.request('/prompts',body)).status,400);
  const ownerId=f.store.read(state=>state.customerPrompts.find(row=>row.id===saved[0].id).ownerId),reopened=createStore(f.dataDir);
  try {assert.equal(createCustomerPrompts(reopened).list(ownerId).length,9);assert.equal(createCustomerPrompts(reopened).list(ownerId).find(row=>row.id===saved[0].id).prompt,'Edited saved direction.');}
  finally {reopened.close();}
  assert.equal((await alice.request(`/prompts/${saved[0].id}`,undefined,'DELETE')).status,200);
  assert.equal((await alice.request('/prompts')).data.length,8);
  const admin=await fetch(f.base+'/api/state');assert.equal(Object.hasOwn(await admin.json(),'customerPrompts'),false);
  assert.deepEqual(f.store.read(state=>state.presets),official);
});

test('顧客服裝圖片只供本人選用，實際以 image2 拍攝，移除收藏保留既有拍攝快照',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const offered=(await alice.request('/state')).data,form=new FormData();
  form.append('image',new Blob([PNG],{type:'image/png'}),'my-jacket.png');form.append('visitorId','forged-owner');
  const uploaded=await alice.request('/garments',form);
  assert.equal(uploaded.status,201);assert.equal(uploaded.data.owned,true);assert.equal(uploaded.data.name,'my-jacket');
  const garment=f.store.read(state=>state.garments.find(row=>row.id===uploaded.data.id));
  assert.notEqual(garment.visitorId,'forged-owner');assert.equal(garment.description,'');
  assert.deepEqual((await alice.request(`/garments/${garment.id}/image`)).data,PNG);
  for(const query of ['', '?thumbnail=card']) assert.equal((await bob.request(`/garments/${garment.id}/image${query}`)).status,404);
  assert.equal((await bob.request(`/garments/${garment.id}`,{name:'other'},'PATCH')).status,404);
  assert.equal((await bob.request(`/garments/${garment.id}`,undefined,'DELETE')).status,404);
  assert.equal((await alice.request(`/garments/${offered.garments[0].id}`,{name:'official'},'PATCH')).status,404);
  assert.equal((await alice.request(`/garments/${garment.id}`,{name:'我的外套'},'PATCH')).status,200);
  assert.equal((await alice.request('/state')).data.garments.filter(row=>row.owned).length,1);
  assert.equal((await bob.request('/state')).data.garments.some(row=>row.id===garment.id),false);
  assert.equal((await (await fetch(f.base+'/api/state')).json()).garments.some(row=>row.id===garment.id),false);
  assert.equal((await fetch(f.base+`/uploads/${garment.fileName}`)).status,404);
  const invalid=new FormData();invalid.append('image',new Blob(['not-an-image'],{type:'image/png'}),'bad.png');
  const filesBefore=fs.readdirSync(path.join(f.dataDir,'uploads'));
  assert.equal((await alice.request('/garments',invalid)).status,400);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'uploads')),filesBefore);
  const bobOwner=(await upload(bob,'bob-personal')).data.id;
  const bobId=f.store.read(state=>state.characters.find(row=>row.id===bobOwner).visitorId);
  f.store.mutate(state=>{
    const [plan]=buildShotPlans(state,{...DRAFT,copies:1,cameraMode:'multiangle',cameraEnabled:false,garmentIds:['garment-a'],poseIds:['pose-standing']});
    const source={...plan,id:'personal-outfit-source',status:'completed',createdAt:new Date().toISOString(),visitorId:garment.visitorId,images:[{filename:'source.png',subfolder:'PhotoCreate/test-output',type:'output'}]};
    state.jobs.unshift(source,{...structuredClone(source),id:'bob-outfit-source',visitorId:bobId},{...structuredClone(source),id:'admin-outfit-source',visitorId:undefined});
  });
  fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','test-output','source.png'),PNG);
  const body={requestId:randomUUID(),customization:{useOriginal:{clothing:false},clothingMode:'reference',garmentId:garment.id}};
  assert.equal((await bob.request('/jobs/bob-outfit-source/custom',body)).status,400);
  assert.equal((await fetch(f.base+'/api/jobs/admin-outfit-source/custom',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,400);
  const result=await alice.request('/jobs/personal-outfit-source/custom',body);
  assert.equal(result.status,202);
  assert.equal((await alice.request('/jobs/personal-outfit-source/custom',body)).status,200);
  const job=f.store.read(state=>state.jobs.find(row=>row.id===result.data.job.id));
  assert.equal(job.garment.id,garment.id);assert.equal(job.garment.name,'我的外套');assert.equal(job.character.id,'character');
  for(let i=0;i<100 && !f.prompts.length;i++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(f.prompts.length);
  const graph=f.prompts[0].prompt,encoder=Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21');
  assert.match(graph[encoder.inputs['images.image_1'][0]].inputs.image,/character\.png/);
  assert.ok(graph[encoder.inputs['images.image_2'][0]].inputs.image.includes(garment.fileName));
  assert.equal((await alice.request(`/garments/${garment.id}`,undefined,'DELETE')).status,200);
  assert.equal((await alice.request('/state')).data.garments.some(row=>row.id===garment.id),false);
  assert.equal((await alice.request(`/garments/${garment.id}/image`)).status,404);
  assert.equal(f.store.read(state=>state.jobs.find(row=>row.id===job.id).garment.fileName),garment.fileName);
  assert.ok(fs.existsSync(path.join(f.dataDir,'uploads',garment.fileName)));
});

test('顧客可編輯自己的角色與三視圖，保留拍攝快照且拒絕他人與共用角色修改',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),official=(await alice.request('/state')).data.characters[0];
  const character=(await upload(alice,'personal')).data;
  const originalFile=f.store.read().characters.find(row=>row.id===character.id).fileName;
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  await alice.request('/jobs/stop',{all:true});
  const snapshot=structuredClone(f.store.read().jobs.find(row=>row.id===shoot.data.jobs[0].id));
  const edited=await alice.request(`/characters/${character.id}`,{name:' 新角色 ',cupSize:'D',heightCm:'172.5'},'PATCH');
  assert.equal(edited.status,200);assert.equal(edited.data.name,'新角色');assert.equal(edited.data.cupSize,'D');assert.equal(edited.data.heightCm,172.5);assert.equal(edited.data.id,character.id);
  const before=structuredClone(f.store.read().characters.find(row=>row.id===character.id));
  for(const body of [{name:''},{name:'x'.repeat(201)},{name:7},{cupSize:'AA'},{heightCm:0},{name:'不能部分保存',heightCm:'bad'},{visitorId:'other'},{fileName:'outside.png'}]) {
    assert.equal((await alice.request(`/characters/${character.id}`,body,'PATCH')).status,400);
    assert.deepEqual(f.store.read().characters.find(row=>row.id===character.id),before);
  }
  assert.equal((await bob.request(`/characters/${character.id}`,{name:'other'},'PATCH')).status,404);
  assert.equal((await alice.request(`/characters/${official.id}`,{name:'shared'},'PATCH')).status,404);
  const replacement=Buffer.concat([PNG,Buffer.from('confirmed-three-view')]),form=new FormData();
  form.append('image',new Blob([replacement],{type:'image/png'}),'three-view.png');form.append('name','三視圖角色');form.append('cupSize','C');form.append('heightCm','165');
  const converted=await alice.request(`/characters/${character.id}`,form,'PATCH');assert.equal(converted.status,200);
  const saved=f.store.read().characters.find(row=>row.id===character.id);
  assert.equal(saved.name,'三視圖角色');assert.equal(saved.cupSize,'C');assert.equal(saved.heightCm,165);assert.notEqual(saved.fileName,originalFile);
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'uploads',originalFile)),PNG);
  assert.deepEqual((await alice.request(`/characters/${character.id}/image`)).data,replacement);
  assert.deepEqual(f.store.read().jobs.find(row=>row.id===snapshot.id),snapshot);
  const next=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});assert.equal(next.status,202);
  const updatedJob=f.store.read().jobs.find(row=>row.id===next.data.jobs[0].id);assert.equal(updatedJob.character.fileName,saved.fileName);assert.match(updatedJob.prompt,/height 165 cm; breast size C cup/);
  const cleared=await alice.request(`/characters/${character.id}`,{cupSize:'',heightCm:''},'PATCH');assert.equal(cleared.status,200);assert.equal(cleared.data.cupSize,undefined);assert.equal(cleared.data.heightCm,undefined);
});

test('顧客直接永久刪除照片會清理版本與實體產出，確認前不刪除且保護他人引用',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const created=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),foreign=await bob.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  const id=created.data.jobs[0].id,other=foreign.data.jobs[0].id,version=randomUUID(),image=filename=>({filename,subfolder:'PhotoCreate/test-output',type:'output'});
  assert.equal((await alice.request(`/jobs/${id}`,{permanent:true},'DELETE')).status,409);
  await alice.request('/jobs/stop',{all:true});await bob.request('/jobs/stop',{all:true});
  const file=name=>path.join(f.outputDir,'PhotoCreate','test-output',name);
  for(const name of ['delete-original.png','delete-stage.png','delete-version.png','keep-shared.png']) fs.writeFileSync(file(name),PNG);
  f.store.mutate(state=>{
    const job=state.jobs.find(row=>row.id===id);Object.assign(job,{status:'completed',images:[image('delete-original.png'),image('keep-shared.png')],stageResults:{base:{images:[image('delete-stage.png')],completed:true}}});
    state.jobs.push({...structuredClone(job),id:version,rootJobId:id,remakeVersion:1,images:[image('delete-version.png')],stageResults:{}});
    Object.assign(state.jobs.find(row=>row.id===other),{status:'completed',images:[image('keep-shared.png')],stageResults:{}});
  });
  await alice.request('/gallery',{jobId:version,imageIndex:0,folderId:''});
  const before=structuredClone(f.store.read().jobs);
  assert.equal((await alice.request('/photos/delete',{ids:[id,other],permanent:true})).status,404);assert.deepEqual(f.store.read().jobs,before);assert(fs.existsSync(file('delete-original.png')));
  const deleted=await alice.request('/photos/delete',{ids:[id],permanent:true});assert.equal(deleted.status,200);assert.equal(deleted.data.count,2);assert.equal(deleted.data.deletedFiles,3);
  for(const name of ['delete-original.png','delete-stage.png','delete-version.png']) assert(!fs.existsSync(file(name)),name);
  assert(fs.existsSync(file('keep-shared.png')));assert.equal((await alice.request('/state')).data.gallery.length,0);assert.equal((await alice.request(`/jobs/${id}/restore`,{})).status,404);
  assert.deepEqual(f.store.read().jobs,before.filter(row=>row.id===other));
  const single=await bob.request(`/jobs/${other}`,{permanent:true},'DELETE');assert.equal(single.status,200);assert.equal(single.data.deletedFiles,1);assert(!fs.existsSync(file('keep-shared.png')));
});

test('永久刪除顧客資料夾清理全部版本與回收照片，拍攝中及檔案清理失敗保留資料',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const folder=(await alice.request('/folders',{name:'旅行'})).data,empty=(await alice.request('/folders',{name:'空資料夾'})).data;
  const shoot=await alice.request('/shoots',{characterId:character.id,count:2,folderId:folder.id,requestId:randomUUID()}),ids=shoot.data.jobs.map(job=>job.id);
  assert.equal((await alice.request(`/folders/${folder.id}`,{deletePhotos:true},'DELETE')).status,409);assert((await alice.request('/state')).data.folders.some(row=>row.id===folder.id));
  assert.equal((await bob.request(`/folders/${folder.id}`,{deletePhotos:true},'DELETE')).status,404);
  await alice.request('/jobs/stop',{all:true});
  const file=path.join(f.outputDir,'PhotoCreate','test-output','folder-result.png');fs.writeFileSync(file,PNG);
  f.store.mutate(state=>{const job=state.jobs.find(row=>row.id===ids[0]);Object.assign(job,{status:'completed',images:[{filename:'folder-result.png',subfolder:'PhotoCreate/test-output',type:'output'}]});state.jobs.find(row=>row.id===ids[1]).visitorDeletedAt=new Date().toISOString();});
  await alice.request('/gallery',{jobId:ids[0],imageIndex:0,folderId:''});
  f.store.mutate(state=>{state.jobs.find(row=>row.id===ids[0]).comfyUrl='https://remote.example';});
  assert.equal((await alice.request(`/folders/${folder.id}`,{deletePhotos:true},'DELETE')).status,400);assert(fs.existsSync(file));assert.equal((await alice.request('/state')).data.gallery.length,1);
  f.store.mutate(state=>{state.jobs.find(row=>row.id===ids[0]).comfyUrl='http://127.0.0.1:8188';});
  const deleted=await alice.request(`/folders/${folder.id}`,{deletePhotos:true},'DELETE');assert.equal(deleted.status,200);assert.equal(deleted.data.count,2);assert.equal(deleted.data.deletedFiles,1);assert(!fs.existsSync(file));
  const state=(await alice.request('/state')).data;assert.equal(state.jobs.length,0);assert.equal(state.trash.length,0);assert.equal(state.gallery.length,0);assert(!state.folders.some(row=>row.id===folder.id));
  assert.equal((await alice.request(`/folders/${empty.id}`,{deletePhotos:true},'DELETE')).status,200);
});

test('撤除已發布的服裝狀態分類項目，同步移除顧客舊提詞並更新發布時間',async t=>{
  const f=await fixture(t),alice=f.visitor();
  const draft={...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,clothingStateIds:['clothing-state-neat','clothing-state-breeze']};
  const publish=await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(draft)});assert.equal(publish.status,200);
  f.store.mutate(state=>{state.customerRecipe.updatedAt='2020-01-01T00:00:00.000Z';state.draft=draft;state.workbenchDrafts={random:draft,combinations:{...draft,mode:'combinations'}};});
  const oldPreset=f.store.read().presets.find(row=>row.id==='clothing-state-neat');
  const move=await fetch(f.base+'/api/presets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...oldPreset,category:'pose'})});assert.equal(move.status,200);
  assert.deepEqual(f.store.read().customerRecipe.pools.clothingState.map(row=>row.id),['clothing-state-breeze'],'Withdrawn clothing prompts must leave the published pool immediately');
  assert.notEqual(f.store.read().customerRecipe.updatedAt,'2020-01-01T00:00:00.000Z');
  assert.deepEqual(f.store.read().draft.clothingStateIds,['clothing-state-breeze']);
  assert.deepEqual((await alice.request('/state')).data.presets.filter(row=>row.category==='clothing_state').map(row=>row.id),['clothing-state-breeze']);
  const other=f.store.read().presets.find(row=>row.id==='clothing-state-breeze');
  const imported=await fetch(f.base+'/api/presets/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify([{...other,category:'interaction'}])});assert.equal(imported.status,200);
  assert.deepEqual(f.store.read().customerRecipe.pools.clothingState,[]);
  assert.ok(Object.values(f.store.read().workbenchDrafts).every(row=>row.clothingStateIds.length===0));
  const next=await alice.request('/shoots',{characterId:'character',count:1,requestId:randomUUID()});assert.equal(next.status,202);
  const photo=f.store.read().jobs.find(row=>row.id===next.data.jobs[0].id);
  assert.equal(photo.clothingState,null);assert.ok(!photo.prompt.includes(oldPreset.prompt));assert.ok(!photo.prompt.includes(other.prompt));
});

test('刪除已發布服裝狀態同步清理，已開放提詞保持最新內容且原照片保留快照',async t=>{
  const f=await fixture(t),alice=f.visitor();
  const draft={...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,clothingStateIds:['clothing-state-neat']};
  assert.equal((await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(draft)})).status,200);
  const state=(await alice.request('/state')).data;
  const shoot=await alice.request('/shoots',{characterId:state.characters[0].id,count:1,requestId:randomUUID()});assert.equal(shoot.status,202);
  const original=structuredClone(f.store.read().jobs[0]);
  f.store.mutate(state=>{state.customerRecipe.updatedAt='2020-01-01T00:00:00.000Z';state.presets.find(row=>row.id==='pose-standing').prompt='Unpublished pose edit';});
  assert.equal((await fetch(f.base+'/api/presets/clothing-state-neat',{method:'DELETE'})).status,200);
  const after=f.store.read();
  assert.deepEqual(after.customerRecipe.pools.clothingState,[]);
  assert.notEqual(after.customerRecipe.updatedAt,'2020-01-01T00:00:00.000Z','Deleting a published choice must republish the cleaned configuration');
  assert.equal(after.customerRecipe.pools.pose.find(row=>row.id==='pose-standing').prompt,'Unpublished pose edit');
  assert.deepEqual(after.jobs[0],original);
  assert.equal((await alice.request('/state')).data.presets.some(row=>row.id==='clothing-state-neat'),false);
});

test('顧客每次最多拍攝 12 張，非法數量不能建立照片或送出產圖',async t=>{
  const f=await fixture(t),alice=f.visitor(),state=(await alice.request('/state')).data;
  assert.equal(state.maxCount,12);
  for(const count of [0,13,24,25,1.5,'12',null]) {
    const result=await alice.request('/shoots',{characterId:state.characters[0].id,count,requestId:randomUUID()});
    assert.equal(result.status,400,JSON.stringify(count));assert.match(result.data.error,/1–12/);
  }
  assert.equal(f.store.read().jobs.length,0);assert.equal(f.prompts.length,0);
  const created=await alice.request('/shoots',{characterId:state.characters[0].id,count:12,requestId:randomUUID()});
  assert.equal(created.status,202);assert.equal(created.data.jobs.length,12);
});

test('顧客可一次暫停整組或全部自己的拍攝，保留完成照片及其他顧客任務',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const character=(await alice.request('/state')).data.characters[0].id;
  const shoot=async(client,count)=>client.request('/shoots',{characterId:character,count,requestId:randomUUID()});
  const first=await shoot(alice,12),second=await shoot(alice,2),foreign=await shoot(bob,1);
  assert.equal(first.status,202);assert.equal(second.status,202);assert.equal(foreign.status,202);
  const ids=first.data.jobs.map(row=>row.id),other=foreign.data.jobs[0].id,batchId=first.data.jobs[0].batchId;
  f.store.mutate(state=>{for(const job of state.jobs.filter(row=>ids.slice(0,2).includes(row.id))) {job.status='completed';job.images=[{filename:'finished.png',type:'output'}];}});
  const completed=f.store.read().jobs.filter(row=>ids.slice(0,2).includes(row.id)),foreignBefore=structuredClone(f.store.read().jobs.find(row=>row.id===other));
  const pause=await alice.request('/jobs/stop',{batchId});assert.equal(pause.status,200);
  assert.equal(pause.data.results.length,10);assert.ok(pause.data.results.every(row=>row.ok && row.status==='stopped'));
  assert.deepEqual(f.store.read().jobs.filter(row=>ids.slice(0,2).includes(row.id)),completed);
  assert.deepEqual(f.store.read().jobs.find(row=>row.id===other),foreignBefore);
  assert.equal((await bob.request('/jobs/stop',{batchId})).status,404);
  assert.equal((await alice.request('/jobs/stop',{all:true,ids:[other]})).status,400);
  const all=await alice.request('/jobs/stop',{all:true});assert.equal(all.status,200);assert.equal(all.data.results.length,2);
  assert.ok(all.data.results.every(row=>row.ok && row.status==='stopped'));
  assert.deepEqual(f.store.read().jobs.find(row=>row.id===other),foreignBefore);
  assert.deepEqual((await alice.request('/jobs/stop',{all:true})).data.results,[]);
});

test('玩家自訂拍攝可選已開放的官方提詞及三種比例，完整原提詞與角色參考保留',async t=>{
  const f=await fixture(t),alice=f.visitor();
  f.store.mutate(state=>{
    state.draft={...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,garmentIds:['garment-a'],poseIds:['pose-standing'],expressionIds:['expression-smile'],clothingStateIds:['clothing-state-neat'],interactionIds:['interaction-bed']};
    state.presets.find(row=>row.id==='quality-candid').prompt+=' '+ 'Natural photographic details. '.repeat(100);
  });
  const firstState=(await alice.request('/state')).data;
  const shoot=await alice.request('/shoots',{characterId:firstState.characters[0].id,count:1,aspectRatio:'9:16',requestId:randomUUID()});
  for(let i=0;i<100 && !f.pending.size;i++) await new Promise(resolve=>setTimeout(resolve,10));
  f.completePending();await f.stageRunner.tick();
  const original=structuredClone(f.store.read().jobs.find(row=>row.id===shoot.data.jobs[0].id));
  assert.equal(original.status,'completed');
  const publish=await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,garmentIds:['garment-b'],poseIds:['pose-sitting'],expressionIds:['expression-calm'],clothingStateIds:['clothing-state-breeze'],interactionIds:['interaction-window'],lightingIds:['light-golden'],colorIds:['color-film'],qualityIds:['quality-candid']})});
  assert.equal(publish.status,200);
  const selections=[['pose','pose','pose-sitting','Pose and action','Pose'],['clothingState','clothingState','clothing-state-breeze','Clothing state','Clothing state'],['scene','interaction','interaction-window','Scene','Scene'],['expression','expression','expression-calm','Facial expression','Facial expression'],['lighting','lighting','light-golden','Lighting','Lighting'],['color','color','color-film','Color treatment','Color treatment'],['quality','quality','quality-candid','Photographic quality','Photographic quality']];
  const offered=(await alice.request('/state')).data;
  assert.deepEqual(offered.presets.map(row=>row.id).sort(),selections.map(row=>row[2]).sort());
  assert.equal(offered.jobs.find(row=>row.id===original.id).aspectRatio,'9:16');
  const create=customization=>alice.request(`/jobs/${original.id}/custom`,{requestId:randomUUID(),customization});
  const settle=async id=>{
    for(let i=0;i<100 && !f.store.read().jobs.find(row=>row.id===id)?.apiPrompt;i++) await new Promise(resolve=>setTimeout(resolve,10));
    const saved=structuredClone(f.store.read().jobs.find(row=>row.id===id));
    assert.ok(saved.apiPrompt);f.completePending();await f.stageRunner.tick();return saved;
  };
  for(const [key,field,presetId,newLabel,oldLabel] of selections) {
    const preset=f.store.read().presets.find(row=>row.id===presetId),body={requestId:randomUUID(),customization:{useOriginal:{[key]:false},fieldModes:{[key]:'preset'},presetIds:{[key]:presetId},changes:{[key]:'Do not use this client-supplied prompt.'}}};
    const result=await alice.request(`/jobs/${original.id}/custom`,body);assert.equal(result.status,202);
    const saved=await settle(result.data.job.id);
    assert.deepEqual(saved[field],preset);assert.deepEqual(saved.photoCustomization.changes,{});
    assert.deepEqual(saved.photoCustomization.presetIds,{[key]:presetId});
    assert.equal(saved.prompt,original.prompt.replace(`${oldLabel}: ${original[field].prompt}`,`${newLabel}: ${preset.prompt}`));
    assert.ok(!saved.prompt.includes('client-supplied'));assert.ok(saved.prompt.includes(DRAFT.extra));
    for(const other of ['garment','pose','clothingState','interaction','expression','lighting','color','quality'].filter(name=>name!==field)) assert.deepEqual(saved[other],original[other]);
    assert.deepEqual(saved.character,original.character);assert.notEqual(saved.seed,original.seed);
    const encoder=Object.values(saved.apiPrompt).find(node=>node.class_type==='TextEncodeQwenImage21');
    assert.equal(encoder.inputs.prompt,saved.prompt);
    assert.match(saved.apiPrompt[encoder.inputs['images.image_1'][0]].inputs.image,/character\.png$/);
    assert.match(saved.apiPrompt[encoder.inputs['images.image_2'][0]].inputs.image,/garment-a\.png$/);
    assert.equal(Object.values(saved.apiPrompt).some(node=>node._meta?.cameraAngle),false);
    const details=(await alice.request(`/jobs/${saved.id}/prompts`)).data;
    assert.deepEqual(details.settings.find(row=>row.key===key),{key,label:{pose:'動作',clothingState:'服裝狀態',scene:'場景',expression:'表情',lighting:'光線',color:'色彩',quality:'畫質'}[key],value:preset.name,source:'preset'});
    assert.equal((await alice.request(`/jobs/${original.id}/custom`,body)).data.created,false);
    assert.equal((await alice.request(`/jobs/${original.id}/custom`,{...body,customization:{...body.customization,aspectRatio:'1:1'}})).status,409);
  }
  for(const aspectRatio of ['9:16','1:1','16:9']) {
    const result=await create({aspectRatio});assert.equal(result.status,202);
    const saved=await settle(result.data.job.id),size=getOutputSize(aspectRatio,original.resolution);
    assert.equal(saved.aspectRatio,aspectRatio);assert.equal(saved.outputWidth,size.width);assert.equal(saved.outputHeight,size.height);
    assert.equal(saved.prompt,original.prompt);assert.deepEqual(saved.character,original.character);assert.deepEqual(saved.garment,original.garment);
    const latent=Object.values(saved.apiPrompt).find(node=>node.class_type==='LatentUpscale');
    assert.equal(latent.inputs.width,size.width/2);assert.equal(latent.inputs.height,size.height/2);
    const visible=(await alice.request('/state')).data.jobs.find(row=>row.id===saved.id);
    assert.equal(visible.aspectRatio,aspectRatio);assert.equal(visible.width,size.width);assert.equal(visible.height,size.height);
  }
  const jobCount=f.store.read().jobs.length;
  for(const customization of [
    {aspectRatio:'4:3'},{aspectRatio:2},{useOriginal:{pose:false},fieldModes:{pose:'bad'}},
    {useOriginal:{pose:false},fieldModes:{pose:'preset'},presetIds:{pose:'pose-standing'}},
    {useOriginal:{pose:false},fieldModes:{pose:'preset'},presetIds:{pose:'light-golden'}},
    {useOriginal:{pose:false},fieldModes:{pose:'preset'},presetIds:{}},
    {useOriginal:{lighting:false},changes:{lighting:'a'.repeat(2001)}},
  ]) assert.equal((await create(customization)).status,400,JSON.stringify(customization));
  assert.equal(f.store.read().jobs.length,jobCount);
  const removed=await fetch(f.base+'/api/presets/expression-calm',{method:'DELETE'});assert.equal(removed.status,200);
  assert.ok(!(await alice.request('/state')).data.presets.some(row=>row.id==='expression-calm'));
  assert.equal((await create({useOriginal:{expression:false},fieldModes:{expression:'preset'},presetIds:{expression:'expression-calm'}})).status,400);
  const hidden=await create({useOriginal:{expression:true},fieldModes:{expression:'preset'},presetIds:{expression:'expression-calm'},changes:{expression:'hidden'},aspectRatio:'1:1'});
  assert.equal(hidden.status,202);
  const inherited=await settle(hidden.data.job.id);
  assert.equal(inherited.prompt,original.prompt);assert.deepEqual(inherited.photoCustomization.presetIds,{});
  assert.equal(inherited.photoCustomization.preserveOriginal,true);assert.equal(inherited.aspectRatio,'1:1');
  assert.deepEqual(f.store.read().jobs.find(row=>row.id===original.id),original);
});

test('自訂拍攝保留角色參考；文字換裝只送 image1，開放服裝圖作 image2，原照與鏡頭流程分開',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  f.store.mutate(state=>{state.draft={...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,clothingStateIds:['clothing-state-neat']};});
  const state=(await alice.request('/state')).data;
  const shoot=await alice.request('/shoots',{characterId:state.characters[0].id,count:1,requestId:randomUUID()});
  for(let i=0;i<100 && !f.pending.size;i++) await new Promise(resolve=>setTimeout(resolve,10));
  f.completePending();await f.stageRunner.tick();
  const id=shoot.data.jobs[0].id,original=structuredClone(f.store.read().jobs.find(row=>row.id===id));
  assert.equal(original.status,'completed');
  assert.equal(original.clothingState.id,'clothing-state-neat');
  const rolePreview=await alice.request(`/jobs/${id}/character-reference`);
  assert.equal(rolePreview.status,200);assert.deepEqual(rolePreview.data,PNG);
  assert.equal((await bob.request(`/jobs/${id}/character-reference`)).status,404);
  const publish=await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...DRAFT,mode:'random',randomPoolMode:'selected',garmentIds:['garment-b'],cameraEnabled:false})});assert.equal(publish.status,200);
  const selection=(await alice.request('/state')).data.garments;
  assert.deepEqual(selection.map(row=>row.id),['garment-b']);
  assert.equal((await alice.request('/garments/garment-b/image')).status,200);
  assert.equal((await alice.request('/garments/garment-a/image')).status,404);
  assert.equal((await bob.request(`/jobs/${id}/custom`,{requestId:randomUUID()})).status,404);
  assert.equal((await alice.request(`/jobs/${id}/custom`,{requestId:randomUUID(),customization:{preserveOriginal:false,clothingMode:'reference',garmentId:'garment-a'}})).status,400);
  assert.equal((await alice.request(`/jobs/${id}/custom`,{requestId:randomUUID(),customization:{preserveOriginal:'false'}})).status,400);
  assert.equal((await alice.request(`/jobs/${id}/custom`,{requestId:randomUUID(),customization:{useOriginal:{pose:'false'}}})).status,400);
  assert.equal((await alice.request(`/jobs/${id}/custom`,{requestId:randomUUID(),customization:{useOriginal:{clothingState:'false'}}})).status,400);
  assert.equal((await alice.request(`/jobs/${id}/custom`,{requestId:randomUUID(),customization:{preserveOriginal:false,changes:{pose:'a'.repeat(2001)}}})).status,400);
  assert.equal((await alice.request(`/jobs/${id}/custom`,{requestId:randomUUID(),customization:{useOriginal:{clothingState:false},changes:{clothingState:'a'.repeat(2001)}}})).status,400);
  const customClothingState='The sleeves are rolled neatly to the elbows. The collar, seams and hem are aligned, with soft fabric folds following the pose.';
  const cases=[
    {customization:{preserveOriginal:true,changes:{pose:'hidden pose',clothing:'hidden clothes',clothingState:'hidden clothing state'}},expectedClothing:original.garment.id,images:2},
    {customization:{preserveOriginal:false,clothingMode:'text',changes:{pose:'Sitting on a bench with hands on knees',clothing:'a red long-sleeve dress',clothingState:'The sleeves are rolled neatly to the elbows.',scene:'a sunny seaside terrace',expression:'a gentle smile'}},images:1},
    {customization:{preserveOriginal:false,clothingMode:'reference',garmentId:'garment-b',changes:{pose:'Standing with hands on hips',clothing:'ignored text clothes'}},expectedClothing:'garment-b',images:2},
    {customization:{useOriginal:{pose:true,clothing:false,scene:true,expression:true},clothingMode:'reference',garmentId:'garment-b'},expectedClothing:'garment-b',images:2,onlyReference:true},
    ...['pose','clothingState','scene','expression'].map(field=>({customization:{useOriginal:{pose:field!=='pose',clothing:true,clothingState:field!=='clothingState',scene:field!=='scene',expression:field!=='expression'},clothingMode:'reference',garmentId:'garment-a',changes:{pose:'Standing with hands on hips',clothing:'ignored text clothes',clothingState:customClothingState,scene:'a sunny seaside terrace',expression:'a gentle smile'}},expectedClothing:original.garment.id,images:2,onlyField:field})),
  ];
  for(const scenario of cases) {
    const body={requestId:randomUUID(),imageIndex:0,customization:scenario.customization};
    const result=await alice.request(`/jobs/${id}/custom`,body);assert.equal(result.status,202);
    const saved=f.store.read().jobs.find(row=>row.id===result.data.job.id);
    assert.equal(saved.jobKind,'photo-edit');assert.equal(saved.cameraEnabled,false);assert.equal(saved.deleteSourceOnComplete,false);assert.equal(saved.character.fileName,original.character.fileName);assert.notEqual(saved.seed,original.seed);
    assert.equal(saved.visitorId,original.visitorId);assert.deepEqual(saved.photoSource.image,original.images[0]);
    assert.equal((await alice.request(`/jobs/${id}/custom`,body)).data.created,false);
    assert.equal((await alice.request(`/jobs/${id}/custom`,{...body,imageIndex:1})).status,409);
    for(let i=0;i<100 && !f.store.read().jobs.find(row=>row.id===saved.id)?.apiPrompt;i++) await new Promise(resolve=>setTimeout(resolve,10));
    const graph=f.store.read().jobs.find(row=>row.id===saved.id).apiPrompt;
    assert.ok(graph);assert.equal(Object.values(graph).filter(node=>node.class_type==='LoadImage').length,scenario.images);
    const encoder=Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21'),first=graph[encoder.inputs['images.image_1'][0]];
    assert.match(first.inputs.image,new RegExp(original.character.fileName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal(Object.values(graph).some(node=>node.class_type==='QwenMultiangleCameraNode' || node._meta?.cameraAngle),false);
    if(scenario.images===1) {assert.equal(encoder.inputs['images.image_2'],undefined);assert.match(encoder.inputs.prompt,/wear: a red long-sleeve dress/);assert.match(encoder.inputs.prompt,/Replace the entire outfit shown in <image1>/);assert.match(encoder.inputs.prompt,/sunny seaside terrace/);assert.ok(!encoder.inputs.prompt.includes('<image2>'));}
    else if(scenario.onlyReference) {assert.equal(saved.prompt,original.prompt,'Only image2 changes; resend the entire original prompt');assert.equal(saved.garment.id,'garment-b');}
    else if(scenario.onlyField) {
      assert.deepEqual(saved.photoCustomization.changes,{[scenario.onlyField]:scenario.customization.changes[scenario.onlyField]});
      assert.equal(saved.garment.id,original.garment.id);assert.ok(!encoder.inputs.prompt.includes('ignored text clothes'));
      for(const [field,key] of [['pose','pose'],['clothingState','clothingState'],['scene','interaction'],['expression','expression']]) if(field!==scenario.onlyField) assert.deepEqual(saved[key],original[key]);
    }
    else if(!scenario.customization.preserveOriginal) {assert.equal(saved.garment.id,'garment-b');assert.match(graph[encoder.inputs['images.image_2'][0]].inputs.image,/garment-b\.png/);assert.ok(!encoder.inputs.prompt.includes('ignored text clothes'));}
    else {assert.equal(saved.prompt,original.prompt);assert.ok(!saved.prompt.includes('hidden pose'));}
    const details=(await alice.request(`/jobs/${saved.id}/prompts`)).data;
    assert.ok(encoder.inputs.prompt.includes(DRAFT.extra),'Unchanged extra instructions must be resent');
    if(scenario.customization.changes?.clothingState && (scenario.onlyField==='clothingState' || scenario.images===1)) {
      assert.equal(saved.clothingState.prompt,scenario.customization.changes.clothingState);
      assert.equal(details.settings.find(row=>row.key==='clothingState').value,saved.clothingState.prompt,'Show the full customer input, beyond the title length');
      assert.equal(details.settings.find(row=>row.key==='clothingState').source,'custom');
      assert.ok(encoder.inputs.prompt.includes(`Clothing state: ${saved.clothingState.prompt}`));
      assert.ok(!encoder.inputs.prompt.includes(`Clothing state: ${original.clothingState.prompt}`),'Replaced clothing state must not conflict with the old one');
      if(scenario.onlyField==='clothingState') assert.equal(saved.prompt,original.prompt.replace(`Clothing state: ${original.clothingState.prompt}`,`Clothing state: ${saved.clothingState.prompt}`),'Only clothing state changes in the complete saved prompt');
    } else {
      assert.deepEqual(saved.clothingState,original.clothingState);
      assert.ok(encoder.inputs.prompt.includes(`Clothing state: ${original.clothingState.prompt}`));
    }
    assert.equal(details.stages[0].label,'自訂拍攝');assert.equal(details.stages[0].references[0].name,original.character.name);
    const publicSaved=(await alice.request('/state')).data.jobs.find(job=>job.id===saved.id);
    assert.deepEqual(publicSaved.settings,details.settings);
    f.completePending();await f.stageRunner.tick();
    assert.equal(f.store.read().jobs.find(row=>row.id===saved.id).status,'completed');
    assert.deepEqual(f.store.read().jobs.find(row=>row.id===id),original);
  }
  const blank=await alice.request(`/jobs/${id}/custom`,{requestId:randomUUID(),customization:{useOriginal:{clothingState:false},changes:{clothingState:'  '}}});
  assert.equal(blank.status,202);
  const blankJob=f.store.read().jobs.find(row=>row.id===blank.data.job.id);
  assert.equal(blankJob.prompt,original.prompt);assert.deepEqual(blankJob.clothingState,original.clothingState);
  for(let i=0;i<100 && f.store.read().jobs.find(row=>row.id===blankJob.id).status!=='completed';i++) {
    await new Promise(resolve=>setTimeout(resolve,10));f.completePending();await f.stageRunner.tick();
  }
  assert.equal(f.store.read().jobs.find(row=>row.id===blankJob.id).status,'completed');
  const textPhoto=f.store.read().jobs.find(row=>row.jobKind==='photo-edit' && row.photoCustomization.clothingMode==='text');
  const replacement=await alice.request(`/jobs/${textPhoto.id}/custom`,{requestId:randomUUID(),customization:{useOriginal:{clothing:false},clothingMode:'text',changes:{clothing:'穿一件女僕裝'}}});
  assert.equal(replacement.status,202);
  const customized=f.store.read().jobs.find(row=>row.id===replacement.data.job.id);
  assert.match(customized.prompt,/The character should wear: 穿一件女僕裝/);assert.ok(!customized.prompt.includes('a red long-sleeve dress'));
  assert.equal(customized.prompt.split('Preserve the same identity, face, hairstyle and body proportions.').length-1,1,'Repeated clothing changes must not accumulate identity instructions');
  assert.equal(customized.prompt.split('Replace the entire outfit shown in <image1>').length-1,1);
  assert.match(customized.prompt,/黑色長袖、及膝的女僕洋裝/);
  assert.equal(customized.garment.input,'穿一件女僕裝');
  const maidSettings=(await alice.request(`/jobs/${customized.id}/prompts`)).data.settings.find(row=>row.key==='clothing');
  assert.equal(maidSettings.value,'穿一件女僕裝');assert.equal(maidSettings.description,customized.garment.description);
  assert.deepEqual(customized.clothingState,textPhoto.clothingState);
  assert.ok(customized.prompt.includes(DRAFT.extra));
  for(let i=0;i<100 && f.store.read().jobs.find(row=>row.id===customized.id).status!=='completed';i++) {
    await new Promise(resolve=>setTimeout(resolve,10));f.completePending();await f.stageRunner.tick();
  }
  assert.equal(f.store.read().jobs.find(row=>row.id===customized.id).status,'completed');
  const explicitDescription='藍色長袖女僕裝與米白色圍裙';
  const explicit=await alice.request(`/jobs/${customized.id}/custom`,{requestId:randomUUID(),customization:{useOriginal:{clothing:false},clothingMode:'text',changes:{clothing:explicitDescription}}});
  assert.equal(explicit.status,202);
  const explicitJob=f.store.read().jobs.find(row=>row.id===explicit.data.job.id);
  assert.equal(explicitJob.garment.description,explicitDescription);assert.match(explicitJob.prompt,/wear: 藍色長袖女僕裝與米白色圍裙/);
  assert.ok(!explicitJob.prompt.includes('黑色長袖、及膝的女僕洋裝'),'An explicit outfit must replace previous default details');
  for(let i=0;i<100 && f.store.read().jobs.find(row=>row.id===explicitJob.id).status!=='completed';i++) {
    await new Promise(resolve=>setTimeout(resolve,10));f.completePending();await f.stageRunner.tick();
  }
  assert.equal(f.store.read().jobs.find(row=>row.id===explicitJob.id).status,'completed');
  const angle=await alice.request(`/jobs/${customized.id}/angle`,{requestId:randomUUID(),angle:{horizontalAngle:90,verticalAngle:-30,zoom:8}});
  assert.equal(angle.status,202);
  for(let i=0;i<100 && f.store.read().jobs.find(row=>row.id===angle.data.job.id).status!=='completed';i++) {
    await new Promise(resolve=>setTimeout(resolve,10));f.completePending();await f.stageRunner.tick();
  }
  assert.equal(f.store.read().jobs.find(row=>row.id===angle.data.job.id).status,'completed');
  const followup=await alice.request(`/jobs/${angle.data.job.id}/custom`,{requestId:randomUUID(),customization:{preserveOriginal:true}});
  assert.equal(followup.status,202);
  const next=f.store.read().jobs.find(row=>row.id===followup.data.job.id);
  assert.equal(next.prompt,customized.prompt,'Following a custom photo angle must preserve its changed settings');
  assert.deepEqual(next.garment,customized.garment);assert.deepEqual(next.pose,customized.pose);assert.deepEqual(next.clothingState,customized.clothingState);
  assert.equal(next.garment.fileName,undefined,'Text clothing must remain text after angle shots');
  f.store.mutate(state=>{state.characters=[];state.customerRecipe.characterIds=[];});
  assert.equal((await alice.request(`/jobs/${id}/character-reference`)).status,200,'Existing photos keep their original role preview after the role is closed');
});

test('刪除提詞與服裝同步清理兩種草稿及顧客候選，舊頁面的保存也不能帶回失效勾選',async t=>{
  const f=await fixture(t),alice=f.visitor();await alice.request('/state');
  const draft={...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,expressionIds:['expression-smile'],expressionId:'expression-smile'};
  const put=(route,body)=>fetch(f.base+'/api'+route,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await put('/draft',{draft,modeDrafts:{random:draft,combinations:{...draft,mode:'combinations'}}})).status,200);
  assert.equal((await put('/customer-recipe',draft)).status,200);
  assert.equal((await fetch(f.base+'/api/presets/expression-smile',{method:'DELETE'})).status,200);
  const after=f.store.read();
  assert.deepEqual(after.customerRecipe.pools.expression,[]);
  for(const value of [after.draft,...Object.values(after.workbenchDrafts)]) {assert.deepEqual(value.expressionIds,[]);assert.equal(value.expressionId,'');}
  assert.equal((await put('/draft',{draft,modeDrafts:{random:draft}})).status,200);
  assert.deepEqual(f.store.read().draft.expressionIds,[]);
  assert.equal((await put('/customer-recipe',draft)).status,200);
  assert.deepEqual(f.store.read().customerRecipe.pools.expression,[],'An old page cannot publish a deleted expression again');
  assert.equal((await fetch(f.base+'/api/assets/garments/garment-a',{method:'DELETE'})).status,200);
  assert.deepEqual(f.store.read().customerRecipe.pools.garment.map(row=>row.id),['garment-b']);
  assert.equal((await alice.request('/garments/garment-a/image')).status,404);
  assert.equal((await fetch(f.base+'/api/presets/pose-standing',{method:'DELETE'})).status,200);
  assert.deepEqual(f.store.read().customerRecipe.pools.pose.map(row=>row.id),['pose-sitting']);
  assert.equal((await fetch(f.base+'/api/presets/pose-sitting',{method:'DELETE'})).status,200);
  assert.equal((await alice.request('/state')).data.ready,false);
});

test('刪除衣服與官方角色同步發布移除候選，保留顧客角色與照片快照',async t=>{
  const f=await fixture(t),alice=f.visitor();
  const personal=(await upload(alice,'保留個人角色')).data;
  f.store.mutate(state=>state.characters.push({...state.characters.find(row=>row.id==='character'),id:'character-other',name:'另一個官方角色'}));
  const published={...DRAFT,mode:'random',characterIds:['character','character-other'],garmentIds:['garment-a','garment-b'],cameraEnabled:false};
  assert.equal((await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(published)})).status,200);
  const shoot=await alice.request('/shoots',{characterId:'character',count:1,cameraEnabled:false,requestId:randomUUID()});assert.equal(shoot.status,202);
  await alice.request('/jobs/stop',{all:true});
  const snapshot=structuredClone(f.store.read().jobs.find(row=>row.id===shoot.data.jobs[0].id)),before=f.store.read().customerRecipe;
  f.store.mutate(state=>{state.garments.find(row=>row.id==='garment-b').description='UNPUBLISHED_WARDROBE_CHANGE';state.presets.find(row=>row.id==='quality-editorial').prompt='UNPUBLISHED_PROMPT_CHANGE';state.draft.characterIds=['character','character-other'];});
  const garment=await fetch(f.base+'/api/assets/garments/garment-a',{method:'DELETE'});assert.equal(garment.status,200);assert.equal((await garment.json()).customerRecipeUpdated,true);
  const character=await fetch(f.base+'/api/assets/characters/character',{method:'DELETE'});assert.equal(character.status,200);assert.equal((await character.json()).customerRecipeUpdated,true);
  const after=f.store.read();assert.deepEqual(after.customerRecipe.pools.garment.map(row=>row.id),['garment-b']);assert.deepEqual(after.customerRecipe.characterIds,['character-other']);
  assert.deepEqual(after.customerRecipe.pools.garment[0],{...before.pools.garment.find(row=>row.id==='garment-b'),description:'UNPUBLISHED_WARDROBE_CHANGE'});
  assert.deepEqual(after.customerRecipe.pools.quality,before.pools.quality.map(row=>row.id==='quality-editorial' ? {...row,prompt:'UNPUBLISHED_PROMPT_CHANGE'} : row));
  assert.deepEqual(after.draft.characterIds,['character-other']);assert.deepEqual(after.jobs.find(row=>row.id===snapshot.id),snapshot);
  const customer=(await alice.request('/state')).data;assert.deepEqual(customer.characters.map(row=>row.id).sort(),['character-other',personal.id].sort());assert.deepEqual(customer.garments.map(row=>row.id),['garment-b']);
  assert.equal((await alice.request('/characters/character/image')).status,404);assert.equal((await alice.request('/garments/garment-a/image')).status,404);
  assert.equal((await alice.request(`/jobs/${snapshot.id}/character-reference`)).status,200);
});

test('管理員勾選預設角色並套用後，顧客只可選已開放角色，自己的上傳與舊照片仍保留',async t=>{
  const f=await fixture(t),alice=f.visitor();
  const personal=(await upload(alice,'Private character')).data;
  f.store.mutate(state=>state.characters.push({...state.characters.find(row=>row.id==='character'),id:'disabled-character',name:'可關閉角色'}));
  const publish=async characterIds=>{const response=await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...DRAFT,mode:'random',characterIds})});return {status:response.status,data:await response.json()};};
  assert.equal((await publish(['character'])).status,200);
  assert.deepEqual((await alice.request('/state')).data.characters.map(row=>row.id).sort(),['character',personal.id].sort());
  assert.equal((await alice.request('/characters/disabled-character/image')).status,404);
  assert.equal((await alice.request('/shoots',{characterId:'disabled-character',count:1,requestId:randomUUID()})).status,400);
  const shoot=await alice.request('/shoots',{characterId:'character',count:1,requestId:randomUUID()});assert.equal(shoot.status,202);
  const id=shoot.data.jobs[0].id;f.completePending();await f.stageRunner.tick();
  const before=structuredClone(f.store.read().customerRecipe);assert.equal((await publish([personal.id])).status,400);assert.deepEqual(f.store.read().customerRecipe,before);
  assert.equal((await publish([])).status,200);
  assert.deepEqual((await alice.request('/state')).data.characters.map(row=>row.id),[personal.id]);
  assert.equal((await alice.request('/shoots',{characterId:'character',count:1,requestId:randomUUID()})).status,400);
  assert.equal((await alice.request(`/jobs/${id}/image/0`)).status,200);
  assert.equal((await alice.request('/shoots',{characterId:personal.id,count:1,requestId:randomUUID()})).status,202);
  assert.equal((await publish(['character','disabled-character'])).status,200);
  assert.equal((await alice.request('/state')).data.characters.length,3);
});

test('後台工作檯只列出自己的角色、拍攝與成果，顧客資料保留且各自隔離',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const ownResponse=await fetch(f.base+'/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(DRAFT)});
  assert.equal(ownResponse.status,201);
  const own=await ownResponse.json();
  const a=(await upload(alice,'Alice private')).data,b=(await upload(bob,'Bob private')).data;
  const aShoot=await alice.request('/shoots',{characterId:a.id,count:1,requestId:randomUUID()});
  const bShoot=await bob.request('/shoots',{characterId:b.id,count:1,requestId:randomUUID()});
  assert.equal(aShoot.status,202);assert.equal(bShoot.status,202);
  const admin=await (await fetch(f.base+'/api/state')).json();
  assert.deepEqual(admin.characters.map(row=>row.id),['character']);
  assert.deepEqual(admin.jobs.map(row=>row.id),own.map(row=>row.id));
  assert.deepEqual(admin.batches.map(row=>row.id),[own[0].batchId]);
  assert(!JSON.stringify(admin).includes('Alice private'));
  assert(!JSON.stringify(admin).includes('Bob private'));
  const aliceState=(await alice.request('/state')).data,bobState=(await bob.request('/state')).data;
  assert(aliceState.characters.some(row=>row.id===a.id));assert(!aliceState.characters.some(row=>row.id===b.id));
  assert.deepEqual(aliceState.jobs.map(row=>row.id),aShoot.data.jobs.map(row=>row.id));
  assert.deepEqual(bobState.jobs.map(row=>row.id),bShoot.data.jobs.map(row=>row.id));
  assert.equal(f.store.read().jobs.length,own.length+2);
});

test('後台不能讀取、修改、刪除或停止顧客的角色與拍攝',async t=>{
  const f=await fixture(t),alice=f.visitor(),character=(await upload(alice,'Private reference')).data;
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),id=shoot.data.jobs[0].id;
  const job=f.store.read().jobs.find(row=>row.id===id),file=job.character.image;
  const request=async(route,body,method=body===undefined ? 'GET' : 'POST')=>fetch(f.base+'/api'+route,{method,headers:{'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
  for(const route of [`/jobs/${id}/prompts`,`/jobs/${id}/prompt`,`/jobs/${id}/image/0`,`/jobs/${id}/angle-source`,`/jobs/${id}/character-reference`]) assert.equal((await request(route)).status,404,route);
  assert.equal((await fetch(f.base+file)).status,404);
  assert.equal((await request(`/assets/characters/${character.id}`,{name:'Changed'},'PATCH')).status,404);
  assert.equal((await request(`/assets/characters/${character.id}`,undefined,'DELETE')).status,404);
  assert.equal((await request('/jobs',{...DRAFT,characterId:character.id})).status,400);
  assert.equal((await request('/jobs/remake',{ids:[id],requestId:randomUUID()})).status,404);
  assert.equal((await request(`/jobs/${id}/angle`,{requestId:randomUUID(),angle:{horizontalAngle:0,verticalAngle:0,zoom:0}})).status,404);
  assert.equal((await request('/jobs/submit',{ids:[id]})).status,404);
  assert.equal((await request('/jobs/stop',{ids:[id]})).status,404);
  assert.equal((await request('/jobs/stop',{batchId:job.batchId})).status,404);
  const stopAll=await request('/jobs/stop',{all:true});assert.equal(stopAll.status,200);assert.deepEqual((await stopAll.json()).results,[]);
  assert.equal((await request(`/batches/${job.batchId}`,{name:'Changed'},'PATCH')).status,404);
  assert.equal((await request(`/batches/${job.batchId}`,undefined,'DELETE')).status,404);
  assert.equal((await request(`/jobs/${id}`,undefined,'DELETE')).status,404);
  assert.equal((await request('/jobs/outputs/delete',{ids:[id]})).status,404);
  assert(!(await alice.request('/state')).data.jobs[0].status.includes('stop'));
  assert((await alice.request('/state')).data.characters.some(row=>row.id===character.id));
});

test('精選畫廊固定選取版本與輸出，同一張不重複，資料夾與照片分類各自獨立',async t=>{
  const f=await fixture(t),alice=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),id=shoot.data.jobs[0].id,versionId=randomUUID();
  await alice.request('/jobs/stop',{ids:[id]});
  const photoFolder=(await alice.request('/folders',{name:'同名精選'})).data;
  const folder=(await alice.request('/gallery/folders',{name:'同名精選'})).data;assert.notEqual(folder.id,photoFolder.id);
  f.store.mutate(state=>{const job=state.jobs.find(row=>row.id===id);Object.assign(job,{status:'completed',images:[{filename:'original.png',type:'output'},{filename:'second.png',type:'output'}]});state.jobs.push({...structuredClone(job),id:versionId,rootJobId:id,remakeVersion:2,images:[{filename:'version-3.png',type:'output'}]});});
  const add=await alice.request('/gallery',{jobId:id,imageIndex:1,folderId:folder.id});assert.equal(add.status,201);
  assert.equal((await alice.request('/gallery',{jobId:id,imageIndex:1,folderId:folder.id})).data.created,false);
  assert.equal((await alice.request('/gallery',{jobId:versionId})).status,201);
  const state=(await alice.request('/state')).data;assert.equal(state.gallery.length,2);
  const saved=state.gallery.find(row=>row.id===add.data.entry.id);assert.equal(saved.jobId,id);assert.equal(saved.imageIndex,1);assert.match(saved.image,new RegExp(`/jobs/${id}/image/1$`));assert.equal(saved.folderId,folder.id);assert.equal(saved.version,0);
  assert.equal(f.store.read().jobs.find(row=>row.id===id).folderId,undefined);
  assert.equal((await alice.request('/gallery',{jobId:id,folderId:photoFolder.id})).status,404);
  const reopened=createStore(f.dataDir);assert.equal(reopened.read().galleryEntries.length,2);assert.equal(reopened.read().galleryFolders[0].name,'同名精選');reopened.close();
  const admin=await (await fetch(f.base+'/api/state')).json();assert.equal(admin.galleryEntries,undefined);assert.equal(admin.galleryFolders,undefined);
});

test('精選畫廊及分類夾只屬於本人，混入他人的 ID 時整批拒絕',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const a=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),b=await bob.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),aId=a.data.jobs[0].id,bId=b.data.jobs[0].id;
  await alice.request('/jobs/stop',{ids:[aId]});await bob.request('/jobs/stop',{ids:[bId]});
  f.store.mutate(state=>{for(const job of state.jobs) Object.assign(job,{status:'completed',images:[{filename:job.id+'.png',type:'output'}]});});
  const folder=(await alice.request('/gallery/folders',{name:'精選'})).data,otherFolder=(await bob.request('/gallery/folders',{name:'精選'})).data;
  const entry=(await alice.request('/gallery',{jobId:aId,folderId:folder.id})).data.entry,other=(await bob.request('/gallery',{jobId:bId})).data.entry;
  assert.equal((await alice.request('/gallery')).data.length,1);assert.equal((await bob.request('/state')).data.gallery.length,1);
  assert.equal((await bob.request('/gallery',{jobId:aId})).status,404);
  assert.equal((await alice.request('/gallery',{jobId:aId,folderId:otherFolder.id})).status,404);
  assert.equal((await bob.request(`/gallery/folders/${folder.id}`,{name:'Changed'},'PATCH')).status,404);
  assert.equal((await bob.request(`/gallery/folders/${folder.id}`,undefined,'DELETE')).status,404);
  assert.equal((await alice.request('/gallery/move',{ids:[entry.id,other.id],folderId:''})).status,404);
  assert.equal((await alice.request('/gallery/remove',{ids:[entry.id,other.id]})).status,404);
  assert.equal((await alice.request('/gallery')).data[0].folderId,folder.id);
  assert.equal((await alice.request('/gallery/move',{ids:[entry.id],folderId:''})).status,200);
  assert.equal((await alice.request('/gallery/remove',{ids:[entry.id]})).status,200);
  assert.equal((await alice.request('/state')).data.jobs.length,1,'Removing a selection keeps the original photo');
  assert.equal((await bob.request('/gallery')).data.length,1);
});

test('刪除精選分類夾保留照片；回收、還原與永久刪除同步畫廊狀態',async t=>{
  const f=await fixture(t),alice=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),id=shoot.data.jobs[0].id;
  assert.equal((await alice.request('/gallery',{jobId:id})).status,409);
  await alice.request('/jobs/stop',{ids:[id]});fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','test-output','selected.png'),PNG);f.store.mutate(state=>Object.assign(state.jobs.find(row=>row.id===id),{status:'completed',images:[{filename:'selected.png',subfolder:'PhotoCreate/test-output',type:'output'}]}));
  for(const imageIndex of [-1,0.5,'0',1]) assert.equal((await alice.request('/gallery',{jobId:id,imageIndex})).status,409);
  const folder=(await alice.request('/gallery/folders',{name:'旅行'})).data;
  assert.equal((await alice.request('/gallery/folders',{name:' 旅行 '})).status,409);
  assert.equal((await alice.request('/gallery/folders',{name:''})).status,400);
  assert.equal((await alice.request(`/gallery/folders/${folder.id}`,{name:'最喜歡'},'PATCH')).status,200);
  const entry=(await alice.request('/gallery',{jobId:id,folderId:folder.id})).data.entry;
  assert.equal((await alice.request(`/gallery/folders/${folder.id}`,undefined,'DELETE')).status,200);
  assert.equal((await alice.request('/gallery')).data[0].folderId,'');
  await alice.request(`/jobs/${id}`,undefined,'DELETE');assert.equal((await alice.request('/gallery')).data.length,0);
  await alice.request(`/jobs/${id}/restore`,{});assert.equal((await alice.request('/gallery')).data[0].id,entry.id);
  await alice.request(`/jobs/${id}`,undefined,'DELETE');assert.equal((await alice.request('/photos/purge',{ids:[id]})).status,200);
  assert.equal(f.store.read().galleryEntries.length,0);assert.equal((await alice.request('/gallery')).data.length,0);
});

test('已選角色可在上一組拍攝中加入下一組，依序執行且重送不重複建立',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const initial=(await alice.request('/state')).data;
  assert.equal(initial.canQueueShoots,true);
  const character=initial.characters[0];
  const first=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  assert.equal(first.status,202);
  await new Promise(resolve=>setImmediate(resolve));await f.stageRunner.tick();
  const firstId=first.data.jobs[0].id;
  assert((await alice.request('/state')).data.jobs.find(job=>job.id===firstId).active);
  const secondCharacter=(await upload(alice,'Next character')).data;
  const body={characterId:secondCharacter.id,count:1,cameraEnabled:true,requestId:randomUUID()};
  const next=await alice.request('/shoots',body);
  assert.equal(next.status,202,'A running shoot must not prevent the selected character from joining the queue');
  assert.equal(next.data.jobs[0].status,'queued');
  const nextId=next.data.jobs[0].id;
  assert.notEqual(nextId,firstId);
  assert.equal(f.store.read().jobs.find(job=>job.id===nextId).character.id,secondCharacter.id);
  const again=await alice.request('/shoots',body);
  assert.equal(again.status,200);assert.equal(again.data.created,false);
  assert.deepEqual(again.data.jobs.map(job=>job.id),[nextId]);
  assert.equal((await bob.request('/state')).data.jobs.length,0);
  await f.stageRunner.tick();
  assert(!f.store.read().jobs.find(job=>job.id===nextId).promptId,'The next batch waits for the current batch');
  f.completePending();await f.stageRunner.tick();await f.stageRunner.tick();
  assert.equal(f.store.read().jobs.find(job=>job.id===firstId).status,'completed');
  assert(f.store.read().jobs.find(job=>job.id===nextId).promptId,'The queued batch starts after the first one completes');
  assert.equal(f.store.read().jobs.length,2);
});

test('顧客只能刪除自己的上傳角色，已保存的拍攝仍可重試與查看',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await upload(alice,'Delete me')).data;
  const studioCharacter=(await alice.request('/state')).data.characters.find(row=>!row.owned);
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  assert.equal((await bob.request(`/characters/${character.id}`,undefined,'DELETE')).status,404);
  assert.equal((await alice.request(`/characters/${studioCharacter.id}`,undefined,'DELETE')).status,404);
  assert.equal((await alice.request(`/characters/${character.id}`,undefined,'DELETE')).status,200);
  assert(!(await alice.request('/state')).data.characters.some(row=>row.id===character.id));
  assert.equal((await alice.request(`/characters/${character.id}/image`)).status,404);
  const saved=f.store.read().jobs.find(row=>row.id===shoot.data.jobs[0].id);
  assert.equal(saved.character.id,character.id);assert(fs.existsSync(path.join(f.dataDir,'uploads',saved.character.fileName)));
  assert.equal((await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()})).status,400);
});

test('顧客停止與重試只作用於自己的任務，批次含別人的 ID 時整批拒絕',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const a=await alice.request('/shoots',{characterId:character.id,count:2,requestId:randomUUID()}),b=await bob.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  const ids=a.data.jobs.map(row=>row.id),other=b.data.jobs[0].id;
  await new Promise(resolve=>setImmediate(resolve));await f.stageRunner.tick();
  assert.equal((await alice.request('/jobs/stop',{ids:[ids[0],other]})).status,404);
  assert.equal((await bob.request(`/jobs/${ids[0]}/stop`,{})).status,404);
  const before=f.store.read().jobs.find(row=>row.id===other);
  const stop=await alice.request('/jobs/stop',{ids});assert.equal(stop.status,200);
  assert(stop.data.results.every(row=>row.ok && row.status==='stopped'));
  const stopped=(await alice.request('/state')).data.jobs;assert(stopped.every(row=>row.canRetry && !row.active));
  assert.deepEqual(f.store.read().jobs.find(row=>row.id===other),before);
  assert.equal((await bob.request('/jobs/retry',{ids})).status,404);
  assert.equal((await alice.request('/jobs/retry',{ids})).status,202);
  assert.equal((await alice.request('/jobs/retry',{ids})).status,409);
  assert(f.store.read().jobs.filter(row=>ids.includes(row.id)).every(row=>!row.stopRequestedAt && row.status!=='stopped'));
});

test('停止未確認時不能重開，顧客回應不洩漏上游主機與工作流資訊',async t=>{
  const f=await fixture(t),alice=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const a=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),id=a.data.jobs[0].id;
  for(let attempt=0;attempt<10 && !f.store.read().jobs.find(row=>row.id===id).promptId;attempt++) await new Promise(resolve=>setImmediate(resolve));
  f.setCancelError(true);
  const stop=await alice.request(`/jobs/${id}/stop`,{});assert.equal(stop.status,200);assert.equal(stop.data.results[0].ok,false);
  assert(!JSON.stringify(stop.data).includes('127.0.0.1:8188'));assert(!JSON.stringify(stop.data).includes('ComfyUI'));
  const job=(await alice.request('/state')).data.jobs[0];assert.equal(job.status,'uncertain');assert.equal(job.canRetry,false);assert.equal(job.canStop,true);
  assert.equal((await alice.request(`/jobs/${id}/retry`,{})).status,409);
  f.setCancelError(false);assert.equal((await alice.request(`/jobs/${id}/stop`,{})).data.results[0].status,'stopped');
  assert.equal((await alice.request(`/jobs/${id}/retry`,{})).status,202);
});

test('本人能查看照片實際提詞，其他訪客無法查看',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const character=(await alice.request('/state')).data.characters[0];
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,cameraEnabled:true,requestId:randomUUID()});
  const id=shoot.data.jobs[0].id;
  f.store.mutate(state=>{
    const job=state.jobs.find(row=>row.id===id);job.camera.angle={horizontalAngle:90,verticalAngle:0,zoom:5};
    job.prompt='Actual submitted portrait prompt';job.negative='Actual submitted negative prompt';
    job.stageResults=Object.fromEntries(['base','angle','refine'].map(stage=>[stage,{completed:true,images:[{filename:stage+'.png',type:'output'}],apiPrompt:buildCameraStage(TEMPLATE,CAMERA_TEMPLATE,job,stage,{character:'person.png',garment:'outfit.png',source:'original.png'})}]));
    job.prompt='Planning text changed after submission';job.status='completed';job.images=[{filename:'final.png',type:'output'}];
  });
  const details=await alice.request(`/jobs/${id}/prompts`);assert.equal(details.status,200);
  const [base,angle,refine]=details.data.stages;
  const submittedBase=f.store.read().jobs.find(row=>row.id===id).stageResults.base.apiPrompt['12'].inputs;
  assert.equal(base.positive,submittedBase.prompt);assert.equal(base.negative,submittedBase.negative_prompt);
  assert.match(base.positive,/^Actual submitted portrait prompt\n\n/);assert.match(base.positive,/exactly ONE person/);
  assert.match(base.negative,/^Actual submitted negative prompt, /);assert.equal(angle.negative,SINGLE_SUBJECT_NEGATIVE);
  assert.equal(angle.positive,withSingleSubjectPrompt(cameraPrompt({horizontalAngle:90,verticalAngle:0,zoom:5})));
  assert.equal(refine.positive,REFINE_PROMPT);assert.equal(refine.negative,REFINE_NEGATIVE);
  assert.equal(base.source,'snapshot');assert.equal(angle.settings.seed,base.settings.seed+1);assert.equal(refine.settings.seed,base.settings.seed+2);
  assert.match(base.image,/\?stage=base$/);assert.match(angle.image,/\?stage=angle$/);assert.match(refine.image,/\/image\/0$/);
  assert.deepEqual(base.references.map(row=>row.label),['<image1>','<image2>']);
  for(const field of ['workflowSnapshot','apiPrompt','comfyUrl','visitorId','fileName','safetensors']) assert.ok(!JSON.stringify(details.data).includes(field),field);
  assert.equal((await bob.request(`/jobs/${id}/prompts`)).status,404);
});

test('本人可將照片移到回收區並還原，其他訪客不能刪除或還原',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const character=(await alice.request('/state')).data.characters[0];
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  const id=shoot.data.jobs[0].id;
  assert.equal((await alice.request(`/jobs/${id}`,undefined,'DELETE')).status,409,'An active photo cannot be moved out of the production queue');
  f.store.mutate(state=>{const job=state.jobs.find(row=>row.id===id);job.status='completed';job.images=[{filename:'photo.png',type:'output'}];});
  assert.equal((await bob.request(`/jobs/${id}`,undefined,'DELETE')).status,404);
  assert.equal((await alice.request(`/jobs/${id}`,undefined,'DELETE')).status,200);
  assert.equal((await alice.request('/state')).data.jobs.length,0);
  assert.ok((await alice.request('/state')).data.trash.some(row=>row.id===id));
  assert.ok(f.store.read().jobs.find(row=>row.id===id).images.length,'Moving to trash preserves output files and snapshots for recovery');
  assert.equal((await alice.request(`/jobs/${id}/remake`,{requestId:randomUUID()})).status,404);
  assert.equal((await bob.request(`/jobs/${id}/restore`,{})).status,404);
  assert.equal((await alice.request(`/jobs/${id}/restore`,{})).status,200);
  assert.equal((await alice.request('/state')).data.jobs.length,1);
});

test('整張照片的版本可一起移到回收區；還原不影響其他訪客與單張刪除',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const a=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),b=await bob.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  const id=a.data.jobs[0].id,versionId=randomUUID();
  f.store.mutate(state=>{const original=state.jobs.find(row=>row.id===id);original.status='completed';original.images=[{filename:'original.png',type:'output'}];state.jobs.push({...structuredClone(original),id:versionId,rootJobId:id,remakeVersion:1});});
  assert.equal((await alice.request(`/jobs/${id}`,{allVersions:true},'DELETE')).status,200);
  assert.equal((await alice.request('/state')).data.jobs.length,0);assert.equal((await alice.request('/state')).data.trash.length,2);
  assert.equal((await bob.request('/state')).data.jobs[0].id,b.data.jobs[0].id);assert.equal((await bob.request('/state')).data.trash.length,0);
  assert.equal((await alice.request(`/jobs/${id}/restore`,{allVersions:true})).status,200);assert.equal((await alice.request('/state')).data.jobs.length,2);
  assert.equal((await alice.request(`/jobs/${versionId}`,undefined,'DELETE')).status,200);assert.equal((await alice.request('/state')).data.jobs[0].id,id);
});

test('批次刪除整張照片與版本；所有權與執行中驗證失敗時整批保留',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const a=await alice.request('/shoots',{characterId:character.id,count:2,requestId:randomUUID()}),b=await bob.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  const ids=a.data.jobs.map(job=>job.id),other=b.data.jobs[0].id,versionId=randomUUID();
  await alice.request('/jobs/stop',{ids});await bob.request('/jobs/stop',{ids:[other]});
  f.store.mutate(state=>{
    const original=state.jobs.find(job=>job.id===ids[0]);
    state.jobs.push({...structuredClone(original),id:versionId,rootJobId:original.id,remakeVersion:1,status:'running'});
  });
  assert.equal((await alice.request('/photos/delete',{ids:[ids[0],other]})).status,404);
  assert.equal((await alice.request('/photos/delete',{ids})).status,409);
  assert.equal((await alice.request('/state')).data.trash.length,0);
  f.store.mutate(state=>{state.jobs.find(job=>job.id===versionId).status='stopped';});
  const deleted=await alice.request('/photos/delete',{ids:[...ids,ids[0]]});assert.equal(deleted.status,200);assert.equal(deleted.data.count,3);
  const state=(await alice.request('/state')).data;assert.equal(state.jobs.length,0);assert.equal(state.trash.length,3);
  assert.equal((await bob.request('/state')).data.jobs[0].id,other);
  assert.equal((await alice.request(`/jobs/${ids[0]}/restore`,{allVersions:true})).status,200);
  assert.equal((await alice.request('/state')).data.jobs.length,2);
});

test('回收區批次永久刪除僅刪除自己的回收版本，保留其他照片引用的檔案',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const a=await alice.request('/shoots',{characterId:character.id,count:2,requestId:randomUUID()}),b=await bob.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()});
  const [sourceId,deletedId]=a.data.jobs.map(job=>job.id),other=b.data.jobs[0].id,liveId=randomUUID(),trashVersion=randomUUID();
  await alice.request('/jobs/stop',{ids:[sourceId,deletedId]});await bob.request('/jobs/stop',{ids:[other]});
  const image=filename=>({filename,subfolder:'PhotoCreate/test-output',type:'output'});
  for(const name of ['source.png','source-stage.png','delete.png','delete-stage.png','shared.png','live.png']) fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','test-output',name),PNG);
  f.store.mutate(state=>{
    const source=state.jobs.find(job=>job.id===sourceId),deleted=state.jobs.find(job=>job.id===deletedId),foreign=state.jobs.find(job=>job.id===other);
    Object.assign(source,{status:'completed',images:[image('source.png')],stageResults:{base:{completed:true,images:[image('source-stage.png')]}}});
    Object.assign(deleted,{status:'completed',images:[image('delete.png'),image('shared.png')],stageResults:{base:{completed:true,images:[image('delete-stage.png')]}}});
    Object.assign(foreign,{status:'completed',images:[image('shared.png')]});
    state.jobs.push({...structuredClone(source),id:liveId,rootJobId:sourceId,sourceJobId:sourceId,remakeVersion:1,jobKind:'angle-edit',cameraMode:'multiangle',sourceImage:image('source.png'),sourceInput:'cached-source.png',cameraSource:{image:image('source.png'),stage:'source',jobId:sourceId,seed:source.seed,imageIndex:0},images:[image('live.png')],stageResults:{}});
    state.jobs.push({...structuredClone(deleted),id:trashVersion,rootJobId:deletedId,remakeVersion:1});
  });
  assert.equal((await alice.request('/photos/purge',{ids:[sourceId]})).status,409,'Visible photos cannot be purged');
  await alice.request(`/jobs/${sourceId}`,undefined,'DELETE');await alice.request(`/jobs/${deletedId}`,{allVersions:true},'DELETE');
  const before=structuredClone(f.store.read().jobs);
  assert.equal((await alice.request('/photos/purge',{ids:[sourceId,other]})).status,404);
  assert.deepEqual(f.store.read().jobs,before,'A mixed-owner batch must not delete records or files');
  const purged=await alice.request('/photos/purge',{ids:[sourceId,deletedId]});assert.equal(purged.status,200);assert.equal(purged.data.count,3);assert.equal(purged.data.deletedFiles,3);
  const state=(await alice.request('/state')).data;assert.deepEqual(state.jobs.map(job=>job.id),[liveId]);assert.equal(state.trash.length,0);
  for(const name of ['source.png','shared.png','live.png']) assert(fs.existsSync(path.join(f.outputDir,'PhotoCreate','test-output',name)),name);
  for(const name of ['source-stage.png','delete.png','delete-stage.png']) assert(!fs.existsSync(path.join(f.outputDir,'PhotoCreate','test-output',name)),name);
  for(const id of [sourceId,deletedId,trashVersion]) {
    assert.equal((await alice.request(`/jobs/${id}/image/0`)).status,404);
    assert.equal((await alice.request(`/jobs/${id}/restore`,{})).status,404);
  }
  const prompts=(await alice.request(`/jobs/${liveId}/prompts`)).data;
  assert.equal(prompts.stages[0].image,null);assert.equal(prompts.stages[0].positive,null);assert.match(prompts.stages[0].label,/已永久刪除/);
  assert.equal((await alice.request(`/jobs/${liveId}/angle-source`)).status,200);
  assert.equal((await bob.request('/state')).data.jobs[0].id,other);
  const lastReference=await alice.request(`/jobs/${liveId}`,{permanent:true},'DELETE');assert.equal(lastReference.status,200);assert.equal(lastReference.data.deletedFiles,2);
  assert(!fs.existsSync(path.join(f.outputDir,'PhotoCreate','test-output','source.png')));assert(!fs.existsSync(path.join(f.outputDir,'PhotoCreate','test-output','live.png')));
});

test('永久刪除前先驗證所有輸出路徑，不允許目錄穿越或部分刪除',async t=>{
  const f=await fixture(t),alice=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,requestId:randomUUID()}),id=shoot.data.jobs[0].id;
  await alice.request(`/jobs/${id}/stop`,{});
  const safe=path.join(f.outputDir,'PhotoCreate','test-output','safe.png');fs.writeFileSync(safe,PNG);
  f.store.mutate(state=>{const job=state.jobs.find(row=>row.id===id);job.visitorDeletedAt=new Date().toISOString();job.images=[{filename:'safe.png',subfolder:'PhotoCreate/test-output',type:'output'},{filename:'outside.png',subfolder:'PhotoCreate/../../',type:'output'}];});
  assert.equal((await alice.request('/photos/purge',{ids:[id]})).status,400);
  assert(fs.existsSync(safe));assert(f.store.read().jobs.some(row=>row.id===id && row.visitorDeletedAt));
});

test('套用的顧客候選與提詞獨立保存，管理版測試不改動它，仍使用顧客自己的角色和張數',async t=>{
  const f=await fixture(t),alice=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  f.store.mutate(state=>{state.draft={...structuredClone(DEFAULT_DRAFT),randomPoolMode:'selected',garmentIds:[state.garments[0].id],poseIds:['pose-standing'],cameraIds:['camera-full'],lightingIds:['light-studio'],colorIds:['color-cool'],qualityIds:['quality-editorial'],expressionIds:['expression-smile'],clothingStateIds:['clothing-state-neat'],interactionIds:['interaction-window'],extra:'A neutral studio catalog photograph.',sceneInteraction:'Beside a plain studio backdrop.',steps:27,angleSteps:15,refineDenoise:0.15,resolution:1024};});
  const draft={...f.store.read().draft,mode:'random',randomCount:1,characterId:character.id,aspectRatio:'1:1'},expected=buildShotPlans(f.store.read(),draft)[0];
  const published=await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(draft)});
  assert.equal(published.status,200);
  assert.equal(f.prompts.length,0,'Applying a customer recipe does not generate images');
  f.store.mutate(state=>{state.draft={...draft,mode:'combinations',steps:60,poseIds:['pose-sitting'],extra:'An unpublished test.'};state.presets.find(row=>row.id==='pose-standing').prompt='An unpublished library edit.';state.presets.push({id:'unpublished-pose',category:'pose',name:'Unpublished pose',prompt:'An unpublished pose',tags:[]});});
  const shoot=await alice.request('/shoots',{characterId:character.id,count:1,aspectRatio:'1:1',requestId:randomUUID()});assert.equal(shoot.status,202);
  const actual=f.store.read().jobs.find(row=>row.id===shoot.data.jobs[0].id);
  assert.equal(actual.prompt,expected.prompt);assert.equal(actual.negative,expected.negative);
  for(const key of ['character','garment','pose','camera','lighting','color','quality','expression','clothingState','interaction']) assert.equal(actual[key]?.id,expected[key]?.id,key);
  for(const key of ['steps','angleSteps','refineDenoise','resolution','aspectRatio','cameraMode']) assert.equal(actual[key],expected[key],key);
});

test('兩種管理模式各自保存草稿；未套用與無效設定不覆蓋顧客設定',async t=>{
  const f=await fixture(t);
  await fetch(f.base+'/api/state');
  const before=f.store.read().customerRecipe;
  const combinations={...structuredClone(DEFAULT_DRAFT),mode:'combinations',steps:60},random={...structuredClone(DEFAULT_DRAFT),mode:'random',steps:27};
  const saved=await fetch(f.base+'/api/draft',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({draft:random,modeDrafts:{combinations,random}})});
  assert.equal(saved.status,200);assert.equal(f.store.read().draft.steps,27);
  assert.equal(f.store.read().workbenchDrafts.combinations.steps,60);assert.equal(f.store.read().workbenchDrafts.random.steps,27);
  assert.deepEqual(f.store.read().customerRecipe,before);
  const invalid=await fetch(f.base+'/api/customer-recipe',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...random,steps:0})});
  assert.equal(invalid.status,400);assert.deepEqual(f.store.read().customerRecipe,before);
});

test('兩位訪客的角色與成果隔離；選單只公開官方標題與分類，隱藏工作流與完整提詞',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const initial=await alice.request('/state');assert.equal(initial.status,200);assert.match(alice.sessionHeaders.get('set-cookie'),/HttpOnly; SameSite=Lax/);assert.match(initial.headers.get('cache-control'),/no-store/);
  assert.equal(initial.data.ready,true);assert.equal(initial.data.jobs.length,0);assert.equal(initial.data.settings,undefined);
  assert.ok(initial.data.presets.length>0);
  for(const row of initial.data.presets) assert.deepEqual(Object.keys(row).sort(),['category','groupIds','id','name']);
  const a=await upload(alice,'Alice'),b=await upload(bob,'Bob');assert.equal(a.status,201);assert.equal(b.status,201);
  assert.notEqual(alice.cookie,bob.cookie);
  assert.equal((await alice.request(a.data.image.replace('/api/studio',''))).status,200);
  assert.equal((await bob.request(a.data.image.replace('/api/studio',''))).status,404);
  assert.ok(!(await bob.request('/state')).data.characters.some(row=>row.id===a.data.id));
  assert.equal((await bob.request('/shoots',{characterId:a.data.id,count:1,requestId:randomUUID()})).status,400);
  const body={characterId:a.data.id,count:2,requestId:randomUUID()},shoot=await alice.request('/shoots',body);assert.equal(shoot.status,202);assert.equal(shoot.data.jobs.length,2);
  const again=await alice.request('/shoots',body);assert.equal(again.status,200);assert.equal(again.data.created,false);assert.deepEqual(again.data.jobs.map(row=>row.id),shoot.data.jobs.map(row=>row.id));
  const bs=await bob.request('/shoots',{characterId:b.data.id,count:1,requestId:body.requestId});assert.equal(bs.status,202);
  assert.notEqual(f.store.read().jobs.find(row=>row.id===shoot.data.jobs[0].id).seed,f.store.read().jobs.find(row=>row.id===bs.data.jobs[0].id).seed,'Each customer shoot receives a fresh random seed');
  assert.equal((await alice.request('/state')).data.jobs.length,2);assert.equal((await bob.request('/state')).data.jobs.length,1);
  assert.equal(f.store.read().pipelineRuns.length,2,'Different visitors have separate persisted queue cohorts');
  const id=shoot.data.jobs[0].id;
  f.store.mutate(state=>{const job=state.jobs.find(row=>row.id===id);job.status='completed';job.images=[{filename:'portrait.png',subfolder:'PhotoCreate',type:'output'}];job.stageResults={base:{completed:true,images:[{filename:'original.png',subfolder:'PhotoCreate',type:'output'}]}};});
  assert.equal((await alice.request(`/jobs/${id}/image/0`)).status,200);
  assert.equal((await alice.request(`/jobs/${id}/angle-source`)).status,200);
  for(const route of [`/jobs/${id}/image/0`,`/jobs/${id}/image/0?stage=base`,`/jobs/${id}/angle-source`]) assert.equal((await bob.request(route)).status,404);
  for(const action of ['remake','angle','retry']) assert.equal((await bob.request(`/jobs/${id}/${action}`,{requestId:randomUUID(),angle:{horizontalAngle:90,verticalAngle:0,zoom:4}})).status,404);
  const publicState=JSON.stringify((await alice.request('/state')).data);
  for(const field of ['workflowSnapshot','cameraWorkflowSnapshot','apiPrompt','comfyUrl','visitorId','fileName','prompt_id','safetensors']) assert.ok(!publicState.includes(field),field);
  const stored=f.store.read().jobs.find(row=>row.id===id);assert.equal(stored.character.id,a.data.id);assert.equal(stored.generationMode,'random');assert.equal(stored.cameraMode,'multiangle');assert.ok(stored.garment.id);assert.ok(stored.pose.id);
});

test('本人可重產與換角度，繼承歸屬、保留原圖並防止重複送出',async t=>{
  const f=await fixture(t),alice=f.visitor();const initial=(await alice.request('/state')).data;
  const shoot=await alice.request('/shoots',{characterId:initial.characters[0].id,count:1,requestId:randomUUID()});assert.equal(shoot.status,202);const id=shoot.data.jobs[0].id;
  f.store.mutate(state=>{const job=state.jobs.find(row=>row.id===id);job.status='completed';job.images=[{filename:'photo.png',type:'output'}];job.stageResults={base:{completed:true,images:[{filename:'original.png',type:'output'}]}};});
  const body={requestId:randomUUID()},remake=await alice.request(`/jobs/${id}/remake`,body);assert.equal(remake.status,202);
  assert.equal((await alice.request(`/jobs/${id}/remake`,body)).data.created,false);
  const version=f.store.read().jobs.find(row=>row.id===remake.data.jobs[0].id),original=f.store.read().jobs.find(row=>row.id===id);
  assert.equal(version.visitorId,original.visitorId);assert.equal(version.deleteSourceOnComplete,false);assert.notEqual(version.seed,original.seed);assert.equal(version.character.id,original.character.id);
  f.store.mutate(state=>{state.jobs.find(row=>row.id===version.id).status='stopped';});
  const angleBody={requestId:randomUUID(),angle:{horizontalAngle:90,verticalAngle:-30,zoom:4}},angle=await alice.request(`/jobs/${id}/angle`,angleBody);assert.equal(angle.status,202);
  const angleJob=f.store.read().jobs.find(row=>row.id===angle.data.job.id);assert.equal(angleJob.visitorId,original.visitorId);assert.equal(angleJob.jobKind,'angle-edit');assert.equal(angleJob.cameraEnabled,true);assert.equal(angleJob.sourceImage.filename,'photo.png');assert.equal(angleJob.deleteSourceOnComplete,false);
  assert.equal((await alice.request(`/jobs/${id}/angle`,angleBody)).data.created,false);
  assert.ok(f.store.read().jobs.find(row=>row.id===id).images.length);
});

test('顧客不同角度拍攝使用選取版本，也能選回原圖，預覽與模型輸入一致',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const initial=(await alice.request('/state')).data;
  const finish=async id=>{
    for(let attempt=0;attempt<12 && f.store.read().jobs.find(row=>row.id===id).status!=='completed';attempt++) {
      await new Promise(resolve=>setImmediate(resolve));f.completePending();await f.stageRunner.tick();
    }
    const job=f.store.read().jobs.find(row=>row.id===id);
    assert.equal(job.status,'completed');return job;
  };
  const shoot=await alice.request('/shoots',{characterId:initial.characters[0].id,count:1,cameraEnabled:false,requestId:randomUUID()});
  assert.equal(shoot.status,202);
  const original=await finish(shoot.data.jobs[0].id),originalImage=structuredClone(original.images[0]);
  let sourceId=original.id;
  for(const horizontalAngle of [90,180,0]) {
    if(horizontalAngle===0) sourceId=original.id;
    const selected=f.store.read().jobs.find(row=>row.id===sourceId),selectedImage=structuredClone(selected.images[0]);
    f.views.length=0;
    assert.equal((await alice.request(`/jobs/${sourceId}/angle-source`)).status,200);
    assert.equal(f.views.at(-1).searchParams.get('filename'),selectedImage.filename);
    assert.equal((await bob.request(`/jobs/${sourceId}/angle-source`)).status,404);
    const response=await alice.request(`/jobs/${sourceId}/angle`,{requestId:randomUUID(),angle:{horizontalAngle,verticalAngle:0,zoom:0}});
    assert.equal(response.status,202);
    const edit=await finish(response.data.job.id);
    assert.deepEqual(edit.sourceImage,selectedImage);
    assert.equal(edit.seed,selected.seed,'A camera shot retains the selected photo seed');
    assert.equal(edit.cameraSource.jobId,sourceId);
    assert.equal(edit.sourceJobId,sourceId);
    assert.equal(edit.rootJobId,original.id);
    const anglePrompt=Object.values(edit.stageResults.angle.apiPrompt),input=anglePrompt.find(node=>node.class_type==='LoadImage');
    assert.equal(input.inputs.image,edit.sourceInput);
    assert.ok(f.views.some(view=>view.searchParams.get('filename')===selectedImage.filename),'The upload must use the same selected photo as the preview');
    const details=(await alice.request(`/jobs/${edit.id}/prompts`)).data;
    assert.equal(details.stages[0].label,'拍攝來源');assert.equal(details.stages[0].image,`/api/studio/jobs/${sourceId}/image/0`);
    assert.deepEqual(details.stages[1].angle,{horizontalAngle,verticalAngle:0,zoom:0});
    sourceId=edit.id;
  }
  assert.deepEqual(f.store.read().jobs.find(row=>row.id===original.id).images,[originalImage]);
});

test('未登入不能讀取攝影棚與管理資料，轉送標頭不會取得管理權',async t=>{
  const f=await fixture(t);
  const request=(route,method='GET',body)=>new Promise((resolve,reject)=>{const req=http.request(f.base+route,{method,headers:{Host:'203.0.113.10:8764','content-type':'application/json'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body && JSON.stringify(body));});
  assert.equal(await request('/api/studio/state'),401);assert.equal(await request('/api/health'),200);
  for(const route of ['/api/state','/api/workflow/export','/uploads/person.png']) assert.equal(await request(route),401,route);
  assert.equal(await request('/admin'),302);
  const before=f.store.read();assert.equal(await request('/api/draft','PUT',{steps:99}),401);assert.deepEqual(f.store.read(),before);
  assert.equal(await request('/api/customer-recipe','PUT',{mode:'random',steps:99}),401);assert.deepEqual(f.store.read(),before);
});

test('非法張數、外部角色、未就緒工作流和無效圖片不建立拍攝或上傳記錄',async t=>{
  const f=await fixture(t),alice=f.visitor(),character=(await alice.request('/state')).data.characters[0];
  for(const count of [0,-1,25,1.5,'4']) assert.equal((await alice.request('/shoots',{characterId:character.id,count,requestId:randomUUID()})).status,400);
  assert.equal(f.store.read().jobs.length,0);
  const form=new FormData();form.append('image',new Blob(['not an image'],{type:'image/png'}),'invalid.png');assert.equal((await alice.request('/characters',form)).status,400);
  f.store.mutate(state=>{state.cameraWorkflow=null;});
  assert.equal((await alice.request('/shoots',{characterId:character.id,count:1,cameraEnabled:true,requestId:randomUUID()})).status,503);assert.equal(f.store.read().jobs.length,0);
});

test('訪客自行決定是否跑鏡頭，開關參與去重並驗證型別',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const character=(await alice.request('/state')).data.characters[0];
  const body={characterId:character.id,count:1,requestId:randomUUID()};
  for(const cameraEnabled of ['false',0,1]) assert.equal((await alice.request('/shoots',{...body,cameraEnabled})).status,400);
  const normal=await alice.request('/shoots',body);assert.equal(normal.status,202);
  assert.equal(normal.data.jobs[0].cameraEnabled,false);
  assert.equal((await alice.request('/shoots',body)).data.created,false);
  assert.equal((await alice.request('/shoots',{...body,cameraEnabled:true})).status,409);
  const angled=await bob.request('/shoots',{...body,requestId:randomUUID(),cameraEnabled:true});
  assert.equal(angled.status,202);assert.equal(angled.data.jobs[0].cameraEnabled,true);
});

test('未載入相機工作流時，仍可不勾選鏡頭只生成原圖',async t=>{
  const f=await fixture(t),alice=f.visitor();f.store.mutate(state=>{state.cameraWorkflow=null;});
  const state=(await alice.request('/state')).data;
  assert.equal(state.ready,true);assert.equal(state.cameraReady,false);
  const shoot=await alice.request('/shoots',{characterId:state.characters[0].id,count:1,requestId:randomUUID()});
  assert.equal(shoot.status,202);assert.equal(shoot.data.jobs[0].cameraEnabled,false);
});
