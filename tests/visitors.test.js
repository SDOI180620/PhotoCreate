import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.js';
import {adminFetch as fetch,login} from './auth-client.js';
import {fixtureState,TEMPLATE,PNG} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';
import {buildCameraStage} from '../server/camera-workflow.js';
import {cameraPrompt,REFINE_PROMPT,REFINE_NEGATIVE} from '../shared/camera.js';
import {SINGLE_SUBJECT_NEGATIVE,withSingleSubjectPrompt} from '../shared/subject.js';
import {DEFAULT_DRAFT} from '../shared/draft.js';
import {buildShotPlans} from '../shared/domain.js';

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
  assert.match(base.positive,/^Actual submitted portrait prompt\n\n/);assert.match(base.positive,/exactly one person/);
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

test('兩位訪客的上傳角色、拍攝、原圖與成果皆隔離，公開資料不包含工作流與提詞',async t=>{
  const f=await fixture(t),alice=f.visitor(),bob=f.visitor();
  const initial=await alice.request('/state');assert.equal(initial.status,200);assert.match(alice.sessionHeaders.get('set-cookie'),/HttpOnly; SameSite=Lax/);assert.match(initial.headers.get('cache-control'),/no-store/);
  assert.equal(initial.data.ready,true);assert.equal(initial.data.jobs.length,0);assert.equal(initial.data.settings,undefined);assert.equal(initial.data.presets,undefined);
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
