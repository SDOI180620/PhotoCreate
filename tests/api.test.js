import {adminFetch as fetch} from './auth-client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { PNG, TEMPLATE, DRAFT } from './fixtures.js';

test('上傳、批次草稿、兩圖提交、重複提交保護與結果同步',async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-api-'));
  const comfyOutputDir = path.join(dir,'comfy-output');
  fs.mkdirSync(path.join(comfyOutputDir,'PhotoCreate','test'),{recursive:true});
  const submitted = new Map();let lostReply = false;let uploadCount = 0;let rejectPrompt = false;
  const mockFetch = async (url,options = {}) => {
    const endpoint = new URL(url).pathname;
    if(endpoint === '/upload/image') {uploadCount++;return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate',type:'input'});}
    if(endpoint === '/prompt') {
      if(rejectPrompt) return Response.json({error:'mock generation rejected'},{status:400});
      const body = JSON.parse(options.body);submitted.set(body.prompt_id,body);
      if(lostReply) throw new Error('Reply lost');
      return Response.json({prompt_id:body.prompt_id});
    }
    if(endpoint === '/queue') return Response.json({queue_running:[],queue_pending:[...submitted.keys()].map(id => [0,id])});
    if(endpoint.startsWith('/history/')) {
      const id = endpoint.split('/').at(-1);
      if(lostReply) return Response.json({});
      const filename = `${id}.png`;fs.writeFileSync(path.join(comfyOutputDir,'PhotoCreate','test',filename),PNG);
      return Response.json({[id]:{status:{status_str:'success'},outputs:{9:{images:[{filename,type:'output',subfolder:'PhotoCreate/test'}]}}}});
    }
    if(endpoint === '/view') return new Response(PNG,{headers:{'Content-Type':'image/png'}});
    return Response.json({system:{comfyui_version:'test'},devices:[{name:'Mock GPU'}]});
  };
  const {app,store} = createApp({dataDir:dir,fetchImpl:mockFetch,comfyOutputDir});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
  t.after(() => {server.close();store.close();});
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (endpoint,body,method = 'POST') => {
    const response = await fetch(base + endpoint,{method,headers:body instanceof FormData ? {} : {'Content-Type':'application/json'},body:body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const ids = {};
  for(const kind of ['characters','garments','scenes']) {
    const form = new FormData();form.append('images',new Blob([PNG],{type:'image/png'}),`${kind}-測試.png`);
    const result = await request(`/assets/${kind}`,form);assert.equal(result.status,201);ids[kind] = result.data[0].id;
    assert.match(result.data[0].name,/測試/);
  }
  const invalid = new FormData();invalid.append('images',new Blob(['invalid']), 'not-an-image.png');
  assert.equal((await request('/assets/garments',invalid)).status,400);
  assert.equal((await request('/workflow/import',{workflow:TEMPLATE,name:'Qwen test'})).status,200);
  await request(`/assets/garments/${ids.garments}`,{name:'衣服記錄',description:'PRIVATE_CLOTHING_NOTE\n\nONLY_FOR_LIBRARY',tags:[]},'PATCH');
  const draft = {...DRAFT,aspectRatio:'16:9',characterId:ids.characters,garmentIds:[ids.garments],sceneId:ids.scenes,poseIds:['pose-standing'],copies:2};
  const created = await request('/jobs',draft);assert.equal(created.status,201);assert.equal(created.data.length,2);
  assert.ok(created.data.every(job => !job.scene && !/Picture 3|Environment:|測試/.test(job.prompt)));
  assert.ok(created.data.every(job => job.aspectRatio === '16:9' && job.outputWidth === 2048 && job.outputHeight === 1152));
  const exported = await request(`/jobs/${created.data[0].id}/prompt`,undefined,'GET');
  assert.equal(exported.status,200);
  assert.equal(Object.values(exported.data.prompt).filter(node => node.class_type === 'LoadImage').length,2);
  const batchId = created.data[0].batchId;
  assert.ok(batchId);assert.ok(created.data.every(job => job.batchId === batchId));
  assert.equal(store.read().batches.length,1);
  assert.equal((await request(`/batches/${batchId}`,{name:'棚拍第一組'},'PATCH')).status,200);
  assert.equal(store.read().batches[0].name,'棚拍第一組');
  assert.equal((await request(`/batches/${batchId}`,{name:' '},'PATCH')).status,400);
  const jobIds = created.data.map(job => job.id);
  const queued = await request('/jobs/submit',{ids:jobIds});assert.equal(queued.status,200);assert.equal(queued.data.results.length,2);assert.equal(uploadCount,2);
  assert.equal(submitted.size,2);
  const prompt = [...submitted.values()][0].prompt;
  assert.equal(Object.values(prompt).filter(node => node.class_type === 'LoadImage').length,2);
  assert.equal(prompt['12'].inputs['images.image_3'],undefined);
  assert.match(prompt['12'].inputs.prompt,/<image1>.*<image2>/);
  assert.doesNotMatch(prompt['12'].inputs.prompt,/PRIVATE_CLOTHING_NOTE|ONLY_FOR_LIBRARY|Picture 1|Picture 2/);
  assert.equal(store.read().garments[0].description,'PRIVATE_CLOTHING_NOTE\n\nONLY_FOR_LIBRARY');
  const sizeNode = prompt[prompt['7'].inputs.latent_image[0]];
  assert.equal(sizeNode.class_type,'LatentUpscale');assert.equal(sizeNode.inputs.width * 2,2048);assert.equal(sizeNode.inputs.height * 2,1152);
  assert.equal((await request('/jobs/submit',{ids:jobIds})).status,400);assert.equal(submitted.size,2);
  const synced = await request('/jobs/sync');assert.ok(synced.data.every(job => job.status === 'completed'));
  const image = await fetch(`${base}/jobs/${jobIds[0]}/image/0`);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),PNG);
  const original = store.read().jobs.find(job => job.id === jobIds[0]);
  const originalFile = path.join(comfyOutputDir,original.images[0].subfolder,original.images[0].filename);
  const remakeBody = {ids:[original.id],requestId:'api-remake-1',deleteSourceOnComplete:true};
  const remake = await request('/jobs/remake',remakeBody);assert.equal(remake.status,201);
  const replacement = remake.data.jobs[0];
  assert.equal(replacement.batchId,batchId);assert.notEqual(replacement.seed,original.seed);assert.equal(replacement.prompt,original.prompt);
  assert.equal(replacement.aspectRatio,'16:9');assert.equal(replacement.outputWidth,2048);assert.equal(replacement.outputHeight,1152);
  assert.equal(replacement.promptId,undefined);assert.equal(replacement.apiPrompt,undefined);
  const repeated = await request('/jobs/remake',remakeBody);assert.equal(repeated.status,200);assert.equal(repeated.data.jobs[0].id,replacement.id);
  assert.equal((await request('/jobs/remake',{...remakeBody,ids:[jobIds[1]]})).status,409);
  assert.equal((await request('/jobs/remake',{...remakeBody,requestId:'other-remake'})).status,400);
  assert.equal(fs.existsSync(originalFile),true);
  rejectPrompt = true;
  await request('/jobs/submit',{ids:[replacement.id]});
  await request('/jobs/sync');
  assert.equal(store.read().jobs.find(job => job.id === replacement.id).status,'failed');
  assert.equal(fs.existsSync(originalFile),true);assert.equal(store.read().jobs.find(job => job.id === original.id).images.length,1);
  rejectPrompt = false;
  await request('/jobs/submit',{ids:[replacement.id]});await request('/jobs/sync');
  const replaced = store.read().jobs.find(job => job.id === original.id);
  const finished = store.read().jobs.find(job => job.id === replacement.id);
  assert.equal(finished.status,'completed');assert.equal(finished.images.length,1);
  assert.equal(fs.existsSync(originalFile),false);assert.deepEqual(replaced.images,[]);assert.equal(replaced.replacedByJobId,replacement.id);
  assert.equal(replaced.prompt,original.prompt);assert.equal(replaced.promptId,original.promptId);
  assert.equal(finished.apiPrompt['7'].inputs.seed,replacement.seed);
  const newFile = path.join(comfyOutputDir,finished.images[0].subfolder,finished.images[0].filename);
  assert.equal(fs.existsSync(newFile),true);
  assert.equal((await request('/jobs/outputs/delete',{ids:[finished.id]})).status,200);
  assert.equal(fs.existsSync(newFile),false);assert.equal(store.read().jobs.find(job => job.id === finished.id).images.length,0);
  assert.equal((await fetch(`${base}/jobs/${finished.id}/image/0`)).status,404);
  // Lost replies must remain uncertain, then reconcile against the stable ID.
  const interaction = {id:'api-window',category:'interaction',name:'窗邊自然互動',prompt:'Beside a window, resting a hand on the windowsill.',tags:['窗戶']};
  assert.equal((await request('/presets/import',{version:1,presets:[interaction]})).status,200);
  const interactionSearch = await request('/presets/search?category=interaction&q=%E7%AA%97%E9%82%8A',undefined,'GET');
  assert.equal(interactionSearch.status,200);assert.ok(interactionSearch.data.rows.some(row=>row.id===interaction.id));
  const another = await request('/jobs',{...draft,copies:1,interactionId:interaction.id});lostReply = true;
  assert.equal(another.data[0].interaction.prompt,interaction.prompt);
  assert.match(another.data[0].prompt,/Scene: Beside a window/);
  const unknownId = another.data[0].id;
  assert.notEqual(another.data[0].batchId,batchId);assert.equal(store.read().batches.length,2);
  const failed = await request('/jobs/submit',{ids:[unknownId]});assert.equal(failed.data.results[0].ok,false);
  assert.equal(store.read().jobs.find(job => job.id === unknownId).status,'uncertain');
  assert.equal((await request('/jobs/submit',{ids:[unknownId]})).status,400);
  await request('/jobs/sync');assert.equal(store.read().jobs.find(job => job.id === unknownId).status,'queued');
  assert.equal((await request(`/jobs/${unknownId}`,undefined,'DELETE')).status,400);
  const activeBatchId = another.data[0].batchId;
  assert.equal((await request(`/batches/${activeBatchId}`,undefined,'DELETE')).status,400);
  assert.equal(store.read().jobs.length,4);
  assert.equal((await request(`/batches/${batchId}`,undefined,'DELETE')).status,200);
  assert.deepEqual(store.read().jobs.map(job => job.id),[unknownId]);
  assert.deepEqual(store.read().batches.map(batch => batch.id),[activeBatchId]);
  // Random creation uses saved snapshots, and submits only this new group.
  lostReply = false;
  const previousCount = submitted.size;
  const random = await request('/jobs',{...draft,mode:'random',randomCount:30,randomPoolMode:'all',garmentIds:[],poseIds:[],cameraId:'',lightingId:'',colorId:'',qualityId:'',expressionId:'expression-smile',clothingStateId:'clothing-state-folds',interactionId:interaction.id});
  assert.equal(random.status,201);assert.equal(random.data.length,30);
  const randomIds = random.data.map(row=>row.id);
  assert.equal(new Set(random.data.map(row=>row.batchId)).size,1);
  for(const shot of random.data){assert.equal(shot.generationMode,'random');assert.equal(shot.expression,null);assert.equal(shot.clothingState,null);assert.equal(shot.interaction,null);assert.equal(shot.outputWidth,2048);}
  const beforeInvalid = store.read().jobs.length;
  assert.equal((await request('/jobs',{...draft,mode:'random',randomCount:101})).status,400);
  assert.equal(store.read().jobs.length,beforeInvalid);
  const randomSubmitted = await request('/jobs/submit',{ids:randomIds});
  assert.equal(randomSubmitted.status,200);assert(randomSubmitted.data.results.every(row=>row.ok));
  assert.equal(submitted.size,previousCount+30);
  for(const shot of random.data){
    const stored = store.read().jobs.find(row=>row.id===shot.id);
    const apiPrompt = submitted.get(stored.promptId).prompt;
    assert.equal(apiPrompt['12'].inputs.prompt,shot.prompt);
    assert.equal(Object.values(apiPrompt).filter(node=>node.class_type==='LoadImage').length,2);
  }
  await request('/jobs/sync');
  const randomRemake = await request('/jobs/remake',{ids:[randomIds[0]],requestId:'random-api-remake',deleteSourceOnComplete:false});
  assert.equal(randomRemake.status,201);
  const remakeShot = randomRemake.data.jobs[0];
  for(const key of ['prompt','camera','lighting','color','quality','garment','aspectRatio','outputWidth','outputHeight','generationMode']) assert.deepEqual(remakeShot[key],random.data[0][key]);
  const blocked = await fetch(base + '/jobs',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://unrelated.example'},body:JSON.stringify(draft)});assert.equal(blocked.status,403);
});
