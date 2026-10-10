import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.js';
import {createStore} from '../server/store.js';
import {adminFetch,login} from './auth-client.js';
import {DRAFT,fixtureState,TEMPLATE,PNG} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-folders-'));
  const pending=new Set();
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname;
    if(route==='/view') return new Response(PNG,{headers:{'content-type':'image/png'}});
    if(route==='/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id=>[0,id])});
    if(route==='/upload/image') return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
    if(route==='/prompt') {const data=JSON.parse(options.body);pending.add(data.prompt_id);return Response.json({prompt_id:data.prompt_id});}
    return Response.json({});
  };
  const instance=createApp({dataDir,fetchImpl});
  instance.store.mutate(state=>Object.assign(state,fixtureState(),{workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE}));
  for(const asset of [...instance.store.read().characters,...instance.store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const customer=async username=>{
    await instance.authentication.createCustomer({username,password:'test-folder-pass'});
    const {cookie}=await login(base,username,'test-folder-pass');
    return async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
      const response=await globalThis.fetch(base+'/api/studio'+route,{method,headers:{Cookie:cookie,'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
      return {status:response.status,data:await response.json()};
    };
  };
  const admin=async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
    const response=await adminFetch(base+'/api'+route,{method,headers:{'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  const shoot=async(client,folderId='')=>{
    const {characters}= (await client('/state')).data;
    const body={characterId:characters[0].id,count:1,cameraEnabled:false,requestId:randomUUID(),folderId};
    const response=await client('/shoots',body);assert.equal(response.status,202);
    const job=instance.store.read().jobs.find(row=>row.id===response.data.jobs[0].id);
    return {body,job};
  };
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));instance.store.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {...instance,dataDir,base,customer,admin,shoot};
}

test('資料夾依帳號隔離，同名可跨帳號建立，其他帳號不能讀取或修改',async t=>{
  const f=await fixture(t),alice=await f.customer('folder-alice'),bob=await f.customer('folder-bob');
  const a=await alice('/folders',{name:'旅行'}),b=await bob('/folders',{name:'旅行'});
  assert.equal(a.status,201);assert.equal(b.status,201);assert.notEqual(a.data.id,b.data.id);
  assert.deepEqual((await alice('/state')).data.folders.map(row=>row.id),[a.data.id]);
  assert.deepEqual((await bob('/folders')).data.map(row=>row.id),[b.data.id]);
  assert.deepEqual((await f.admin('/photo-folders')).data,[]);
  assert.equal((await alice('/folders',{name:' 旅行 '})).status,409);
  for(const name of ['',null,'a'.repeat(61)]) assert.equal((await alice('/folders',{name})).status,400);
  assert.equal((await bob(`/folders/${a.data.id}`,{name:'他人的資料夾'},'PATCH')).status,404);
  assert.equal((await bob(`/folders/${a.data.id}`,undefined,'DELETE')).status,404);
  assert.equal((await alice(`/folders/${a.data.id}`,{name:'旅遊寫真'},'PATCH')).status,200);
  const reopened=createStore(f.dataDir);
  assert.equal(reopened.read().photoFolders.find(row=>row.id===a.data.id).name,'旅遊寫真');reopened.close();
  assert.ok(!(await alice('/folders')).data.some(row=>Object.hasOwn(row,'ownerId')));
});

test('產圖時可指定資料夾，拍攝去重含目的地，不能指定別人的資料夾',async t=>{
  const f=await fixture(t),alice=await f.customer('shoot-alice'),bob=await f.customer('shoot-bob');
  const folder=(await alice('/folders',{name:'新作品'})).data;
  const {body,job}=await f.shoot(alice,folder.id);
  assert.equal(job.folderId,folder.id);
  assert.equal((await alice('/state')).data.jobs[0].folderId,folder.id);
  assert.equal((await alice('/shoots',body)).data.created,false);
  assert.equal((await alice('/shoots',{...body,folderId:''})).status,409);
  assert.equal((await bob('/shoots',{...body,requestId:randomUUID()})).status,404);
  assert.equal((await bob('/shoots',{...body,folderId:42,requestId:randomUUID()})).status,400);
});

test('移動照片會帶著所有版本；跨帳號混入的要求整批拒絕，管理分類獨立於顧客分類',async t=>{
  const f=await fixture(t),alice=await f.customer('move-alice'),bob=await f.customer('move-bob');
  const folder=(await alice('/folders',{name:'精選'})).data;
  const adminFolder=(await f.admin('/photo-folders',{name:'後台審圖'})).data;
  const a=await f.shoot(alice),b=await f.shoot(bob),versionId=randomUUID();
  f.store.mutate(state=>state.jobs.push({...structuredClone(a.job),id:versionId,rootJobId:a.job.id,remakeVersion:1,visitorDeletedAt:new Date().toISOString()}));
  const before=JSON.stringify(f.store.read().jobs);
  assert.equal((await alice('/photos/move',{ids:[a.job.id,b.job.id],folderId:folder.id})).status,404);
  assert.equal(JSON.stringify(f.store.read().jobs),before);
  assert.equal((await alice('/photos/move',{ids:[versionId],folderId:folder.id})).status,200);
  assert.ok(f.store.read().jobs.filter(row=>[a.job.id,versionId].includes(row.id)).every(row=>row.folderId===folder.id));
  assert.equal((await f.admin('/jobs/move',{ids:[a.job.id],folderId:adminFolder.id})).status,200);
  assert.ok(f.store.read().jobs.filter(row=>[a.job.id,versionId].includes(row.id)).every(row=>row.folderId===folder.id && row.adminFolderId===adminFolder.id));
  assert.equal((await alice('/photos/move',{ids:[a.job.id],folderId:adminFolder.id})).status,404);
  assert.equal((await alice('/photos/move',{ids:[a.job.id],folderId:''})).status,200);
  assert.ok(f.store.read().jobs.filter(row=>[a.job.id,versionId].includes(row.id)).every(row=>!row.folderId && row.adminFolderId===adminFolder.id));
  assert.equal((await alice('/photos/move',{ids:[],folderId:''})).status,400);
});

test('管理員產圖與重製繼承分類；刪除資料夾只回到未分類，原圖與角度來源都保留',async t=>{
  const f=await fixture(t),folder=(await f.admin('/photo-folders',{name:'後台作品'})).data;
  assert.ok(folder.id);
  const created=await f.admin('/jobs',{...DRAFT,folderId:folder.id,cameraMode:'multiangle',cameraEnabled:false});assert.equal(created.status,201);
  const originalId=created.data[0].id;
  const image={filename:'original.png',type:'output'};
  f.store.mutate(state=>{const job=state.jobs.find(row=>row.id===originalId);Object.assign(job,{status:'completed',images:[image],stageResults:{base:{completed:true,images:[image]}}});});
  assert.equal(f.store.read().jobs.find(row=>row.id===originalId).adminFolderId,folder.id);
  const angle=await f.admin(`/jobs/${originalId}/angle`,{requestId:randomUUID(),angle:{horizontalAngle:90,verticalAngle:0,zoom:0},deleteSourceOnComplete:false});assert.equal(angle.status,201);
  assert.equal(angle.data.job.adminFolderId,folder.id);
  const snapshot=structuredClone(f.store.read().jobs);
  assert.equal((await f.admin(`/photo-folders/${folder.id}`,undefined,'DELETE')).status,200);
  const jobs=f.store.read().jobs;
  assert.ok(jobs.every(row=>!row.adminFolderId));
  assert.deepEqual(jobs.map(row=>row.images),snapshot.map(row=>row.images));
  assert.deepEqual(jobs.find(row=>row.id===angle.data.job.id).cameraSource,snapshot.find(row=>row.id===angle.data.job.id).cameraSource);
  assert.equal((await f.admin('/jobs',{...DRAFT,folderId:folder.id})).status,404);
});
