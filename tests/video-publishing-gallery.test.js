import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {videoFixture,videoObjectInfo} from './photo-video-fixture.js';
import {videoUiTemplate,videoTemplate,convertVideoWorkflow} from '../server/video-workflow.js';
import {DEFAULT_VIDEO_PROMPT} from '../shared/photo-video.js';
import {videoEnvironmentFixture} from './video-environment-fixture.js';
import {createEnvironmentManager} from '../server/environment.js';
import {settleInstall} from './environment-fixtures.js';

test('editable workflow and API preserve every node, input and connection, including nested options and 1 Megapixels',()=> {
  const api=videoTemplate(),converted=convertVideoWorkflow(videoUiTemplate(),videoObjectInfo());
  assert.deepEqual(Object.keys(converted).sort(),Object.keys(api).sort());
  for(const [id,node] of Object.entries(api)) {assert.equal(converted[id].class_type,node.class_type);assert.deepEqual(converted[id].inputs,node.inputs,id);}
  assert.equal(api.resolution.inputs.megapixels,1);assert.equal(api.guider.class_type,'BasicGuider');assert.equal(api.sparse.inputs['selection.keep_percent'],10);
  const invalid=videoUiTemplate();invalid.links=invalid.links.filter(link=>link[3]!==invalid.nodes.find(node=>node.type==='BasicGuider').id);invalid.nodes.find(node=>node.type==='BasicGuider').inputs.forEach(input=>{input.link=null;});
  assert.throws(()=>convertVideoWorkflow(invalid,videoObjectInfo()),/缺少必要輸入/);
});

test('video prompt selections reach customers on publish; edits to selected text reach customers immediately and survive restarts',async t=> {
  const f=await videoFixture();t.after(()=>f.close());const alice=await f.customer('publication');f.store.mutate(state=>{state.jobs[0].visitorId=alice.ownerId;});
  const created=await f.request('/photo-videos/prompts',{name:'Upper-body motion',prompt:'Gently sway and slowly frame the upper body.'});assert.equal(created.status,201);
  await f.request('/photo-videos/selection',{selectedPromptIds:[created.data.id]},'PATCH');
  assert.equal((await alice.request('/state')).data.videoSettings.prompts[0].prompt,DEFAULT_VIDEO_PROMPT);
  assert.equal((await alice.request('/jobs/original/video',{requestId:'unpublished-0001',mode:'official',presetId:created.data.id})).status,400);
  await f.request('/photo-videos/publish',{});let published=(await alice.request('/state')).data.videoSettings.prompts;assert.deepEqual(published,[created.data]);
  await f.request('/photo-videos/prompts/'+created.data.id,{name:'Updated motion',prompt:'Wave gently and turn toward the window.'},'PATCH');
  published=[{id:created.data.id,name:'Updated motion',prompt:'Wave gently and turn toward the window.'}];
  assert.deepEqual((await alice.request('/state')).data.videoSettings.prompts,published);
  assert.equal((await alice.request('/jobs/original/video',{requestId:'published-video-0002',mode:'official',presetId:created.data.id})).status,202);
  assert.equal(f.store.read().photoVideos[0].prompt,'Wave gently and turn toward the window.');await f.photoVideos.tick();await f.finish();
  await f.restart();assert.deepEqual((await alice.request('/state')).data.videoSettings.prompts,published);
  await f.request('/photo-videos/selection',{selectedPromptIds:[]},'PATCH');await f.request('/photo-videos/publish',{});
  assert.deepEqual((await alice.request('/state')).data.videoSettings.prompts,[]);
  assert.equal((await alice.request('/jobs/original/video',{requestId:'own-prompt-0003',mode:'custom',prompt:'My own motion.'})).status,202);
});

test('photo and explicitly chosen videos coexist as separate favorites; deleting one video leaves photo and other clips',async t=> {
  const f=await videoFixture();t.after(()=>f.close());const alice=await f.customer('mixed-favorites'),bob=await f.customer('other-favorites');f.store.mutate(state=>{state.jobs[0].visitorId=alice.ownerId;});
  const make=async id=>{const result=await alice.request('/jobs/original/video',{requestId:id,mode:'custom',prompt:'Gentle motion.'});assert.equal(result.status,202);await f.photoVideos.tick();await f.finish();return result.data.video.id;};
  const first=await make('favorite-video-0001'),second=await make('favorite-video-0002');
  const photo=await alice.request('/gallery',{jobId:'original',imageIndex:0});assert.equal(photo.status,201);assert.equal(photo.data.entry.mediaType,'image');assert.equal(photo.data.entry.video,undefined);
  const clip=await alice.request('/gallery',{jobId:'original',imageIndex:0,mediaType:'video',videoId:first});assert.equal(clip.status,201);assert.equal(clip.data.entry.mediaType,'video');assert.equal(clip.data.entry.videoId,first);
  assert.equal((await alice.request('/gallery',{jobId:'original',imageIndex:0,mediaType:'video',videoId:second})).status,201);
  assert.equal((await alice.request('/gallery',{jobId:'original',imageIndex:0})).status,200);
  assert.equal((await bob.request('/gallery',{jobId:'original',imageIndex:0,mediaType:'video',videoId:first})).status,404);
  assert.equal((await alice.request('/gallery',{jobId:'original',imageIndex:1,mediaType:'video',videoId:first})).status,404);
  let entries=(await alice.request('/gallery')).data;assert.equal(entries.length,3);assert.equal(entries.filter(entry=>entry.video).length,2);
  await alice.request('/photo-videos/'+first,undefined,'DELETE');entries=(await alice.request('/gallery')).data;assert.equal(entries.length,2);assert.ok(entries.some(entry=>entry.id===photo.data.entry.id));assert.ok(entries.some(entry=>entry.videoId===second));
});

test('installing the editable workflow retires the exact old API file into a recoverable backup',async t=> {
  const f=videoEnvironmentFixture(),old=Buffer.from('original managed API file'),oldPath='user/default/workflows/PhotoCreate/old.api.json';
  const target=path.join(f.root,oldPath);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,old);
  f.videoManifest.resources[0].retires=[{target:oldPath,sha256:createHash('sha256').update(old).digest('hex')}];
  const manager=createEnvironmentManager(f);t.after(()=>{manager.close();f.cleanup();});
  manager.start(f.root,{purpose:'video',includeModels:false});const job=await settleInstall(manager);assert.equal(job.status,'completed');
  assert.equal(fs.existsSync(target),false);assert.deepEqual(fs.readFileSync(path.join(f.root,'.photocreate-backups',job.id,oldPath)),old);assert.equal(f.controls.videoRequests.length,0);
});
