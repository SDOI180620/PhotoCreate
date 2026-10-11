import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {createApp} from '../server/index.js';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT,TEMPLATE,fixtureState} from './fixtures.js';
import {login} from './auth-client.js';

async function imageFixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-image-loading-'));
  const outputDir=path.join(dataDir,'output'),folder=path.join(outputDir,'PhotoCreate','loading');
  fs.mkdirSync(folder,{recursive:true});
  const width=1152,height=2048,pixels=Buffer.alloc(width*height*3);let seed=37;
  for(let i=0;i<pixels.length;i++) {seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels[i]=seed&255;}
  const original=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer();
  fs.writeFileSync(path.join(folder,'original.png'),original);
  let upstreamCalls=0;
  const instance=createApp({dataDir,comfyOutputDir:outputDir,fetchImpl:async url=>{
    if(new URL(url).pathname==='/view') {upstreamCalls++;await new Promise(resolve=>setTimeout(resolve,20));return new Response(original,{headers:{'content-type':'image/png'}});}
    return Response.json({});
  }});
  const alice=await instance.authentication.createCustomer({username:'loading-alice',password:'loading-fixture-2026',name:'測試 A'});
  await instance.authentication.createCustomer({username:'loading-bob',password:'loading-fixture-2026',name:'測試 B'});
  const accounts=new DatabaseSync(path.join(dataDir,'accounts.sqlite'),{readOnly:true});
  const ownerId=accounts.prepare('SELECT owner_id FROM accounts WHERE id=?').get(alice.id).owner_id;accounts.close();
  const state=fixtureState(),shot={...buildShotPlans(state,DRAFT)[0],createdAt:'2026-10-11T01:00:00Z'};
  instance.store.mutate(current=>Object.assign(current,state,{workflow:TEMPLATE,customerRecipe:{characterIds:state.characters.map(row=>row.id),settings:{},pools:{garment:state.garments,camera:[],pose:[],lighting:[],color:[],quality:[]}},jobs:[
    {...shot,id:'local-photo',status:'completed',images:[{filename:'original.png',subfolder:'PhotoCreate/loading',type:'output'}]},
    {...shot,id:'remote-photo',status:'completed',visitorId:ownerId,images:[{filename:'remote.png',subfolder:'PhotoCreate/loading',type:'output'}]},
  ]}));
  for(const asset of [...state.characters,...state.garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),original);
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));instance.store.close();
    const target=fs.realpathSync(dataDir),temporaryRoot=fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(target),temporaryRoot);assert.ok(path.basename(target).startsWith('PhotoCreate-image-loading-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  const admin=await login(base),customer=await login(base,'loading-alice','loading-fixture-2026'),other=await login(base,'loading-bob','loading-fixture-2026');
  const request=(route,session=admin,headers={})=>fetch(base+route,{headers:{Cookie:session.cookie,...headers}});
  return {...instance,base,request,admin,customer,other,dataDir,folder,original,state,upstreamCalls:()=>upstreamCalls};
}

test('gallery cards use small uncropped previews; viewer and downloads preserve original bytes',async t=>{
  const f=await imageFixture(t),response=await f.request('/api/jobs/local-photo/image/0?thumbnail=1');
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^image\/webp/);
  const thumbnail=Buffer.from(await response.arrayBuffer()),metadata=await sharp(thumbnail).metadata();
  assert.equal(metadata.width,360);assert.equal(metadata.height,640);assert.ok(thumbnail.length<300000,'A preview is small even when the original is 7 MB');
  assert.equal(f.upstreamCalls(),0,'Local previews do not make ComfyUI read the same original over HTTP');
  for(const suffix of ['', '?download=1&thumbnail=1']) {
    const original=await f.request('/api/jobs/local-photo/image/0'+suffix);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),f.original,'Original viewing and downloads retain every pixel');
  }
  const asset=await f.request(f.state.garments[0].image+'?thumbnail=small');
  assert.equal(asset.status,200);assert.equal((await sharp(Buffer.from(await asset.arrayBuffer())).metadata()).height,160);
});

test('concurrent and repeated customer preview requests share work and validate their private browser cache',async t=>{
  const f=await imageFixture(t),route='/api/studio/jobs/remote-photo/image/0?thumbnail=1';
  const responses=await Promise.all(Array.from({length:12},()=>f.request(route,f.customer)));
  assert.ok(responses.every(row=>row.ok));assert.equal(f.upstreamCalls(),1,'Twelve cards share one engine read and thumbnail conversion');
  const etag=responses[0].headers.get('etag');assert.ok(etag);
  assert.equal(responses[0].headers.get('cache-control'),'private, no-cache');
  const repeated=await f.request(route,f.customer,{'If-None-Match':etag});
  assert.equal(repeated.status,304);assert.equal((await repeated.arrayBuffer()).byteLength,0);assert.equal(f.upstreamCalls(),1);
  const foreign=await f.request(route,f.other,{'If-None-Match':etag});assert.equal(foreign.status,404,'Cached customer previews retain ownership checks');
  f.store.mutate(state=>{state.jobs.find(row=>row.id==='remote-photo').outputsDeletedAt=new Date().toISOString();});
  assert.equal((await f.request(route,f.customer,{'If-None-Match':etag})).status,404,'Deleted images cannot be recovered from the preview cache');
});

test('preview cache follows changed local files and rejects invalid image and thumbnail requests',async t=>{
  const f=await imageFixture(t),route='/api/jobs/local-photo/image/0?thumbnail=1';
  const first=await f.request(route),etag=first.headers.get('etag');await first.arrayBuffer();
  const replacement=await sharp({create:{width:2048,height:1152,channels:3,background:'#244c34'}}).png().toBuffer();
  fs.writeFileSync(path.join(f.folder,'original.png'),replacement);
  const changed=await f.request(route,f.admin,{'If-None-Match':etag});
  assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
  assert.equal((await sharp(Buffer.from(await changed.arrayBuffer())).metadata()).width,640);
  assert.equal((await f.request(route.replace('thumbnail=1','thumbnail=50000'))).status,400);
  assert.equal((await f.request(route+'&stage=invalid')).status,400);
  assert.equal((await f.request('/api/jobs/local-photo/image/99?thumbnail=1')).status,404);
});

test('reading thumbnails does not copy the entire project history for each image',async t=>{
  const f=await imageFixture(t),read=f.store.read;let fullReads=0;
  f.store.read=select=>{if(select===undefined) fullReads++;return read(select);};
  await f.stageRunner.tick(); // Idle background polling can overlap any image request.
  const routes=['/api/jobs/local-photo/image/0?thumbnail=1',f.state.garments[0].image+'?thumbnail=1',`/api/studio/characters/${f.state.characters[0].id}/image?thumbnail=1`];
  for(const route of routes) {const response=await f.request(route,route.startsWith('/api/studio/') ? f.customer : f.admin);assert.equal(response.status,200);await response.arrayBuffer();}
  assert.equal(fullReads,0,'Image loading reads only the requested job, library row and settings');
});

test('opening a large project omits execution graphs while batch export retains complete snapshots',async t=>{
  const f=await imageFixture(t),graph={large:{class_type:'FixtureNode',inputs:{value:'x'.repeat(40000)}}};
  f.store.mutate(state=>{
    const source=state.jobs[0];
    state.jobs=Array.from({length:100},(_,index)=>({...source,id:`history-${index}`,batchId:'history-batch',workflowSnapshot:graph,cameraWorkflowSnapshot:graph,apiPrompt:graph,stageResults:{base:{completed:true,images:source.images,apiPrompt:graph}}}));
    state.jobs.push({...state.jobs[0],id:'private-history',visitorId:'other-owner'});
    state.batches=[{id:'history-batch',name:'歷史拍攝',createdAt:source.createdAt}];
  });
  const before=f.store.read(),response=await f.request('/api/state'),text=await response.text(),state=JSON.parse(text);
  assert.equal(state.jobs.length,100);assert.ok(text.length<500000,'The entry response must not repeat large ComfyUI graphs for every historical photo');
  assert.equal(state.jobs[0].workflowSnapshot,undefined);assert.equal(state.jobs[0].apiPrompt,undefined);
  assert.equal(state.jobs[0].stageResults.base.apiPrompt,undefined);assert.deepEqual(state.jobs[0].images,before.jobs[0].images);
  const exported=await f.request('/api/batches/history-batch/export');assert.equal(exported.status,200);
  const batch=await exported.json();assert.equal(batch.shots.length,100);assert.deepEqual(batch.shots[0].workflowSnapshot,graph);assert.deepEqual(batch.shots[0].stageResults.base.apiPrompt,graph);
  assert.deepEqual(f.store.read(),before,'Lightweight responses never alter saved production snapshots');
});
